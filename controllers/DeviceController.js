// controllers/deviceController.js
// Proxies device discovery and control requests from Alexa to the home-automation API.
// Called from the Alexa Smart Home Lambda (or Smart Home Skill handler).

const users   = require('../config/users');
const homeApi = require('../utils/Homeapi');

// ── Helper: get a stored home-API token for a user ───────────────────────────
// In a real system you'd persist the home-API token (obtained during account linking)
// in a database keyed by userId. Here we keep a simple in-memory map as a placeholder.
const homeTokenStore = {}; // userId -> { homeApiToken, accountId, projectId }

/**
 * Store the home-API token after account linking succeeds.
 * Call this from authController after a successful /login.
 */
function storeHomeToken(userId, { homeApiToken, accountId, projectId }) {
  homeTokenStore[userId] = { homeApiToken, accountId, projectId };
}

/**
 * POST /api/devices
 * Retrieve all devices (spaces/floors/rooms) for the linked user.
 *
 * Request body (optional filters):
 *   { spaceId, floorId, roomId, projectId, useOwnerProject }
 */
exports.handleListDevices = async (req, res) => {
  const userId = req.user.sub;
  const stored = homeTokenStore[userId];

  if (!stored || !stored.homeApiToken) {
    return res.status(403).json({
      error: 'not_linked',
      message: 'No home-API credentials found. Please re-link your account.',
    });
  }

  try {
    const data = await homeApi.listDevices(stored.homeApiToken, req.body);
    return res.json(data);
  } catch (err) {
    console.error('listDevices error:', err.message);
    const status = err.response?.status || 502;
    return res.status(status).json({ error: 'home_api_error', message: err.message });
  }
};

/**
 * POST /api/device/control
 * Send a voice-command-style utterance to a specific device.
 *
 * Request body:
 *   { deviceId: string, utterance: string, params?: object }
 *
 * Example utterances: "turn on", "turn off", "set to 50%", "set cool white", "dim to 30%"
 */
exports.handleControlDevice = async (req, res) => {
  const userId = req.user.sub;
  const stored = homeTokenStore[userId];

  if (!stored || !stored.homeApiToken) {
    return res.status(403).json({
      error: 'not_linked',
      message: 'No home-API credentials found. Please re-link your account.',
    });
  }

  const { deviceId, utterance, params } = req.body;

  if (!deviceId || !utterance) {
    return res.status(400).json({
      error: 'missing_params',
      message: 'deviceId and utterance are required',
    });
  }

  try {
    const result = await homeApi.controlDevice(stored.homeApiToken, deviceId, utterance, params || {});
    return res.json(result);
  } catch (err) {
    console.error('controlDevice error:', err.message);
    const status = err.response?.status || 502;
    return res.status(status).json({ error: 'home_api_error', message: err.message });
  }
};

/**
 * POST /api/project/switch
 * Switch the user's active project.
 *
 * Request body: { projectId: string }
 */
exports.handleSwitchProject = async (req, res) => {
  const userId = req.user.sub;
  const stored = homeTokenStore[userId];

  if (!stored || !stored.homeApiToken) {
    return res.status(403).json({ error: 'not_linked' });
  }

  const { projectId } = req.body;
  if (!projectId) {
    return res.status(400).json({ error: 'missing_params', message: 'projectId is required' });
  }

  try {
    const result = await homeApi.setActiveProject(stored.homeApiToken, stored.accountId, projectId);
    // Update stored projectId
    homeTokenStore[userId].projectId = projectId;
    return res.json(result);
  } catch (err) {
    console.error('switchProject error:', err.message);
    return res.status(502).json({ error: 'home_api_error', message: err.message });
  }
};

// Export the token store setter so authController can call it
exports.storeHomeToken = storeHomeToken;