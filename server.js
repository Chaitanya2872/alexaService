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
app.use('/assets', express.static(path.join(__dirname, 'assets')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = jwtSecret;
const CODE_TTL_SEC = 600;
const ACCESS_TOKEN_TTL_SEC = accessTokenTTL || 3600;
const ALWAYS_SHOW_LOGIN = String(process.env.ALWAYS_SHOW_LOGIN || '').toLowerCase() === 'true';

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
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>IOtiq Connect - Link Account</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #f6f7fb;
          --panel: #fff;
          --text: #141925;
          --muted: #6e7687;
          --line: #dfe3ec;
          --pill: #eef1f6;
          --primary: #2f6bff;
          --primary-dark: #2858d2;
          --shadow: 0 10px 28px rgba(20, 33, 61, .08);
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: var(--bg);
          color: var(--text);
          min-height: 100vh;
          display: flex;
          justify-content: center;
          padding: 22px 16px;
        }
        .shell { width: 100%; max-width: 380px; }
        .top-controls { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
        .icon-btn {
          width: 42px;
          height: 42px;
          border: 0;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: #eceff5;
          color: #232833;
          box-shadow: 0 6px 14px rgba(17, 24, 39, .08);
          cursor: pointer;
        }
        .icon-btn svg { width: 18px; height: 18px; }
        .card {
          background: var(--panel);
          border-radius: 24px;
          padding: 20px 18px 18px;
          box-shadow: var(--shadow);
        }
        .logo-wrap { text-align: center; margin-bottom: 14px; }
        .logo-wrap img { height: 56px; width: auto; object-fit: contain; }
        h2 { font-size: 1.75rem; font-weight: 700; letter-spacing: -.02em; text-align: center; margin-bottom: 4px; }
        .subtitle { text-align: center; font-size: .94rem; color: var(--muted); margin-bottom: 16px; }
        .error {
          color: #d82424;
          font-size: .86rem;
          margin-bottom: 12px;
          padding: 10px 12px;
          background: #fff1f1;
          border-radius: 12px;
          border: 1px solid #ffd7d7;
        }
        .segment {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          padding: 5px;
          background: var(--pill);
          border-radius: 16px;
          margin-bottom: 14px;
        }
        .segment-btn {
          border: 0;
          border-radius: 12px;
          height: 38px;
          font-size: .9rem;
          font-weight: 600;
          color: #242a36;
          background: transparent;
          cursor: pointer;
        }
        .segment-btn.active {
          background: #2d313a;
          color: #fff;
          box-shadow: 0 5px 12px rgba(0, 0, 0, .16);
        }
        .field-label { display: block; margin-bottom: 6px; font-size: .82rem; color: #4f5665; font-weight: 600; }
        .input {
          width: 100%;
          height: 54px;
          border: 1px solid var(--line);
          border-radius: 15px;
          padding: 0 14px;
          font-size: 1rem;
          background: #fff;
          margin-bottom: 12px;
          outline: none;
        }
        .input:focus, .country-code:focus {
          border-color: #8facff;
          box-shadow: 0 0 0 3px rgba(47, 107, 255, .12);
        }
        .phone-row { display: grid; grid-template-columns: 92px 1fr; gap: 10px; margin-bottom: 12px; }
        .country-code {
          height: 54px;
          border: 1px solid var(--line);
          border-radius: 15px;
          background: #fff;
          padding: 0 10px;
          font-size: .98rem;
          outline: none;
          appearance: none;
          background-image: linear-gradient(45deg, transparent 50%, #4c5568 50%), linear-gradient(135deg, #4c5568 50%, transparent 50%);
          background-position: calc(100% - 16px) calc(50% - 3px), calc(100% - 11px) calc(50% - 3px);
          background-size: 5px 5px, 5px 5px;
          background-repeat: no-repeat;
        }
        .primary-btn {
          width: 100%;
          height: 56px;
          border: 0;
          border-radius: 18px;
          color: #fff;
          font-size: 1rem;
          font-weight: 700;
          background: linear-gradient(180deg, var(--primary), var(--primary-dark));
          box-shadow: 0 12px 22px rgba(47, 107, 255, .3);
          cursor: pointer;
          margin-top: 2px;
        }
        .divider {
          margin: 18px 0 14px;
          display: flex;
          align-items: center;
          gap: 10px;
          color: #7f8797;
          font-size: .82rem;
          justify-content: center;
        }
        .divider::before, .divider::after {
          content: "";
          height: 1px;
          flex: 1;
          max-width: 110px;
          background: #dde2ea;
        }
        .social-stack { display: grid; gap: 10px; }
        .social-btn {
          width: 100%;
          height: 54px;
          border-radius: 16px;
          border: 1px solid #dde2ea;
          background: #fff;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          font-size: .95rem;
          font-weight: 600;
          color: #1f2633;
          cursor: pointer;
        }
        .social-btn svg { width: 20px; height: 20px; }
        .hidden { display: none; }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="top-controls">
          <button type="button" class="icon-btn" aria-label="Go Back" onclick="history.back()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button type="button" class="icon-btn" id="infoBtn" aria-label="Info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 10v6"/><path d="M12 7h.01"/></svg>
          </button>
        </div>

        <div class="card">
          <div class="logo-wrap">
            <img src="/assets/iotiq-logo.png" alt="IOTIQ logo">
          </div>
          <h2>Welcome back!</h2>
          <p class="subtitle">Sign in with your IOTIQ account to continue.</p>

          ${error ? `<div class="error">${error}</div>` : ''}

          <form id="loginForm" method="POST" action="/login">
            <input type="hidden" name="continue" value="${continueTo.replace(/"/g, '&quot;')}" />
            <input type="hidden" name="username" id="usernameHidden" />

            <div class="segment" role="tablist" aria-label="Login Mode">
              <button type="button" class="segment-btn active" id="tabPhone" role="tab" aria-selected="true">Phone Number</button>
              <button type="button" class="segment-btn" id="tabEmail" role="tab" aria-selected="false">Email Address</button>
            </div>

            <div id="phoneFields">
              <label class="field-label" for="phoneInput">Phone Number</label>
              <div class="phone-row">
                <select id="countryCode" class="country-code" aria-label="Country Code">
                  <option value="+62" selected>+62</option>
                  <option value="+91">+91</option>
                  <option value="+1">+1</option>
                  <option value="+44">+44</option>
                </select>
                <input id="phoneInput" class="input" type="tel" inputmode="numeric" autocomplete="tel" placeholder="812 3456 7890">
              </div>
            </div>

            <div id="emailFields" class="hidden">
              <label class="field-label" for="emailInput">Email Address</label>
              <input id="emailInput" class="input" type="email" autocomplete="email" placeholder="you@example.com">
            </div>

            <label class="field-label" for="passwordInput">Password</label>
            <input id="passwordInput" class="input" type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required>

            <button type="submit" class="primary-btn">Continue</button>
          </form>

          <div class="divider">or use social account</div>

          <div class="social-stack">
            <button type="button" class="social-btn" aria-label="Continue with Google">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.5 14.6 2.5 12 2.5 6.8 2.5 2.5 6.8 2.5 12s4.3 9.5 9.5 9.5c5.5 0 9.1-3.9 9.1-9.3 0-.6-.1-1.1-.2-1.5H12z"/></svg>
              <span>Continue with Google</span>
            </button>
            <button type="button" class="social-btn" aria-label="Continue with Apple">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#111" d="M16.7 12.8c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.7-1.8-3.3-1.8-1.4-.1-2.7.8-3.4.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.9-3.5 2.1-1.5 2.5-.4 6.3 1 8.3.7 1 1.5 2.2 2.6 2.2 1.1 0 1.5-.7 2.8-.7 1.3 0 1.7.7 2.8.7 1.2 0 1.9-1 2.6-2 .8-1.1 1.1-2.3 1.1-2.4 0 0-2-.8-2-3zM14.5 6.1c.6-.7 1-1.6.9-2.6-.9 0-1.9.6-2.5 1.3-.6.7-1.1 1.7-1 2.6 1 .1 2-.5 2.6-1.3z"/></svg>
              <span>Continue with Apple</span>
            </button>
          </div>
        </div>
      </div>

      <script>
        (function () {
          var mode = 'phone';
          var form = document.getElementById('loginForm');
          var usernameHidden = document.getElementById('usernameHidden');
          var tabPhone = document.getElementById('tabPhone');
          var tabEmail = document.getElementById('tabEmail');
          var phoneFields = document.getElementById('phoneFields');
          var emailFields = document.getElementById('emailFields');
          var countryCode = document.getElementById('countryCode');
          var phoneInput = document.getElementById('phoneInput');
          var emailInput = document.getElementById('emailInput');
          var passwordInput = document.getElementById('passwordInput');
          var infoBtn = document.getElementById('infoBtn');

          function setMode(nextMode) {
            mode = nextMode;
            var phoneActive = nextMode === 'phone';
            tabPhone.classList.toggle('active', phoneActive);
            tabEmail.classList.toggle('active', !phoneActive);
            tabPhone.setAttribute('aria-selected', phoneActive ? 'true' : 'false');
            tabEmail.setAttribute('aria-selected', phoneActive ? 'false' : 'true');
            phoneFields.classList.toggle('hidden', !phoneActive);
            emailFields.classList.toggle('hidden', phoneActive);
          }

          function compactPhone(raw) {
            return String(raw || '').replace(/[^0-9]/g, '');
          }

          tabPhone.addEventListener('click', function () { setMode('phone'); });
          tabEmail.addEventListener('click', function () { setMode('email'); });
          infoBtn.addEventListener('click', function () {
            window.alert('Sign in with your IOTIQ account to link with Alexa.');
          });

          form.addEventListener('submit', function (e) {
            var username = '';
            if (mode === 'phone') {
              var dial = countryCode.value || '+62';
              var phone = compactPhone(phoneInput.value);
              if (!phone) {
                e.preventDefault();
                phoneInput.focus();
                return;
              }
              username = dial + phone;
            } else {
              var email = String(emailInput.value || '').trim();
              if (!email) {
                e.preventDefault();
                emailInput.focus();
                return;
              }
              username = email;
            }

            if (!String(passwordInput.value || '').trim()) {
              e.preventDefault();
              passwordInput.focus();
              return;
            }

            usernameHidden.value = username;
          });
        })();
      </script>
    </body>
    </html>
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

  const forceLoginBypass = String(req.query._login_done || '') === '1';
  const continueTo = `/authorize?${querystring.stringify(req.query)}`;
  const continueAfterForcedLogin = `/authorize?${querystring.stringify({ ...req.query, _login_done: '1' })}`;
  const forceLogin = (ALWAYS_SHOW_LOGIN || String(req.query.prompt || '').toLowerCase() === 'login') && !forceLoginBypass;
  if (forceLogin) {
    if (req.cookies.userId) {
      console.log(`[AUTHORIZE] Force login enabled, clearing userId cookie`);
    }
    res.clearCookie('userId');
    return res.redirect(`/login?continue=${encodeURIComponent(continueAfterForcedLogin)}`);
  }

  if (!req.cookies.userId) {
    return res.redirect(`/login?continue=${encodeURIComponent(continueTo)}`);
  }

  const userId = req.cookies.userId;
  console.log(`[AUTHORIZE] Reusing login session for userId=${userId}`);
  let stored = getHomeToken(userId);
  if (!stored?.homeApiToken) {
    stored = recoverHomeTokenFromRefresh(userId);
  }

  if (!stored?.homeApiToken || isJwtExpired(stored.homeApiToken, 60)) {
    console.warn(`[AUTHORIZE] Missing/expired Home token for ${userId}; forcing re-login`);
    res.clearCookie('userId');
    return res.redirect(`/login?continue=${encodeURIComponent(continueTo)}`);
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
