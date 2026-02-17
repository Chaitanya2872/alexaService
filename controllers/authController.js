// controllers/authController.js
const bcrypt  = require('bcrypt');
const users   = require('../config/users');
const clients = require('../config/clients');
const codes   = require('../utils/codes');
const homeApi = require('../utils/Homeapi');

// In-memory session store for the OAuth flow parameters during the login page.
// Keys on a short-lived session ID that's passed through the login form as a hidden field.
// In production, use express-session backed by Redis.
const loginSessions = {};

/**
 * GET /authorize
 *
 * Alexa calls this to start account linking. We validate the client & redirect_uri,
 * then show the login page. We preserve the OAuth params in a temp session.
 */
exports.handleAuthorize = (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('Only response_type=code is supported');
  }

  const client = clients[client_id];
  if (!client) {
    return res.status(400).send(`Unknown client_id: ${client_id}`);
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send('redirect_uri not registered for this client');
  }

  // Store the OAuth params so we can retrieve them after the user logs in
  const sessionId = require('crypto').randomBytes(16).toString('hex');
  loginSessions[sessionId] = { client_id, redirect_uri, state };

  // Show the login page, embedding sessionId in the form
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Link Your Account</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, sans-serif; background: #f0f4f8; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.1); width: 100%; max-width: 380px; }
        h2 { margin-bottom: .5rem; font-size: 1.4rem; color: #1a1a2e; }
        p  { font-size: .9rem; color: #666; margin-bottom: 1.5rem; }
        label { display: block; font-size: .85rem; font-weight: 600; color: #333; margin-bottom: .3rem; }
        input { width: 100%; padding: .65rem .9rem; border: 1px solid #d1d5db; border-radius: 8px; font-size: 1rem; margin-bottom: 1rem; }
        input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
        button { width: 100%; padding: .75rem; background: #2563eb; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
        button:hover { background: #1d4ed8; }
        .error { color: #dc2626; font-size: .85rem; margin-bottom: 1rem; padding: .5rem; background: #fef2f2; border-radius: 6px; display: none; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Link Your Account</h2>
        <p>Sign in to connect your smart home to Alexa.</p>
        <form method="POST" action="/login">
          <input type="hidden" name="sessionId" value="${sessionId}" />
          <label for="email">Email</label>
          <input type="email" id="email" name="email" placeholder="you@example.com" required />
          <label for="password">Password</label>
          <input type="password" id="password" name="password" placeholder="••••••••" required />
          <button type="submit">Sign In &amp; Link</button>
        </form>
      </div>
    </body>
    </html>
  `);
};

/**
 * POST /login
 *
 * Validate credentials against the home API (or local users as fallback),
 * then immediately redirect back to Alexa with an authorization code.
 * We also store the home-API token so we can use it for device calls later.
 */
exports.handleLogin = async (req, res) => {
  const { email, password, sessionId } = req.body;

  // Retrieve the saved OAuth params
  const session = loginSessions[sessionId];
  if (!session) {
    return res.status(400).send('OAuth session expired — please restart account linking from the Alexa app.');
  }
  const { client_id, redirect_uri, state } = session;

  // ── 1. Authenticate against home API ─────────────────────────────────────
  let homeAccount = null;
  let homeToken   = null;
  try {
    const result = await homeApi.loginToHomeApi(email, password);
    homeAccount  = result.data;        // { id, email, name, projectId, ... }
    // The home API sets an httpOnly cookie; for Bearer usage extract the token if returned
    // or store credentials securely. Here we keep the returned account metadata.
    homeToken = result.token || null;  // adjust based on your actual API response shape
  } catch (err) {
    // Fall back to local user store (useful for development / offline testing)
    console.warn('Home API login failed, falling back to local users:', err.message);
    const localUser = users.find(u => u.email === email);
    if (!localUser || !(await bcrypt.compare(password, localUser.passwordHash))) {
      return res.status(401).send('Invalid email or password.');
    }
    homeAccount = { id: localUser.id, email: localUser.email, name: localUser.name };
  }

  // ── 2. Generate OAuth authorization code ─────────────────────────────────
  const code = codes.generateCode({
    userId:      homeAccount.id,
    clientId:    client_id,
    redirectUri: redirect_uri,
    // Optionally stash the home API token here if you want to retrieve it at /token time
    meta:        { homeToken, projectId: homeAccount.projectId },
  });

  // Clean up the temporary session
  delete loginSessions[sessionId];

  // ── 3. Redirect back to Alexa with the code ───────────────────────────────
  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  res.redirect(redirectUrl.toString());
};