// config/secrets.js
module.exports = {
  jwtSecret: process.env.JWT_SECRET || "supersecretkey1234567890",
  homeApiBaseUrl: process.env.HOME_API_BASE_URL || "https://your-iotiq-api-base-url.com", // <-- SET THIS to your IOtiq Connect API base URL
  accessTokenTTL: 3600,       // 1 hour
  refreshTokenTTL: 86400,     // 24 hours
  codeTTL: 600,               // 10 minutes
};