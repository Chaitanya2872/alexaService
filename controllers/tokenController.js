// controllers/tokenController.js
// Handles POST /token for both:
//   grant_type=authorization_code  (initial skill link)
//   grant_type=refresh_token        (Alexa silently refreshes)

const clients = require('../config/clients');
const codes   = require('../utils/codes');
const jwt     = require('../utils/jwt');

exports.handleToken = (req, res) => {
  const { grant_type } = req.body;

  if (grant_type === 'authorization_code') {
    return handleAuthCode(req, res);
  }
  if (grant_type === 'refresh_token') {
    return handleRefresh(req, res);
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
};

// ── Authorization Code Exchange ───────────────────────────────────────────────
function handleAuthCode(req, res) {
  const { code, client_id, client_secret, redirect_uri } = req.body;

  // Validate client credentials
  const client = clients[client_id];
  if (!client || client.client_secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client', message: 'Invalid client credentials' });
  }

  // Verify & consume the authorization code
  const entry = codes.verifyCode(code, { clientId: client_id, redirectUri: redirect_uri });
  if (!entry) {
    return res.status(400).json({ error: 'invalid_grant', message: 'Authorization code is invalid or expired' });
  }

  const { userId } = entry;

  // Issue tokens
  const accessToken  = jwt.createAccessToken(userId);
  const refreshToken = jwt.createRefreshToken(userId);

  return res.json({
    access_token:  accessToken,
    token_type:    'Bearer',
    expires_in:    3600,
    refresh_token: refreshToken,
  });
}

// ── Refresh Token Exchange ────────────────────────────────────────────────────
function handleRefresh(req, res) {
  const { refresh_token, client_id, client_secret } = req.body;

  const client = clients[client_id];
  if (!client || client.client_secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client', message: 'Invalid client credentials' });
  }

  // Verify the refresh token
  const decoded = jwt.verifyToken(refresh_token);
  if (!decoded || decoded.type !== 'refresh') {
    return res.status(400).json({ error: 'invalid_grant', message: 'Refresh token is invalid or expired' });
  }

  const userId = decoded.sub;

  // Issue new tokens (refresh token rotation — each refresh invalidates the old one)
  const newAccessToken  = jwt.createAccessToken(userId);
  const newRefreshToken = jwt.createRefreshToken(userId);

  return res.json({
    access_token:  newAccessToken,
    token_type:    'Bearer',
    expires_in:    3600,
    refresh_token: newRefreshToken,
  });
}