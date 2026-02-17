// utils/jwt.js
const jwt = require('jsonwebtoken');
const { jwtSecret, accessTokenTTL } = require('../config/secrets');

function createAccessToken(payload) {
  return jwt.sign(payload, jwtSecret, { expiresIn: accessTokenTTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, jwtSecret);
  } catch (err) {
    return null;
  }
}

module.exports = { createAccessToken, verifyToken };
