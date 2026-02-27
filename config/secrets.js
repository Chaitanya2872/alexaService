// config/secrets.js
module.exports = {
  jwtSecret: process.env.JWT_SECRET || "supersecretkey1234567890",
  homeApiBaseUrl: "https://psm.iotiqinnovations.com",
  accessTokenTTL: 3600,       // 1 hour
  refreshTokenTTL: 86400,     // 24 hours
  codeTTL: 600,               // 10 minutes
};
