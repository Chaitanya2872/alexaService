const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_ALEXA_EVENT_GATEWAY_URL = 'https://api.amazonalexa.com/v3/events';

function normalizeEndpoints({ endpointIds = [], endpoints = [] } = {}) {
  const normalized = [];
  const seen = new Set();

  for (const endpointId of endpointIds) {
    const value = String(endpointId || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push({ endpointId: value });
  }

  for (const endpoint of endpoints) {
    const value = String(endpoint?.endpointId || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push({ endpointId: value });
  }

  return normalized;
}

async function sendDeleteReport({
  eventGatewayToken,
  customerAccessToken,
  endpointIds,
  endpoints,
  messageId,
  eventUrl = process.env.ALEXA_EVENT_GATEWAY_URL || DEFAULT_ALEXA_EVENT_GATEWAY_URL,
}) {
  const gatewayToken = String(eventGatewayToken || '').trim();
  const customerToken = String(customerAccessToken || '').trim();
  const normalizedEndpoints = normalizeEndpoints({ endpointIds, endpoints });

  if (!gatewayToken) {
    throw new Error('Missing Alexa event gateway token.');
  }
  if (!customerToken) {
    throw new Error('Missing customer access token.');
  }
  if (normalizedEndpoints.length === 0) {
    throw new Error('At least one endpointId is required.');
  }

  const payload = {
    event: {
      header: {
        namespace: 'Alexa.Discovery',
        name: 'DeleteReport',
        messageId: messageId || uuidv4(),
        payloadVersion: '3',
      },
      payload: {
        endpoints: normalizedEndpoints,
        scope: {
          type: 'BearerToken',
          token: customerToken,
        },
      },
    },
  };

  const response = await axios.post(eventUrl, payload, {
    headers: {
      Authorization: `Bearer ${gatewayToken}`,
      'Content-Type': 'application/json',
    },
    timeout: 30_000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    const details = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const error = new Error(`Alexa DeleteReport failed (${response.status}): ${details}`);
    error.status = response.status;
    error.responseData = response.data;
    throw error;
  }

  return {
    status: response.status,
    data: response.data,
    endpointCount: normalizedEndpoints.length,
    messageId: payload.event.header.messageId,
  };
}

module.exports = {
  DEFAULT_ALEXA_EVENT_GATEWAY_URL,
  normalizeEndpoints,
  sendDeleteReport,
};
