// utils/homeApi.js
// Thin wrapper around the home-automation REST API described in api_usage.md.
// All calls carry the Bearer token that was stored at account-link time.

const axios = require('axios');
const { homeApiBaseUrl } = require('../config/secrets');

/**
 * Build an axios instance pre-configured for the home API.
 * @param {string} bearerToken  - The user's home-API access token (stored at link time).
 * @param {string} [projectId]  - Optional project ID for x-project-id header.
 */
function homeClient(bearerToken, projectId) {
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${bearerToken}`,
  };
  if (projectId) {
    headers['x-project-id'] = projectId;
  }
  return axios.create({
    baseURL: homeApiBaseUrl,
    headers,
    timeout: 30_000,
  });
}

/**
 * Parse the auth.token value from set-cookie headers returned by the home API.
 */
function parseAuthTokenFromCookies(setCookieHeader) {
  if (!setCookieHeader) return null;
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const cookie of cookies) {
    const match = cookie.match(/auth(?:\.|%2E)token=([^;]+)/i);
    if (match) return decodeURIComponent(match[1]);
    const tokenMatch = cookie.match(/\btoken=([^;]+)/i);
    if (tokenMatch) return decodeURIComponent(tokenMatch[1]);
  }
  return null;
}

/**
 * Authenticate the user against the home API.
 * Endpoint: POST /auth/identity/strategy/basic/signin
 */
async function loginToHomeApi(email, password) {
  console.log(`[homeApi.login] Calling ${homeApiBaseUrl}/auth/identity/strategy/basic/signin`);

  let resp;
  try {
    resp = await axios.post(
      `${homeApiBaseUrl}/auth/identity/strategy/basic/signin`,
      { email, password },
      { headers: { 'Content-Type': 'application/json' }, validateStatus: () => true }
    );
  } catch (networkErr) {
    console.error(`[homeApi.login] Network error:`, networkErr.message);
    throw networkErr;
  }

  console.log(`[homeApi.login] Response status: ${resp.status}`);
  console.log(`[homeApi.login] Response body:`, JSON.stringify(resp.data, null, 2));
  console.log(`[homeApi.login] set-cookie:`, resp.headers['set-cookie'] || 'none');

  if (resp.status >= 400) {
    const errMsg = resp.data?.message || resp.data?.error || JSON.stringify(resp.data);
    const err = new Error(`Home API login failed (${resp.status}): ${errMsg}`);
    err.status = resp.status;
    err.responseData = resp.data;
    throw err;
  }

  const token = parseAuthTokenFromCookies(resp.headers['set-cookie']);
  const bodyToken = resp.data?.token || resp.data?.accessToken || null;

  return {
    message: resp.data.message,
    data: resp.data.data,
    token: token || bodyToken || null,
  };
}

/**
 * Fetch all spaces/floors/rooms/devices/switches/scenes.
 * Endpoint: POST /api/server/read/spaces
 */
async function listDevices(bearerToken, filters = {}, projectId) {
  const client = homeClient(bearerToken, projectId);
  const resp = await client.post('/api/server/read/spaces', filters);
  return resp.data;
}

/**
 * Read a single device by ID.
 * Endpoint: GET /api/server/device/read/one/:deviceId
 */
async function readOneDevice(bearerToken, deviceId, projectId) {
  const client = homeClient(bearerToken, projectId);
  const resp = await client.get(`/api/server/device/read/one/${deviceId}`);
  return resp.data;
}

/**
 * Send a control command to a specific device/switch.
 * Endpoint: POST /api/server/trigger/device
 */
async function controlDevice(bearerToken, deviceId, utterance, params = {}, projectId) {
  const client = homeClient(bearerToken, projectId);
  const payload = {
    deviceId,
    utterence: utterance, // API spells it "utterence" — preserved
    params,
  };
  console.log(`[homeApi.control] Sending:`, JSON.stringify(payload, null, 2));
  const resp = await client.post('/api/server/trigger/device', payload);
  console.log(`[homeApi.control] Response status: ${resp.status}`);
  return resp.data;
}

/**
 * Switch the user's active project context.
 * Endpoint: POST /api/user/project/active/:accountId
 */
async function setActiveProject(bearerToken, accountId, projectId) {
  const client = homeClient(bearerToken);
  const resp = await client.post(`/api/user/project/active/${accountId}`, { projectId });
  return resp.data;
}

module.exports = {
  loginToHomeApi,
  listDevices,
  readOneDevice,
  controlDevice,
  setActiveProject,
  parseAuthTokenFromCookies,
};