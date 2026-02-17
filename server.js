// server.js - Complete OAuth Provider + Alexa Smart Home Skill Backend for IOtiq Connect
// Replaces AWS Lambda — handles OAuth account linking, device discovery, and device control
// by proxying to the IOtiq Connect home-automation API.

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const querystring = require('querystring');
const axios = require('axios');

const homeApi = require('./utils/Homeapi');
const { jwtSecret, accessTokenTTL, refreshTokenTTL, homeApiBaseUrl } = require('./config/secrets');

const app = express();

// ─── Middleware ────────────────────────────────────────────────────────────────
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

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const JWT_SECRET = jwtSecret;
const CODE_TTL_SEC = 600;
const ACCESS_TOKEN_TTL_SEC = accessTokenTTL || 3600;

// ─── Registered OAuth Clients ─────────────────────────────────────────────────
const clients = {
  'alexa-skill': {
    clientSecret: 'alexa-client-secret',
    redirectUris: [
      'https://pitangui.amazon.com/api/skill/link/M8UOFD7R8R1TG',
      'https://layla.amazon.com/api/skill/link/M8UOFD7R8R1TG',
      'https://alexa.amazon.co.jp/api/skill/link/M8UOFD7R8R1TG',
      'https://skills-store.amazon.com/api/skill/link/M8UOFD7R8R1TG',
    ],
  },
};

// ─── In-Memory Stores (replace with DB in production) ─────────────────────────
const authCodes = {};       // code -> { clientId, redirectUri, userId, expiresAt, scope, homeApiToken, accountId, projectId }
const refreshTokens = {};   // refreshToken -> { userId, clientId, scope, expiresAt, homeApiToken, accountId, projectId }
const homeTokenStore = {};  // userId -> { homeApiToken, accountId, projectId, email, name }

// ─── Helper: Store home-API credentials after account linking ─────────────────
function storeHomeToken(userId, { homeApiToken, accountId, projectId, email, name }) {
  homeTokenStore[userId] = { homeApiToken, accountId, projectId, email, name };
  console.log(`[homeTokenStore] Stored token for user ${userId} (account: ${accountId}, project: ${projectId})`);
}

// ─── Helper: Retrieve home-API credentials for a user ─────────────────────────
function getHomeToken(userId) {
  return homeTokenStore[userId] || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LOGIN PAGE (shown during Alexa account linking)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/login', (req, res) => {
  const continueTo = req.query.continue || '/';
  const error = req.query.error || '';
  const continueValue = continueTo.replace(/"/g, '&quot;');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>IOtiq Connect — Link Account</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f4f8; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.1); width: 100%; max-width: 380px; }
        h2 { margin-bottom: .5rem; font-size: 1.4rem; color: #1a1a2e; }
        p  { font-size: .9rem; color: #666; margin-bottom: 1.5rem; }
        label { display: block; font-size: .85rem; font-weight: 600; color: #333; margin-bottom: .3rem; }
        input { width: 100%; padding: .65rem .9rem; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; margin-bottom: 1rem; }
        input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
        button { width: 100%; padding: .75rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
        button:hover { background: #1d4ed8; }
        .error { color: #dc2626; font-size: .85rem; margin-bottom: 1rem; padding: .5rem; background: #fef2f2; border-radius: 6px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Link Your Account</h2>
        <p>Sign in with your IOtiq Connect credentials to link with Alexa.</p>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form method="POST" action="/login">
          <input type="hidden" name="continue" value="${continueValue}" />
          <label for="email">Email</label>
          <input type="email" id="email" name="username" placeholder="you@example.com" required />
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="••••••••" required />
          <button type="submit">Sign In &amp; Link</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  POST /login — Authenticate against IOtiq Connect Home API
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/login', async (req, res) => {
  const { username, password, continue: cont } = req.body;

  console.log(`[LOGIN] Attempting login for: ${username}`);

  let homeAccount = null;
  let homeApiToken = null;

  try {
    // ── Authenticate against the IOtiq Connect Home API ──
    const result = await homeApi.loginToHomeApi(username, password);
    homeAccount = result.data;       // { id, email, name, projectId, activeProjectId, ... }
    homeApiToken = result.token;     // Bearer token extracted from set-cookie or body

    console.log(`[LOGIN] Home API login success. Account ID: ${homeAccount.id}, Token present: ${!!homeApiToken}`);
  } catch (err) {
    console.error(`[LOGIN] Home API login failed: ${err.message}`);
    const errorMsg = encodeURIComponent('Invalid email or password.');
    return res.redirect(`/login?error=${errorMsg}&continue=${encodeURIComponent(cont || '/')}`);
  }

  if (!homeAccount || !homeAccount.id) {
    const errorMsg = encodeURIComponent('Login failed — unexpected response from server.');
    return res.redirect(`/login?error=${errorMsg}&continue=${encodeURIComponent(cont || '/')}`);
  }

  // Store home-API credentials so we can use them for device calls later
  const userId = homeAccount.id;
  storeHomeToken(userId, {
    homeApiToken,
    accountId: homeAccount.id,
    projectId: homeAccount.projectId || homeAccount.activeProjectId,
    email: homeAccount.email,
    name: homeAccount.name,
  });

  // Set session cookie (used by /authorize to know who is logged in)
  res.cookie('userId', userId, { httpOnly: true, secure: false });
  res.redirect(cont || '/');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /authorize — OAuth 2.0 Authorization Endpoint (Alexa account linking)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, state, scope } = req.query;

  console.log('[AUTHORIZE] Request:', JSON.stringify(req.query, null, 2));

  if (response_type !== 'code') {
    return res.status(400).send('response_type must be "code"');
  }

  const client = clients[client_id];
  if (!client) {
    return res.status(400).send(`Unknown client_id: ${client_id}`);
  }

  if (!client.redirectUris.includes(redirect_uri)) {
    console.log('[AUTHORIZE] Invalid redirect_uri:', redirect_uri);
    console.log('[AUTHORIZE] Allowed:', client.redirectUris);
    return res.status(400).send('Invalid redirect_uri');
  }

  // If user not logged in, redirect to login page
  if (!req.cookies.userId) {
    const continueUrl = `/authorize?${querystring.stringify(req.query)}`;
    return res.redirect(`/login?continue=${encodeURIComponent(continueUrl)}`);
  }

  const userId = req.cookies.userId;
  const stored = getHomeToken(userId);

  // Generate authorization code — stash home-API token so /token can retrieve it
  const code = uuidv4();
  authCodes[code] = {
    clientId: client_id,
    redirectUri: redirect_uri,
    userId,
    scope,
    expiresAt: Date.now() + CODE_TTL_SEC * 1000,
    // Carry through home-API credentials
    homeApiToken: stored?.homeApiToken || null,
    accountId: stored?.accountId || null,
    projectId: stored?.projectId || null,
  };

  console.log(`[AUTHORIZE] Code generated for user ${userId}: ${code}`);

  // Redirect back to Alexa with the authorization code
  const redirectTo = new URL(redirect_uri);
  redirectTo.searchParams.set('code', code);
  if (state) redirectTo.searchParams.set('state', state);

  res.redirect(redirectTo.toString());
});

// ═══════════════════════════════════════════════════════════════════════════════
//  POST /token — OAuth 2.0 Token Endpoint
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/token', (req, res) => {
  console.log('[TOKEN] Request body:', JSON.stringify(req.body, null, 2));

  const grant_type = req.body.grant_type;

  if (!grant_type) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'grant_type is required' });
  }

  // ── Extract client credentials (Basic Auth or body) ──
  let clientId, clientSecret;
  if (req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
    const b64 = req.headers.authorization.slice('Basic '.length);
    const [cId, cSecret] = Buffer.from(b64, 'base64').toString().split(':');
    clientId = cId;
    clientSecret = cSecret;
  } else {
    clientId = req.body.client_id;
    clientSecret = req.body.client_secret;
  }

  const client = clients[clientId];
  if (!client || client.clientSecret !== clientSecret) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  // ── Grant Type: authorization_code ──────────────────────────────────────────
  if (grant_type === 'authorization_code') {
    const { code, redirect_uri } = req.body;
    const stored = authCodes[code];

    if (!stored) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code not found or already used' });
    }
    if (stored.clientId !== clientId) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'client mismatch' });
    }
    if (Date.now() > stored.expiresAt) {
      delete authCodes[code];
      return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired' });
    }

    // Issue JWT access token — embed userId so Alexa directives can be resolved
    const accessToken = jwt.sign(
      { sub: stored.userId, scope: stored.scope, client_id: clientId },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL_SEC }
    );

    // Issue opaque refresh token — store home-API credentials alongside it
    const refreshToken = uuidv4();
    refreshTokens[refreshToken] = {
      userId: stored.userId,
      clientId,
      scope: stored.scope,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      homeApiToken: stored.homeApiToken,
      accountId: stored.accountId,
      projectId: stored.projectId,
    };

    // Ensure home token store is populated (in case server restarted between login and token exchange)
    if (stored.homeApiToken) {
      storeHomeToken(stored.userId, {
        homeApiToken: stored.homeApiToken,
        accountId: stored.accountId,
        projectId: stored.projectId,
      });
    }

    // One-time use
    delete authCodes[code];

    console.log(`[TOKEN] Tokens issued for user ${stored.userId}`);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: refreshToken,
      scope: stored.scope,
    });
  }

  // ── Grant Type: refresh_token ───────────────────────────────────────────────
  if (grant_type === 'refresh_token') {
    const refreshToken = req.body.refresh_token;
    const stored = refreshTokens[refreshToken];

    if (!stored || stored.clientId !== clientId) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (Date.now() > stored.expiresAt) {
      delete refreshTokens[refreshToken];
      return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh token expired' });
    }

    const accessToken = jwt.sign(
      { sub: stored.userId, scope: stored.scope, client_id: clientId },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL_SEC }
    );

    // Re-ensure home token store is populated on refresh
    if (stored.homeApiToken) {
      storeHomeToken(stored.userId, {
        homeApiToken: stored.homeApiToken,
        accountId: stored.accountId,
        projectId: stored.projectId,
      });
    }

    console.log(`[TOKEN] Access token refreshed for user ${stored.userId}`);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SEC,
      scope: stored.scope,
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /userinfo — Returns linked user profile
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/userinfo', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  try {
    const payload = jwt.verify(auth.slice('Bearer '.length), JWT_SECRET);
    const stored = getHomeToken(payload.sub);

    return res.json({
      sub: payload.sub,
      user_id: payload.sub,
      email: stored?.email || null,
      name: stored?.name || null,
    });
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//
//  POST /alexa/smart-home — Alexa Smart Home Skill Endpoint (replaces Lambda)
//
//  This single endpoint receives ALL Alexa Smart Home directives:
//    - Alexa.Discovery          → calls IOtiq listDevices API
//    - Alexa.PowerController    → calls IOtiq controlDevice API
//    - Alexa.BrightnessController → calls IOtiq controlDevice API
//    - Alexa.PowerLevelController → calls IOtiq controlDevice API
//    - Alexa.ThermostatController → calls IOtiq controlDevice API
//    - Alexa.Authorization      → AcceptGrant
//    - Alexa (ReportState)      → calls IOtiq listDevices API
//
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/alexa/smart-home', async (req, res) => {
  const request = req.body;

  try {
    console.log('[ALEXA] Directive received:', JSON.stringify(request, null, 2));

    const namespace = request?.directive?.header?.namespace;
    const name = request?.directive?.header?.name;

    // ── AcceptGrant (no token needed) ─────────────────────────────────────────
    if (namespace === 'Alexa.Authorization' && name === 'AcceptGrant') {
      return res.json({
        event: {
          header: {
            namespace: 'Alexa.Authorization',
            name: 'AcceptGrant.Response',
            payloadVersion: '3',
            messageId: uuidv4(),
          },
          payload: {},
        },
      });
    }

    // ── Discovery ─────────────────────────────────────────────────────────────
    if (namespace === 'Alexa.Discovery' && name === 'Discover') {
      const token = request?.directive?.payload?.scope?.token;
      const { userId, stored } = resolveUser(token);

      if (!stored || !stored.homeApiToken) {
        console.error('[ALEXA] Discovery: No home-API token for user', userId);
        return res.json(buildErrorResponse('EXPIRED_AUTHORIZATION_CREDENTIAL', 'Account not linked or token missing'));
      }

      console.log(`[ALEXA] Discovery for user ${userId}`);

      const spacesData = await homeApi.listDevices(stored.homeApiToken, {});
      const endpoints = mapDevicesToAlexaEndpoints(spacesData.data);

      console.log(`[ALEXA] Discovered ${endpoints.length} endpoints`);

      return res.json({
        event: {
          header: {
            namespace: 'Alexa.Discovery',
            name: 'Discover.Response',
            payloadVersion: '3',
            messageId: uuidv4(),
          },
          payload: { endpoints },
        },
      });
    }

    // ── All other directives (control, state report, etc.) ────────────────────
    const token = request?.directive?.endpoint?.scope?.token;
    const endpointId = request?.directive?.endpoint?.endpointId;
    const correlationToken = request?.directive?.header?.correlationToken;
    const { userId, stored } = resolveUser(token);

    if (!stored || !stored.homeApiToken) {
      return res.json(buildErrorResponse('EXPIRED_AUTHORIZATION_CREDENTIAL', 'Account not linked', correlationToken));
    }

    // ── PowerController ───────────────────────────────────────────────────────
    if (namespace === 'Alexa.PowerController') {
      const utterance = name === 'TurnOn' ? 'turn on' : 'turn off';
      const value = name === 'TurnOn' ? 'ON' : 'OFF';

      console.log(`[ALEXA] PowerController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        console.error(`[ALEXA] controlDevice error: ${err.message}`);
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.PowerController',
              name: 'powerState',
              value,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
          ],
        },
        event: {
          header: {
            namespace: 'Alexa',
            name: 'Response',
            payloadVersion: '3',
            messageId: uuidv4(),
            correlationToken,
          },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── BrightnessController ──────────────────────────────────────────────────
    if (namespace === 'Alexa.BrightnessController') {
      let brightnessValue;
      let utterance;

      if (name === 'SetBrightness') {
        brightnessValue = request.directive.payload.brightness;
        utterance = `set brightness to ${brightnessValue}%`;
      } else if (name === 'AdjustBrightness') {
        brightnessValue = request.directive.payload.brightnessDelta;
        utterance = `adjust brightness by ${brightnessValue}%`;
      }

      console.log(`[ALEXA] BrightnessController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.BrightnessController',
              name: 'brightness',
              value: brightnessValue,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
          ],
        },
        event: {
          header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── PowerLevelController (fans, dimmers) ──────────────────────────────────
    if (namespace === 'Alexa.PowerLevelController') {
      let powerLevel;
      let utterance;

      if (name === 'SetPowerLevel') {
        powerLevel = request.directive.payload.powerLevel;
        utterance = `set to ${powerLevel}%`;
      } else if (name === 'AdjustPowerLevel') {
        powerLevel = request.directive.payload.powerLevelDelta;
        utterance = `adjust power by ${powerLevel}%`;
      }

      console.log(`[ALEXA] PowerLevelController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.PowerLevelController',
              name: 'powerLevel',
              value: powerLevel,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
          ],
        },
        event: {
          header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── PercentageController ──────────────────────────────────────────────────
    if (namespace === 'Alexa.PercentageController') {
      let percentage;
      let utterance;

      if (name === 'SetPercentage') {
        percentage = request.directive.payload.percentage;
        utterance = `set to ${percentage}%`;
      } else if (name === 'AdjustPercentage') {
        percentage = request.directive.payload.percentageDelta;
        utterance = `adjust by ${percentage}%`;
      }

      console.log(`[ALEXA] PercentageController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.PercentageController',
              name: 'percentage',
              value: percentage,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
          ],
        },
        event: {
          header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── ThermostatController ──────────────────────────────────────────────────
    if (namespace === 'Alexa.ThermostatController') {
      let temperature;
      let utterance;

      if (name === 'SetTargetTemperature') {
        temperature = request.directive.payload.targetSetpoint.value;
        const scale = request.directive.payload.targetSetpoint.scale || 'CELSIUS';
        utterance = `set temperature to ${temperature}`;
      } else if (name === 'AdjustTargetTemperature') {
        temperature = request.directive.payload.targetSetpointDelta.value;
        utterance = `adjust temperature by ${temperature}`;
      } else if (name === 'SetThermostatMode') {
        const mode = request.directive.payload.thermostatMode.value;
        utterance = `set mode to ${mode}`;

        try {
          await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
        } catch (err) {
          return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
        }

        return res.json({
          context: {
            properties: [
              {
                namespace: 'Alexa.ThermostatController',
                name: 'thermostatMode',
                value: mode,
                timeOfSample: new Date().toISOString(),
                uncertaintyInMilliseconds: 500,
              },
            ],
          },
          event: {
            header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
            endpoint: { endpointId },
            payload: {},
          },
        });
      }

      console.log(`[ALEXA] ThermostatController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.ThermostatController',
              name: 'targetSetpoint',
              value: { value: temperature, scale: 'CELSIUS' },
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
            {
              namespace: 'Alexa.TemperatureSensor',
              name: 'temperature',
              value: { value: temperature, scale: 'CELSIUS' },
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 1000,
            },
          ],
        },
        event: {
          header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── ColorController ───────────────────────────────────────────────────────
    if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
      const { hue, saturation, brightness } = request.directive.payload.color;
      const utterance = `set color hue ${hue} saturation ${saturation} brightness ${brightness}`;

      console.log(`[ALEXA] ColorController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.ColorController',
              name: 'color',
              value: { hue, saturation, brightness },
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
          ],
        },
        event: {
          header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── ColorTemperatureController ────────────────────────────────────────────
    if (namespace === 'Alexa.ColorTemperatureController') {
      let kelvin;
      let utterance;

      if (name === 'SetColorTemperature') {
        kelvin = request.directive.payload.colorTemperatureInKelvin;
        utterance = `set color temperature to ${kelvin}`;
      } else if (name === 'IncreaseColorTemperature') {
        utterance = 'set warm white';
        kelvin = 4000;
      } else if (name === 'DecreaseColorTemperature') {
        utterance = 'set cool white';
        kelvin = 7000;
      }

      console.log(`[ALEXA] ColorTemperatureController: ${utterance} on device ${endpointId}`);

      try {
        await homeApi.controlDevice(stored.homeApiToken, endpointId, utterance);
      } catch (err) {
        return res.json(buildErrorResponse('ENDPOINT_UNREACHABLE', err.message, correlationToken));
      }

      return res.json({
        context: {
          properties: [
            {
              namespace: 'Alexa.ColorTemperatureController',
              name: 'colorTemperatureInKelvin',
              value: kelvin,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 500,
            },
          ],
        },
        event: {
          header: { namespace: 'Alexa', name: 'Response', payloadVersion: '3', messageId: uuidv4(), correlationToken },
          endpoint: { endpointId },
          payload: {},
        },
      });
    }

    // ── ReportState ───────────────────────────────────────────────────────────
    if (namespace === 'Alexa' && name === 'ReportState') {
      console.log(`[ALEXA] ReportState for device ${endpointId}`);

      // Fetch current device state from the home API
      let properties = [];
      try {
        const spacesData = await homeApi.listDevices(stored.homeApiToken, {});
        const device = spacesData.data?.devices?.[endpointId];

        if (device) {
          properties = buildStateProperties(device);
        }
      } catch (err) {
        console.error(`[ALEXA] ReportState error: ${err.message}`);
      }

      // Always include endpoint health
      properties.push({
        namespace: 'Alexa.EndpointHealth',
        name: 'connectivity',
        value: { value: 'OK' },
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 200,
      });

      return res.json({
        context: { properties },
        event: {
          header: {
            namespace: 'Alexa',
            name: 'StateReport',
            payloadVersion: '3',
            messageId: uuidv4(),
            correlationToken,
          },
          endpoint: {
            scope: { type: 'BearerToken', token },
            endpointId,
          },
          payload: {},
        },
      });
    }

    // ── Unhandled namespace ───────────────────────────────────────────────────
    console.warn(`[ALEXA] Unhandled directive: ${namespace}.${name}`);
    return res.json(buildErrorResponse('INVALID_DIRECTIVE', `Unsupported: ${namespace}.${name}`, correlationToken));

  } catch (err) {
    console.error('[ALEXA] Unexpected error:', err);
    return res.json(buildErrorResponse('INTERNAL_ERROR', err.message));
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Resolve a user from the Alexa Bearer token.
 * Returns { userId, stored } where stored contains the home-API credentials.
 */
function resolveUser(token) {
  if (!token) return { userId: null, stored: null };

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.sub;
    const stored = getHomeToken(userId);
    return { userId, stored };
  } catch (err) {
    console.error('[resolveUser] Token verification failed:', err.message);
    return { userId: null, stored: null };
  }
}

/**
 * Map IOtiq Connect devices/switches/scenes to Alexa Smart Home v3 endpoints.
 *
 * The listDevices API returns: { project, spaces, floors, rooms, devices, switches, scenes }
 * We iterate over devices and map each one to an Alexa endpoint with appropriate capabilities.
 */
function mapDevicesToAlexaEndpoints(data) {
  const endpoints = [];

  if (!data) return endpoints;

  // ── Map Devices ─────────────────────────────────────────────────────────────
  const devices = data.devices || {};
  for (const [deviceId, device] of Object.entries(devices)) {
    const deviceType = (device.metadata?.type || 'Switch').toLowerCase();
    const endpoint = {
      endpointId: deviceId,
      manufacturerName: 'IOtiq Connect',
      friendlyName: device.name || `Device ${deviceId.slice(0, 6)}`,
      description: `${device.name || 'Device'} via IOtiq Connect`,
      displayCategories: getDisplayCategories(deviceType),
      cookie: {
        deviceType,
        roomId: device.roomId || null,
      },
      capabilities: [
        ...getCapabilities(deviceType),
        // Required on every endpoint
        {
          type: 'AlexaInterface',
          interface: 'Alexa.EndpointHealth',
          version: '3',
          properties: {
            supported: [{ name: 'connectivity' }],
            proactivelyReported: true,
            retrievable: true,
          },
        },
        {
          type: 'AlexaInterface',
          interface: 'Alexa',
          version: '3',
        },
      ],
    };

    endpoints.push(endpoint);
  }

  // ── Map Switches (standalone relays etc.) ───────────────────────────────────
  const switches = data.switches || {};
  for (const [switchId, sw] of Object.entries(switches)) {
    // Avoid duplicates if switch IDs overlap with device IDs
    if (devices[switchId]) continue;

    endpoints.push({
      endpointId: switchId,
      manufacturerName: 'IOtiq Connect',
      friendlyName: sw.name || `Switch ${switchId.slice(0, 6)}`,
      description: `${sw.name || 'Switch'} via IOtiq Connect`,
      displayCategories: ['SWITCH'],
      cookie: { deviceType: 'switch' },
      capabilities: [
        {
          type: 'AlexaInterface',
          interface: 'Alexa.PowerController',
          version: '3',
          properties: {
            supported: [{ name: 'powerState' }],
            proactivelyReported: true,
            retrievable: true,
          },
        },
        {
          type: 'AlexaInterface',
          interface: 'Alexa.EndpointHealth',
          version: '3',
          properties: {
            supported: [{ name: 'connectivity' }],
            proactivelyReported: true,
            retrievable: true,
          },
        },
        { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
      ],
    });
  }

  // ── Map Scenes ──────────────────────────────────────────────────────────────
  const scenes = data.scenes || {};
  for (const [sceneId, scene] of Object.entries(scenes)) {
    endpoints.push({
      endpointId: sceneId,
      manufacturerName: 'IOtiq Connect',
      friendlyName: scene.name || `Scene ${sceneId.slice(0, 6)}`,
      description: `${scene.name || 'Scene'} via IOtiq Connect`,
      displayCategories: ['SCENE_TRIGGER'],
      cookie: { deviceType: 'scene' },
      capabilities: [
        {
          type: 'AlexaInterface',
          interface: 'Alexa.SceneController',
          version: '3',
          supportsDeactivation: false,
          proactivelyReported: true,
        },
        { type: 'AlexaInterface', interface: 'Alexa', version: '3' },
      ],
    });
  }

  return endpoints;
}

/**
 * Map a device type string to Alexa displayCategories.
 */
function getDisplayCategories(deviceType) {
  const map = {
    light: ['LIGHT'],
    dimmer: ['LIGHT'],
    bulb: ['LIGHT'],
    rgb: ['LIGHT'],
    rgbw: ['LIGHT'],
    switch: ['SWITCH'],
    plug: ['SMARTPLUG'],
    socket: ['SMARTPLUG'],
    fan: ['FAN'],
    thermostat: ['THERMOSTAT'],
    ac: ['THERMOSTAT'],
    tv: ['TV'],
    television: ['TV'],
    curtain: ['INTERIOR_BLIND'],
    blind: ['INTERIOR_BLIND'],
    lock: ['SMARTLOCK'],
    camera: ['CAMERA'],
    sensor: ['CONTACT_SENSOR'],
    motion: ['MOTION_SENSOR'],
    speaker: ['SPEAKER'],
    scene: ['SCENE_TRIGGER'],
  };
  return map[deviceType] || ['OTHER'];
}

/**
 * Map a device type string to the appropriate Alexa capabilities.
 */
function getCapabilities(deviceType) {
  // Base power control (almost everything has this)
  const powerController = {
    type: 'AlexaInterface',
    interface: 'Alexa.PowerController',
    version: '3',
    properties: {
      supported: [{ name: 'powerState' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  const brightnessController = {
    type: 'AlexaInterface',
    interface: 'Alexa.BrightnessController',
    version: '3',
    properties: {
      supported: [{ name: 'brightness' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  const colorController = {
    type: 'AlexaInterface',
    interface: 'Alexa.ColorController',
    version: '3',
    properties: {
      supported: [{ name: 'color' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  const colorTemperatureController = {
    type: 'AlexaInterface',
    interface: 'Alexa.ColorTemperatureController',
    version: '3',
    properties: {
      supported: [{ name: 'colorTemperatureInKelvin' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  const powerLevelController = {
    type: 'AlexaInterface',
    interface: 'Alexa.PowerLevelController',
    version: '3',
    properties: {
      supported: [{ name: 'powerLevel' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  const percentageController = {
    type: 'AlexaInterface',
    interface: 'Alexa.PercentageController',
    version: '3',
    properties: {
      supported: [{ name: 'percentage' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  const thermostatController = {
    type: 'AlexaInterface',
    interface: 'Alexa.ThermostatController',
    version: '3',
    properties: {
      supported: [{ name: 'targetSetpoint' }, { name: 'thermostatMode' }],
      proactivelyReported: true,
      retrievable: true,
    },
    configuration: {
      supportedModes: ['HEAT', 'COOL', 'AUTO'],
      supportsScheduling: false,
    },
  };

  const temperatureSensor = {
    type: 'AlexaInterface',
    interface: 'Alexa.TemperatureSensor',
    version: '3',
    properties: {
      supported: [{ name: 'temperature' }],
      proactivelyReported: true,
      retrievable: true,
    },
  };

  switch (deviceType) {
    case 'light':
    case 'bulb':
      return [powerController, brightnessController];

    case 'dimmer':
      return [powerController, brightnessController, powerLevelController, percentageController];

    case 'rgb':
    case 'rgbw':
      return [powerController, brightnessController, colorController, colorTemperatureController];

    case 'fan':
      return [powerController, powerLevelController, percentageController];

    case 'thermostat':
    case 'ac':
      return [powerController, thermostatController, temperatureSensor];

    case 'curtain':
    case 'blind':
      return [powerController, percentageController];

    case 'tv':
    case 'television':
      return [
        powerController,
        {
          type: 'AlexaInterface',
          interface: 'Alexa.ChannelController',
          version: '3',
          properties: {
            supported: [{ name: 'channel' }],
            proactivelyReported: true,
            retrievable: true,
          },
        },
      ];

    case 'speaker':
      return [
        powerController,
        {
          type: 'AlexaInterface',
          interface: 'Alexa.Speaker',
          version: '3',
          properties: {
            supported: [{ name: 'volume' }, { name: 'muted' }],
            proactivelyReported: true,
            retrievable: true,
          },
        },
      ];

    case 'lock':
      return [
        {
          type: 'AlexaInterface',
          interface: 'Alexa.LockController',
          version: '3',
          properties: {
            supported: [{ name: 'lockState' }],
            proactivelyReported: true,
            retrievable: true,
          },
        },
      ];

    case 'switch':
    case 'plug':
    case 'socket':
    default:
      return [powerController];
  }
}

/**
 * Build state properties from a device's current data for ReportState.
 */
function buildStateProperties(device) {
  const properties = [];
  const deviceType = (device.metadata?.type || 'switch').toLowerCase();
  const now = new Date().toISOString();

  // Power state
  const isOn = device.status === 'ON' || device.status === 'ONLINE' || device.state?.power === true;
  properties.push({
    namespace: 'Alexa.PowerController',
    name: 'powerState',
    value: isOn ? 'ON' : 'OFF',
    timeOfSample: now,
    uncertaintyInMilliseconds: 500,
  });

  // Brightness (if applicable)
  if (['light', 'dimmer', 'bulb', 'rgb', 'rgbw'].includes(deviceType) && device.state?.brightness != null) {
    properties.push({
      namespace: 'Alexa.BrightnessController',
      name: 'brightness',
      value: device.state.brightness,
      timeOfSample: now,
      uncertaintyInMilliseconds: 500,
    });
  }

  // Temperature (if applicable)
  if (['thermostat', 'ac'].includes(deviceType) && device.state?.temperature != null) {
    properties.push({
      namespace: 'Alexa.TemperatureSensor',
      name: 'temperature',
      value: { value: device.state.temperature, scale: 'CELSIUS' },
      timeOfSample: now,
      uncertaintyInMilliseconds: 1000,
    });
  }

  // Thermostat target (if applicable)
  if (['thermostat', 'ac'].includes(deviceType) && device.state?.targetTemperature != null) {
    properties.push({
      namespace: 'Alexa.ThermostatController',
      name: 'targetSetpoint',
      value: { value: device.state.targetTemperature, scale: 'CELSIUS' },
      timeOfSample: now,
      uncertaintyInMilliseconds: 500,
    });
  }

  return properties;
}

/**
 * Build an Alexa error response.
 */
function buildErrorResponse(type, message, correlationToken) {
  return {
    event: {
      header: {
        namespace: 'Alexa',
        name: 'ErrorResponse',
        payloadVersion: '3',
        messageId: uuidv4(),
        ...(correlationToken && { correlationToken }),
      },
      payload: {
        type,
        message,
      },
    },
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
//  Health Check / Home Page
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>IOtiq Connect — Alexa Integration Server</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .status { color: green; font-weight: bold; }
        .endpoint { background: #f5f5f5; padding: 15px; margin: 10px 0; border-left: 3px solid #0066cc; }
        code { background: #e0e0e0; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
        .config-box { background: #e7f3ff; padding: 20px; margin: 20px 0; border-radius: 5px; border: 1px solid #0066cc; }
        .config-item { margin: 10px 0; padding: 10px; background: white; border-radius: 3px; }
        .label { font-weight: bold; color: #555; display: block; margin-bottom: 5px; }
      </style>
    </head>
    <body>
      <h1>IOtiq Connect — Alexa Integration Server</h1>
      <p>Status: <span class="status">Running</span></p>
      <p>Home API: <code>${homeApiBaseUrl}</code></p>
      <p>Linked users: <strong>${Object.keys(homeTokenStore).length}</strong></p>

      <div class="config-box">
        <h3>Alexa Skill Account Linking Configuration</h3>
        <div class="config-item">
          <span class="label">Authorization URI:</span>
          <code>https://YOUR_DOMAIN/authorize</code>
        </div>
        <div class="config-item">
          <span class="label">Access Token URI:</span>
          <code>https://YOUR_DOMAIN/token</code>
        </div>
        <div class="config-item">
          <span class="label">Client ID:</span>
          <code>alexa-skill</code>
        </div>
        <div class="config-item">
          <span class="label">Client Secret:</span>
          <code>alexa-client-secret</code>
        </div>
      </div>

      <div class="config-box">
        <h3>Alexa Smart Home Skill Endpoint</h3>
        <div class="config-item">
          <span class="label">Skill Endpoint (HTTPS):</span>
          <code>https://YOUR_DOMAIN/alexa/smart-home</code>
        </div>
        <p style="margin-top:10px; font-size:0.9rem; color:#555;">
          In the Alexa Developer Console, set the Smart Home skill's Default Endpoint
          to the HTTPS URL above (instead of an AWS Lambda ARN).
        </p>
      </div>

      <h2>Endpoints:</h2>
      <div class="endpoint"><strong>GET</strong> <code>/authorize</code> — OAuth authorization</div>
      <div class="endpoint"><strong>POST</strong> <code>/token</code> — OAuth token exchange</div>
      <div class="endpoint"><strong>GET</strong> <code>/userinfo</code> — User profile</div>
      <div class="endpoint"><strong>POST</strong> <code>/alexa/smart-home</code> — Alexa Smart Home directives (discovery, control, state)</div>
    </body>
    </html>
  `);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('══════════════════════════════════════════');
  console.log(' IOtiq Connect — Alexa Integration Server');
  console.log('══════════════════════════════════════════');
  console.log(` Port:     ${PORT}`);
  console.log(` Home API: ${homeApiBaseUrl}`);
  console.log(` Local:    http://localhost:${PORT}`);
  console.log('──────────────────────────────────────────');
  console.log(' Alexa Skill Config:');
  console.log('   Authorization URI: https://YOUR_DOMAIN/authorize');
  console.log('   Access Token URI:  https://YOUR_DOMAIN/token');
  console.log('   Skill Endpoint:    https://YOUR_DOMAIN/alexa/smart-home');
  console.log('══════════════════════════════════════════');
});