// utils/codes.js
const { v4: uuidv4 } = require('uuid');
const { CODE_TTL_SEC } = { CODE_TTL_SEC: 120 };

const codes = {}; // code -> { userId, clientId, redirect_uri, expiresAt }

function generateCode({ userId, clientId, redirect_uri }) {
  const code = uuidv4();
  codes[code] = { userId, clientId, redirect_uri, expiresAt: Date.now() + CODE_TTL_SEC * 1000 };
  return code;
}

function verifyCode(code) {
  const entry = codes[code];
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { delete codes[code]; return null; }
  // one-time use
  delete codes[code];
  return entry.userId;
}

module.exports = { generateCode, verifyCode };
