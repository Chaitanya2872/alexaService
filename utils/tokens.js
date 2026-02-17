// utils/tokens.js
const { v4: uuidv4 } = require('uuid');

const refreshTokens = {}; // token -> { userId, clientId, expiresAt }

function createRefreshToken(userId, clientId) {
  const token = uuidv4();
  refreshTokens[token] = { userId, clientId, expiresAt: Date.now() + 30 * 24 * 3600 * 1000 };
  return token;
}

function getRefreshToken(token) {
  const entry = refreshTokens[token];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { delete refreshTokens[token]; return null; }
  return entry;
}

module.exports = { createRefreshToken, getRefreshToken };
