// utils/homeApi.js
// Thin wrapper around the home-automation REST API described in api_usage.md.
// All calls carry the Bearer token that was stored at account-link time.

const axios = require('axios');
const { homeApiBaseUrl } = require('../config/secrets');

/**
 * Build an axios instance pre-configured for the home API.
 * @param {string} bearerToken  - The user's home-API access token (stored at link time).
 */
function homeClient(bearerToken) {
  return axios.create({
    baseURL: homeApiBaseUrl,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${bearerToken}`,
    },
    timeout: 10_000,
  });
}

/**
 * Authenticate the user against the home API using email + password.
 * Returns { token, account } on success, throws on failure.
 *
 * Endpoint: POST /auth/identity/strategy/basic/signin
 */
async function loginToHomeApi(email, password) {
  const resp = await axios.post(
    `${homeApiBaseUrl}/auth/identity/strategy/basic/signin`,
    { email, password },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return resp.data; // { message, data: { id, email, name, projectId, ... } }
}

/**
 * Fetch all spaces/floors/rooms/devices for the user's active project.
 * Returns the full normalized data object from the API.
 *
 * Endpoint: POST /api/server/read/spaces
 */
async function listDevices(bearerToken, filters = {}) {
  const client = homeClient(bearerToken);
  const resp = await client.post('/api/server/read/spaces', filters);
  return resp.data; // { status, data: { spaces, floors, rooms, devices, switches, scenes } }
}

/**
 * Send a control command to a specific device.
 *
 * Endpoint: POST /api/server/trigger/device
 *
 * @param {string} bearerToken
 * @param {string} deviceId   - Device UUID
 * @param {string} utterance  - e.g. "turn on", "set to 50%", "set cool white"
 * @param {object} params     - Optional extra params for the command
 */
async function controlDevice(bearerToken, deviceId, utterance, params = {}) {
  const client = homeClient(bearerToken);
  const resp = await client.post('/api/server/trigger/device', {
    deviceId,
    utterence: utterance, // note: the API spells it "utterence" (their typo — preserved)
    params,
  });
  return resp.data; // { status: 'success', data: { ... } }
}

/**
 * Switch the user's active project context.
 *
 * Endpoint: POST /api/user/project/active/:accountId
 */
async function setActiveProject(bearerToken, accountId, projectId) {
  const client = homeClient(bearerToken);
  const resp = await client.post(`/api/user/project/active/${accountId}`, { projectId });
  return resp.data;
}

module.exports = { loginToHomeApi, listDevices, controlDevice, setActiveProject };