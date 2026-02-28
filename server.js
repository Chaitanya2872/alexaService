// server.js - IOtiq Connect ↔ Alexa Smart Home Integration Server
// Architecture: Alexa → Lambda proxy → this server → IOtiq Connect REST APIs
//
// KEY INSIGHT about the IOtiq data model:
//   "devices"   = dongles, IR blasters (hardware hubs) — NOT controllable, skip
//   "switches"  = physical device controllers (e.g. "Elevate 4 Switch Controller") — parent devices
//   "Components" inside each switch = the ACTUAL controllable endpoints (L1, L2, Fan, AC etc.)
//   "scenes"    = automation scenes — expose as SCENE_TRIGGER
//
// For the trigger API:
//   deviceId  = the SWITCH (parent device) UUID
//   utterence = "control switch"
//   params    = { status: "on"/"off", switch_no: "S1" }  (from component metadata)

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');

const homeApi = require('./utils/homeapi');
const { jwtSecret, accessTokenTTL, homeApiBaseUrl } = require('./config/secrets');

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = jwtSecret;
const CODE_TTL_SEC = 600;
const ACCESS_TOKEN_TTL_SEC = accessTokenTTL || 3600;

// ─── OAuth Clients ────────────────────────────────────────────────────────────
const ALEXA_CLIENT_ID = process.env.ALEXA_CLIENT_ID || 'alexa-skill';
const ALEXA_CLIENT_SECRET = process.env.ALEXA_CLIENT_SECRET || 'alexa-client-secret';
const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || 'M8UOFD7R8R1TG';
const ALEXA_REDIRECT_HOSTS = new Set([
  'pitangui.amazon.com',
  'layla.amazon.com',
  'alexa.amazon.co.jp',
  'skills-store.amazon.com',
]);

function parseCsvEnv(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildDefaultAlexaRedirectUris(skillId) {
  if (!skillId) return [];
  return [
    `https://pitangui.amazon.com/api/skill/link/${skillId}`,
    `https://layla.amazon.com/api/skill/link/${skillId}`,
    `https://alexa.amazon.co.jp/api/skill/link/${skillId}`,
    `https://skills-store.amazon.com/api/skill/link/${skillId}`,
  ];
}

function isAlexaRedirectUri(urlValue) {
  try {
    const parsed = new URL(urlValue);
    return (
      ALEXA_REDIRECT_HOSTS.has(parsed.host) &&
      /^\/api\/skill\/link\/[A-Za-z0-9]+$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

const configuredRedirectUris = Array.from(new Set([
  ...parseCsvEnv(process.env.ALEXA_REDIRECT_URIS),
  ...(process.env.ALEXA_REDIRECT_URI ? [process.env.ALEXA_REDIRECT_URI] : []),
  ...buildDefaultAlexaRedirectUris(ALEXA_SKILL_ID),
]));

const clients = {
  [ALEXA_CLIENT_ID]: {
    clientSecret: ALEXA_CLIENT_SECRET,
    redirectUris: configuredRedirectUris,
  },
};

// ─── In-Memory Stores ─────────────────────────────────────────────────────────
const authCodes = {};
const refreshTokens = {};
const homeTokenStore = {};
const OAUTH_STORE_PATH = path.join(__dirname, '.oauth-store.json');

function persistOAuthStore() {
  const data = {
    refreshTokens,
    homeTokenStore,
  };
  try {
    fs.writeFileSync(OAUTH_STORE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[oauth-store] Failed to persist store: ${err.message}`);
  }
}

function loadOAuthStore() {
  try {
    if (!fs.existsSync(OAUTH_STORE_PATH)) return;
    const raw = fs.readFileSync(OAUTH_STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    for (const key of Object.keys(refreshTokens)) delete refreshTokens[key];
    for (const key of Object.keys(homeTokenStore)) delete homeTokenStore[key];

    if (parsed?.refreshTokens && typeof parsed.refreshTokens === 'object') {
      Object.assign(refreshTokens, parsed.refreshTokens);
    }
    if (parsed?.homeTokenStore && typeof parsed.homeTokenStore === 'object') {
      Object.assign(homeTokenStore, parsed.homeTokenStore);
    }

    console.log(`[oauth-store] Loaded refreshTokens=${Object.keys(refreshTokens).length}, users=${Object.keys(homeTokenStore).length}`);
  } catch (err) {
    console.error(`[oauth-store] Failed to load store: ${err.message}`);
  }
}

function upsertRefreshToken(token, value) {
  refreshTokens[token] = value;
  persistOAuthStore();
}

function removeRefreshToken(token) {
  if (!refreshTokens[token]) return;
  delete refreshTokens[token];
  persistOAuthStore();
}

function storeHomeToken(userId, { homeApiToken, accountId, projectId, email, name }) {
  homeTokenStore[userId] = { homeApiToken, accountId, projectId, email, name };
  console.log(`[store] Token stored for ${userId} (project: ${projectId})`);
  persistOAuthStore();
}
function getHomeToken(userId) { return homeTokenStore[userId] || null; }

function recoverHomeTokenFromRefresh(userId) {
  for (const tokenData of Object.values(refreshTokens)) {
    if (tokenData?.userId !== userId || !tokenData?.homeApiToken) continue;

    const recovered = {
      homeApiToken: tokenData.homeApiToken,
      accountId: tokenData.accountId,
      projectId: tokenData.projectId,
    };
    homeTokenStore[userId] = recovered;
    console.log(`[store] Recovered token for ${userId} from refresh token store`);
    persistOAuthStore();
    return recovered;
  }
  return null;
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function isJwtExpired(token, skewSec = 0) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return Math.floor(Date.now() / 1000) >= (payload.exp - skewSec);
}

loadOAuthStore();


// ═══════════════════════════════════════════════════════════════════════════════
//  DEVICE CACHE + COMPONENT MAP
// ═══════════════════════════════════════════════════════════════════════════════
const deviceCache = {};
const CACHE_TTL_MS = 30_000;
const inflightRequests = {};

// Maps componentId -> { parentSwitchId, switchNo, componentType, ... }
// Built during discovery so control commands can look up the parent device
const componentMap = {};

async function getCachedDevices(userId, homeApiToken, projectId) {
  const now = Date.now();
  const cached = deviceCache[userId];
  if (cached && now < cached.expiresAt) return cached.data;
  if (inflightRequests[userId]) return inflightRequests[userId];

  inflightRequests[userId] = homeApi.listDevices(homeApiToken, {}, projectId)
    .then((result) => {
      deviceCache[userId] = { data: result, expiresAt: now + CACHE_TTL_MS };
      delete inflightRequests[userId];
      // Build component map
      buildComponentMap(result.data);
      return result;
    })
    .catch((err) => { delete inflightRequests[userId]; throw err; });

  return inflightRequests[userId];
}

function invalidateCache(userId) { delete deviceCache[userId]; }

/**
 * Build a lookup from componentId -> parent switch info.
 * This is used during control to know which switch deviceId + switch_no to send.
 */
function buildComponentMap(data) {
  if (!data) return;

  // Iterate over BOTH switches AND devices (dongles)
  const allParentDevices = {
    ...(data.switches || {}),
    ...(data.devices || {}),
  };

  for (const [parentId, sw] of Object.entries(allParentDevices)) {
    const components = sw.Components || [];

    // Detect device type: dongle vs switch controller
    const connectionType = (sw.Item?.metadata?.connectionType || '').toLowerCase();
    const itemName = (sw.Item?.name || '').toLowerCase();
    const itemCode = (sw.Item?.itemCode || '').toLowerCase();
    const isDongle = connectionType.includes('dongle') || itemName.includes('dongle') || itemCode.includes('dc');

    for (const comp of components) {
      // Skip components with no metadata (unconfigured slots)
      if (!comp.metadata) continue;

      componentMap[comp.id] = {
        parentSwitchId: parentId,
        switchNo: comp.metadata?.switch_no || `S${comp.componentNumber}`,
        channel: comp.metadata?.channel || null,
        componentNumber: comp.componentNumber,
        componentType: (comp.metadata?.type || 'switch').toLowerCase(),
        deviceName: comp.metadata?.deviceName || comp.name || null,
        parentDeviceName: sw.deviceName || sw.Item?.name || null,
        roomName: sw.Segments?.[0]?.name || null,
        floorName: sw.Segments?.[0]?.ParentSegment?.name || null,
        spaceName: sw.Space?.name || null,
        // Control info
        isDongle,
        controlUtterance: isDongle ? 'control dongle' : 'control switch',
      };
    }
  }

  console.log(`[componentMap] Built map for ${Object.keys(componentMap).length} components`);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/login', (req, res) => {
  const continueTo = req.query.continue || '/';
  const error = req.query.error || '';
  res.send(`
    <!DOCTYPE html><html><head><title>IOtiq Connect — Link Account</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f0f4f8;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.1);width:100%;max-width:380px}h2{margin-bottom:.5rem;font-size:1.4rem}p{font-size:.9rem;color:#666;margin-bottom:1.5rem}label{display:block;font-size:.85rem;font-weight:600;color:#333;margin-bottom:.3rem}input{width:100%;padding:.65rem .9rem;border:1px solid #d1d5db;border-radius:8px;font-size:1rem;margin-bottom:1rem}button{width:100%;padding:.75rem;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}.error{color:#dc2626;font-size:.85rem;margin-bottom:1rem;padding:.5rem;background:#fef2f2;border-radius:6px}</style>
    </head><body><div class="card">
    <h2>Link Your Account</h2><p>Sign in with IOtiq Connect to link with Alexa.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="continue" value="${continueTo.replace(/"/g, '&quot;')}" />
      <label>Email</label><input type="email" name="username" required />
      <label>Password</label><input type="password" name="password" required />
      <button type="submit">Sign In &amp; Link</button>
    </form></div></body></html>
  `);
});

app.post('/login', async (req, res) => {
  const { username, password, continue: cont } = req.body;
  console.log(`[LOGIN] ${username}`);
  try {
    const result = await homeApi.loginToHomeApi(username, password);
    const acct = result.data;
    const token = result.token;
    storeHomeToken(acct.id, { homeApiToken: token, accountId: acct.id, projectId: acct.projectId || acct.activeProjectId, email: acct.email, name: acct.name });
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
    res.cookie('userId', acct.id, {
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect(cont || '/');
  } catch (err) {
    console.error(`[LOGIN] Failed: ${err.message}`);
    const msg = encodeURIComponent(err.responseData?.message || 'Invalid credentials');
    res.redirect(`/login?error=${msg}&continue=${encodeURIComponent(cont || '/')}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  OAUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;
  if (response_type !== 'code') return res.status(400).send('response_type must be "code"');
  const client = clients[client_id];
  if (!client) return res.status(400).send(`Unknown client_id`);
  const redirectAllowed = client.redirectUris.includes(redirect_uri) || isAlexaRedirectUri(redirect_uri);
  if (!redirectAllowed) {
    console.error(`[AUTHORIZE] Invalid redirect_uri for client "${client_id}": ${redirect_uri}`);
    console.error(`[AUTHORIZE] Configured redirectUris: ${client.redirectUris.join(', ')}`);
    return res.status(400).send('Invalid redirect_uri');
  }

  if (!req.cookies.userId) {
    return res.redirect(`/login?continue=${encodeURIComponent(`/authorize?${querystring.stringify(req.query)}`)}`);
  }

  const userId = req.cookies.userId;
  let stored = getHomeToken(userId);
  if (!stored?.homeApiToken) {
    stored = recoverHomeTokenFromRefresh(userId);
  }

  if (!stored?.homeApiToken || isJwtExpired(stored.homeApiToken, 60)) {
    console.warn(`[AUTHORIZE] Missing/expired Home token for ${userId}; forcing re-login`);
    res.clearCookie('userId');
    return res.redirect(`/login?continue=${encodeURIComponent(`/authorize?${querystring.stringify(req.query)}`)}`);
  }

  const code = uuidv4();
  authCodes[code] = { clientId: client_id, redirectUri: redirect_uri, userId, scope, expiresAt: Date.now() + CODE_TTL_SEC * 1000,
    homeApiToken: stored?.homeApiToken, accountId: stored?.accountId, projectId: stored?.projectId };

  console.log(`[AUTHORIZE] Code for ${userId}: ${code}`);
  const redir = new URL(redirect_uri);
  redir.searchParams.set('code', code);
  if (state) redir.searchParams.set('state', state);
  res.redirect(redir.toString());
});

app.post('/token', (req, res) => {
  const { grant_type } = req.body;
  let clientId, clientSecret;
  if (req.headers.authorization?.startsWith('Basic ')) {
    [clientId, clientSecret] = Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':');
  } else { clientId = req.body.client_id; clientSecret = req.body.client_secret; }

  const client = clients[clientId];
  if (!client || client.clientSecret !== clientSecret) {
    console.error(`[TOKEN] invalid_client for client_id=${clientId || 'missing'}`);
    return res.status(401).json({ error: 'invalid_client' });
  }
  console.log(`[TOKEN] request grant_type=${grant_type} client_id=${clientId}`);

  if (grant_type === 'authorization_code') {
    const stored = authCodes[req.body.code];
    if (!stored || stored.clientId !== clientId) {
      console.error(`[TOKEN] invalid_grant authorization_code: code missing/mismatch for client_id=${clientId}`);
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (Date.now() > stored.expiresAt) {
      delete authCodes[req.body.code];
      console.error(`[TOKEN] invalid_grant authorization_code: code expired for user=${stored.userId}`);
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const accessToken = jwt.sign({ sub: stored.userId, scope: stored.scope, client_id: clientId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SEC });
    const refreshToken = uuidv4();
    upsertRefreshToken(refreshToken, {
      userId: stored.userId,
      clientId,
      scope: stored.scope,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      homeApiToken: stored.homeApiToken,
      accountId: stored.accountId,
      projectId: stored.projectId,
    });

    if (stored.homeApiToken) storeHomeToken(stored.userId, { homeApiToken: stored.homeApiToken, accountId: stored.accountId, projectId: stored.projectId });
    delete authCodes[req.body.code];
    console.log(`[TOKEN] authorization_code success user=${stored.userId}`);

    return res.json({ access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token: refreshToken });
  }

  if (grant_type === 'refresh_token') {
    const stored = refreshTokens[req.body.refresh_token];
    if (!stored || stored.clientId !== clientId) {
      console.error(`[TOKEN] invalid_grant refresh_token: token missing/mismatch for client_id=${clientId}`);
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (Date.now() > stored.expiresAt) {
      removeRefreshToken(req.body.refresh_token);
      console.error(`[TOKEN] invalid_grant refresh_token: token expired for user=${stored.userId}`);
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const accessToken = jwt.sign({ sub: stored.userId, scope: stored.scope, client_id: clientId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL_SEC });
    if (stored.homeApiToken) storeHomeToken(stored.userId, { homeApiToken: stored.homeApiToken, accountId: stored.accountId, projectId: stored.projectId });
    console.log(`[TOKEN] refresh_token success user=${stored.userId}`);
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: req.body.refresh_token,
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

app.get('/userinfo', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'invalid_token' });
  try {
    const p = jwt.verify(auth.slice(7), JWT_SECRET);
    const s = getHomeToken(p.sub);
    return res.json({ sub: p.sub, email: s?.email, name: s?.name });
  } catch { return res.status(401).json({ error: 'invalid_token' }); }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  ALEXA SMART HOME ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/alexa/smart-home', async (req, res) => {
  const request = req.body;
  try {
    const namespace = request?.directive?.header?.namespace;
    const name = request?.directive?.header?.name;
    console.log(`[ALEXA] ${namespace}.${name}`);

    // ── AcceptGrant ─────────────────────────────────────────────────────────
    if (namespace === 'Alexa.Authorization' && name === 'AcceptGrant') {
      return res.json({ event: { header: { namespace: 'Alexa.Authorization', name: 'AcceptGrant.Response', payloadVersion: '3', messageId: uuidv4() }, payload: {} } });
    }

    // ── Discovery ───────────────────────────────────────────────────────────
    if (namespace === 'Alexa.Discovery' && name === 'Discover') {
      const token = request?.directive?.payload?.scope?.token;
      const { userId, stored } = resolveUser(token);
      if (!stored?.homeApiToken) return res.json(buildError('EXPIRED_AUTHORIZATION_CREDENTIAL', 'Not linked'));

      console.log(`[ALEXA] Discovery for user ${userId}`);
      const spacesData = await getCachedDevices(userId, stored.homeApiToken, stored.projectId);
      const endpoints = buildAlexaEndpoints(spacesData.data);
      console.log(`[ALEXA] Discovered ${endpoints.length} endpoints`);

      return res.json({ event: { header: { namespace: 'Alexa.Discovery', name: 'Discover.Response', payloadVersion: '3', messageId: uuidv4() }, payload: { endpoints } } });
    }

    // ── All other directives ────────────────────────────────────────────────
    const token = request?.directive?.endpoint?.scope?.token;
    const endpointId = request?.directive?.endpoint?.endpointId;
    const correlationToken = request?.directive?.header?.correlationToken;
    const { userId, stored } = resolveUser(token);
    if (!stored?.homeApiToken) return res.json(buildError('EXPIRED_AUTHORIZATION_CREDENTIAL', 'Not linked', correlationToken));

    const { homeApiToken, projectId } = stored;

    // Ensure component map is populated
    if (Object.keys(componentMap).length === 0) {
      await getCachedDevices(userId, homeApiToken, projectId);
    }

    // ── SceneController ─────────────────────────────────────────────────────
    if (namespace === 'Alexa.SceneController') {
      const utterance = name === 'Activate' ? 'turn on' : 'turn off';
      console.log(`[ALEXA] Scene: ${utterance} ${endpointId}`);
      try {
        await homeApi.controlDevice(homeApiToken, endpointId, utterance, {}, projectId);
      } catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }

      return res.json({
        context: {},
        event: { header: { namespace: 'Alexa.SceneController', name: name === 'Activate' ? 'ActivationStarted' : 'DeactivationStarted', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId }, payload: { cause: { type: 'VOICE_INTERACTION' }, timestamp: new Date().toISOString() } },
      });
    }

    // ── PowerController ─────────────────────────────────────────────────────
    if (namespace === 'Alexa.PowerController') {
      const onOff = name === 'TurnOn' ? 'on' : 'off';
      const comp = componentMap[endpointId];

      if (comp) {
        // This is a component — use the correct utterance based on device type
        const params = { status: onOff, switch_no: comp.switchNo };
        if (comp.channel) {
          params.channel = comp.channel;
        }
        console.log(`[ALEXA] Power: ${onOff} component ${endpointId} (parent: ${comp.parentSwitchId}, ${comp.switchNo}, ch: ${comp.channel || 'none'}, utterance: ${comp.controlUtterance})`);
        try {
          await homeApi.controlDevice(homeApiToken, comp.parentSwitchId, comp.controlUtterance, params, projectId);
          invalidateCache(userId);
        } catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }
      } else {
        // Might be a direct switch or unknown — try direct utterance
        console.log(`[ALEXA] Power: ${onOff} device ${endpointId} (direct)`);
        try {
          await homeApi.controlDevice(homeApiToken, endpointId, `turn ${onOff}`, {}, projectId);
          invalidateCache(userId);
        } catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }
      }

      return res.json({
        context: { properties: [{ namespace: 'Alexa.PowerController', name: 'powerState', value: onOff === 'on' ? 'ON' : 'OFF', timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── BrightnessController ────────────────────────────────────────────────
    if (namespace === 'Alexa.BrightnessController') {
      const brightness = request.directive.payload.brightness ?? request.directive.payload.brightnessDelta;
      const comp = componentMap[endpointId];
      const utterance = name === 'SetBrightness' ? `set brightness to ${brightness}%` : `adjust brightness by ${brightness}%`;
      console.log(`[ALEXA] Brightness: ${utterance} on ${endpointId}`);

      try {
        if (comp) {
          const params = { status: `${brightness}`, switch_no: comp.switchNo };
          if (comp.channel) params.channel = comp.channel;
          await homeApi.controlDevice(homeApiToken, comp.parentSwitchId, comp.controlUtterance, params, projectId);
        } else {
          await homeApi.controlDevice(homeApiToken, endpointId, utterance, {}, projectId);
        }
        invalidateCache(userId);
      } catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }

      return res.json({
        context: { properties: [{ namespace: 'Alexa.BrightnessController', name: 'brightness', value: brightness, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── PowerLevelController (fans) ─────────────────────────────────────────
    if (namespace === 'Alexa.PowerLevelController') {
      const level = request.directive.payload.powerLevel ?? request.directive.payload.powerLevelDelta;
      const comp = componentMap[endpointId];
      console.log(`[ALEXA] PowerLevel: ${level} on ${endpointId}`);

      try {
        if (comp) {
          const params = { status: `${level}`, switch_no: comp.switchNo };
          if (comp.channel) params.channel = comp.channel;
          await homeApi.controlDevice(homeApiToken, comp.parentSwitchId, comp.controlUtterance, params, projectId);
        } else {
          await homeApi.controlDevice(homeApiToken, endpointId, `set to ${level}%`, {}, projectId);
        }
        invalidateCache(userId);
      } catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }

      return res.json({
        context: { properties: [{ namespace: 'Alexa.PowerLevelController', name: 'powerLevel', value: level, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── PercentageController ────────────────────────────────────────────────
    if (namespace === 'Alexa.PercentageController') {
      const pct = request.directive.payload.percentage ?? request.directive.payload.percentageDelta;
      const comp = componentMap[endpointId];
      console.log(`[ALEXA] Percentage: ${pct}% on ${endpointId}`);

      try {
        if (comp) {
          const params = { status: `${pct}`, switch_no: comp.switchNo };
          if (comp.channel) params.channel = comp.channel;
          await homeApi.controlDevice(homeApiToken, comp.parentSwitchId, comp.controlUtterance, params, projectId);
        } else {
          await homeApi.controlDevice(homeApiToken, endpointId, `set to ${pct}%`, {}, projectId);
        }
        invalidateCache(userId);
      } catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }

      return res.json({
        context: { properties: [{ namespace: 'Alexa.PercentageController', name: 'percentage', value: pct, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── ThermostatController ────────────────────────────────────────────────
    if (namespace === 'Alexa.ThermostatController') {
      let temp, utterance;
      if (name === 'SetTargetTemperature') { temp = request.directive.payload.targetSetpoint.value; utterance = `set temperature to ${temp}`; }
      else if (name === 'AdjustTargetTemperature') { temp = request.directive.payload.targetSetpointDelta.value; utterance = `adjust temperature by ${temp}`; }
      else if (name === 'SetThermostatMode') {
        const mode = request.directive.payload.thermostatMode.value;
        try { await homeApi.controlDevice(homeApiToken, endpointId, `set mode to ${mode}`, { mode }, projectId); invalidateCache(userId); }
        catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }
        return res.json({
          context: { properties: [{ namespace: 'Alexa.ThermostatController', name: 'thermostatMode', value: mode, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
          event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
        });
      }

      console.log(`[ALEXA] Thermostat: ${utterance} on ${endpointId}`);
      try { await homeApi.controlDevice(homeApiToken, endpointId, utterance, { temperature: temp }, projectId); invalidateCache(userId); }
      catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }

      return res.json({
        context: { properties: [
          { namespace: 'Alexa.ThermostatController', name: 'targetSetpoint', value: { value: temp, scale: 'CELSIUS' }, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 },
          { namespace: 'Alexa.TemperatureSensor', name: 'temperature', value: { value: temp, scale: 'CELSIUS' }, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 1000 },
        ] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── ColorController ─────────────────────────────────────────────────────
    if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
      const { hue, saturation, brightness } = request.directive.payload.color;
      console.log(`[ALEXA] Color: h=${hue} s=${saturation} b=${brightness} on ${endpointId}`);
      try { await homeApi.controlDevice(homeApiToken, endpointId, `set color hue ${hue} saturation ${saturation} brightness ${brightness}`, { hue, saturation, brightness }, projectId); invalidateCache(userId); }
      catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }
      return res.json({
        context: { properties: [{ namespace: 'Alexa.ColorController', name: 'color', value: { hue, saturation, brightness }, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── ColorTemperatureController ──────────────────────────────────────────
    if (namespace === 'Alexa.ColorTemperatureController') {
      let kelvin, utterance;
      if (name === 'SetColorTemperature') { kelvin = request.directive.payload.colorTemperatureInKelvin; utterance = `set color temperature to ${kelvin}`; }
      else if (name === 'IncreaseColorTemperature') { utterance = 'set warm white'; kelvin = 4000; }
      else if (name === 'DecreaseColorTemperature') { utterance = 'set cool white'; kelvin = 7000; }
      console.log(`[ALEXA] ColorTemp: ${utterance} on ${endpointId}`);
      try { await homeApi.controlDevice(homeApiToken, endpointId, utterance, {}, projectId); invalidateCache(userId); }
      catch (err) { logControlError(err); return res.json(buildError('ENDPOINT_UNREACHABLE', err.message, correlationToken)); }
      return res.json({
        context: { properties: [{ namespace: 'Alexa.ColorTemperatureController', name: 'colorTemperatureInKelvin', value: kelvin, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 500 }] },
        event: { header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken }, endpoint: { endpointId }, payload: {} },
      });
    }

    // ── ReportState ─────────────────────────────────────────────────────────
    if (namespace === 'Alexa' && name === 'ReportState') {
      let properties = [];
      try {
        const spacesData = await getCachedDevices(userId, homeApiToken, projectId);
        properties = getComponentState(endpointId, spacesData.data);
      } catch (err) { console.error(`[ALEXA] ReportState error: ${err.message}`); }

      properties.push({ namespace: 'Alexa.EndpointHealth', name: 'connectivity', value: { value: 'OK' }, timeOfSample: new Date().toISOString(), uncertaintyInMilliseconds: 200 });

      return res.json({
        context: { properties },
        event: { header: { namespace: 'Alexa', name: 'StateReport', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { scope: { type: 'BearerToken', token }, endpointId }, payload: {} },
      });
    }

    console.warn(`[ALEXA] Unhandled: ${namespace}.${name}`);
    return res.json(buildError('INVALID_DIRECTIVE', `Unsupported: ${namespace}.${name}`, correlationToken));

  } catch (err) {
    console.error('[ALEXA] Unexpected:', err.message);
    return res.json(buildError('INTERNAL_ERROR', err.message));
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER: Build Alexa Endpoints from IOtiq Data
// ═══════════════════════════════════════════════════════════════════════════════

function buildAlexaEndpoints(data) {
  const endpoints = [];
  if (!data) return endpoints;

  // ── COMPONENTS are the real Alexa endpoints ─────────────────────────────
  // Iterate over BOTH switches (switch controllers) AND devices (dongles, IR blasters)
  // Both have the same structure: { Components, Item, Segments, ... }
  const allParentDevices = {
    ...(data.switches || {}),
    ...(data.devices || {}),
  };

  for (const [parentId, sw] of Object.entries(allParentDevices)) {
    const components = sw.Components || [];
    const roomName = sw.Segments?.[0]?.name || '';
    const floorName = sw.Segments?.[0]?.ParentSegment?.name || '';

    for (const comp of components) {
      if (comp.isDeleted) continue;
      if (!comp.metadata) continue; // Skip unconfigured component slots

      const compType = (comp.metadata?.type || 'switch').toLowerCase();
      const compDeviceName = comp.metadata?.deviceName || comp.name || '';

      // Build a useful, unique friendly name
      // Priority: room + deviceName > room + type + number > deviceName + number > type + number
      let friendlyName;
      const isGenericName = !compDeviceName || compDeviceName.toLowerCase() === 'switch' || compDeviceName.toLowerCase() === 'light';

      if (!isGenericName && roomName) {
        // Best case: "Kitchen CS Light"
        friendlyName = `${roomName} ${compDeviceName}`;
      } else if (!isGenericName) {
        // No room but has unique name: "CS Light"
        friendlyName = compDeviceName;
      } else if (roomName) {
        // Generic name with room: "Kitchen Light 1" or "Kitchen Switch 2"
        const typeLabel = compType.charAt(0).toUpperCase() + compType.slice(1);
        friendlyName = `${roomName} ${typeLabel} ${comp.componentNumber}`;
      } else {
        // No room, generic name: use parent device name + component number
        const parentName = sw.Item?.name || sw.deviceName || 'Device';
        friendlyName = `${parentName} ${compType} ${comp.componentNumber}`;
      }

      const alexaType = normalizeType(compType);

      endpoints.push({
        endpointId: comp.id,
        manufacturerName: 'IOtiq Connect',
        friendlyName,
        description: `${friendlyName} via IOtiq Connect`,
        displayCategories: getCategories(alexaType),
        cookie: {
          deviceType: alexaType,
          rawType: compType,
          parentSwitchId: parentId,
          switchNo: comp.metadata?.switch_no || `S${comp.componentNumber}`,
          room: roomName,
          floor: floorName,
        },
        capabilities: [
          ...getCapabilities(alexaType),
          { type: 'AlexaInterface', interface: 'Alexa.EndpointHealth', version: '3', properties: { supported: [{ name: 'connectivity' }], proactivelyReported: true, retrievable: true } },
          { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
        ],
      });
    }
  }

  // ── Scenes ──────────────────────────────────────────────────────────────
  const scenes = data.scenes || {};
  for (const [sceneId, scene] of Object.entries(scenes)) {
    endpoints.push({
      endpointId: sceneId,
      manufacturerName: 'IOtiq Connect',
      friendlyName: scene.name || scene.displayName || `Scene ${sceneId.slice(0, 6)}`,
      description: `${scene.name || 'Scene'} via IOtiq Connect`,
      displayCategories: ['SCENE_TRIGGER'],
      cookie: { deviceType: 'scene' },
      capabilities: [
        { type: 'AlexaInterface', interface: 'Alexa.SceneController', version: '3', supportsDeactivation: false, proactivelyReported: true },
        { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
      ],
    });
  }

  return endpoints;
}

/**
 * Get the current state of a component for ReportState.
 * Looks up the parent switch's deviceState for the component's switch_no.
 */
function getComponentState(componentId, data) {
  const properties = [];
  const now = new Date().toISOString();
  const comp = componentMap[componentId];

  if (!comp) return properties;

  // Find the parent in switches OR devices
  const sw = data?.switches?.[comp.parentSwitchId] || data?.devices?.[comp.parentSwitchId];
  if (!sw) return properties;

  // Check component-level state from deviceState
  const compState = sw.deviceState?.[componentId];
  let isOn = false;

  if (compState?.parameterStateStore?.status) {
    const s = compState.parameterStateStore.status;
    isOn = s === '1' || s === 'on' || s === 'ON';
  } else {
    // Fallback to top-level deviceState
    isOn = sw.deviceState?.status === 'on' || sw.deviceState?.status === 'ON';
  }

  properties.push({ namespace: 'Alexa.PowerController', name: 'powerState', value: isOn ? 'ON' : 'OFF', timeOfSample: now, uncertaintyInMilliseconds: 500 });

  return properties;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  TYPE & CAPABILITY MAPS
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeType(t) {
  const map = {
    light: 'light', lamp: 'light', bulb: 'light', led: 'light', tubelight: 'light',
    dimmer: 'dimmer', dimmable: 'dimmer',
    rgb: 'rgb', rgbw: 'rgb',
    fan: 'fan', 'ceiling fan': 'fan', 'exhaust fan': 'fan',
    switch: 'switch', relay: 'switch', socket: 'plug', plug: 'plug', outlet: 'plug',
    curtain: 'curtain', blind: 'curtain', shade: 'curtain',
    thermostat: 'thermostat', ac: 'thermostat', 'air conditioner': 'thermostat',
    tv: 'tv', speaker: 'speaker', lock: 'lock', camera: 'camera',
  };
  return map[t] || 'switch';
}

function getCategories(t) {
  const map = { light: ['LIGHT'], dimmer: ['LIGHT'], rgb: ['LIGHT'], switch: ['SWITCH'], plug: ['SMARTPLUG'], fan: ['FAN'], thermostat: ['THERMOSTAT'], tv: ['TV'], curtain: ['INTERIOR_BLIND'], lock: ['SMARTLOCK'], speaker: ['SPEAKER'], camera: ['CAMERA'] };
  return map[t] || ['SWITCH'];
}

function getCapabilities(t) {
  const power = { type: 'AlexaInterface', interface: 'Alexa.PowerController', version: '3', properties: { supported: [{ name: 'powerState' }], proactivelyReported: true, retrievable: true } };
  const brightness = { type: 'AlexaInterface', interface: 'Alexa.BrightnessController', version: '3', properties: { supported: [{ name: 'brightness' }], proactivelyReported: true, retrievable: true } };
  const color = { type: 'AlexaInterface', interface: 'Alexa.ColorController', version: '3', properties: { supported: [{ name: 'color' }], proactivelyReported: true, retrievable: true } };
  const colorTemp = { type: 'AlexaInterface', interface: 'Alexa.ColorTemperatureController', version: '3', properties: { supported: [{ name: 'colorTemperatureInKelvin' }], proactivelyReported: true, retrievable: true } };
  const powerLevel = { type: 'AlexaInterface', interface: 'Alexa.PowerLevelController', version: '3', properties: { supported: [{ name: 'powerLevel' }], proactivelyReported: true, retrievable: true } };
  const percentage = { type: 'AlexaInterface', interface: 'Alexa.PercentageController', version: '3', properties: { supported: [{ name: 'percentage' }], proactivelyReported: true, retrievable: true } };
  const thermostat = { type: 'AlexaInterface', interface: 'Alexa.ThermostatController', version: '3', properties: { supported: [{ name: 'targetSetpoint' }, { name: 'thermostatMode' }], proactivelyReported: true, retrievable: true }, configuration: { supportedModes: ['HEAT', 'COOL', 'AUTO'], supportsScheduling: false } };
  const tempSensor = { type: 'AlexaInterface', interface: 'Alexa.TemperatureSensor', version: '3', properties: { supported: [{ name: 'temperature' }], proactivelyReported: true, retrievable: true } };

  switch (t) {
    case 'light':      return [power, brightness];
    case 'dimmer':     return [power, brightness, powerLevel, percentage];
    case 'rgb':        return [power, brightness, color, colorTemp];
    case 'fan':        return [power, powerLevel, percentage];
    case 'thermostat': return [power, thermostat, tempSensor];
    case 'curtain':    return [power, percentage];
    case 'tv':         return [power];
    case 'speaker':    return [power];
    case 'lock':       return [power];
    default:           return [power];
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function resolveUser(token) {
  if (!token) return { userId: null, stored: null };
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const cached = getHomeToken(p.sub);
    if (cached?.homeApiToken) return { userId: p.sub, stored: cached };

    const recovered = recoverHomeTokenFromRefresh(p.sub);
    return { userId: p.sub, stored: recovered };
  } catch { return { userId: null, stored: null }; }
}

function buildError(type, message, correlationToken) {
  return { event: { header: { namespace: 'Alexa', name: 'ErrorResponse', payloadVersion: '3', messageId: uuidv4(), ...(correlationToken && { correlationToken }) }, payload: { type, message } } };
}

function logControlError(err) {
  console.error(`[ALEXA] Control error: ${err.message}`);
  if (err.response) {
    console.error(`[ALEXA] Status: ${err.response.status}`);
    console.error(`[ALEXA] Body:`, JSON.stringify(err.response.data, null, 2));
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.send(`<h1>IOtiq Connect Alexa Server</h1><p>Running | API: ${homeApiBaseUrl} | Users: ${Object.keys(homeTokenStore).length}</p>`);
});

app.listen(PORT, () => {
  console.log('══════════════════════════════════════════');
  console.log(` IOtiq Connect — Alexa Integration Server`);
  console.log(`  Port: ${PORT} | Home API: ${homeApiBaseUrl}`);
  console.log(`  OAuth Client ID: ${ALEXA_CLIENT_ID}`);
  console.log(`  Redirect URIs configured: ${configuredRedirectUris.length}`);
  console.log('══════════════════════════════════════════');
});
