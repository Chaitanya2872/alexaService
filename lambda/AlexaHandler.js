// lambda/alexa-handler.js
// ─────────────────────────────────────────────────────────────────────────────
// Alexa Smart Home Skill Lambda handler.
//
// Deploy this as an AWS Lambda function and configure it as the endpoint
// in the Alexa Developer Console under "Smart Home > Default endpoint".
//
// This handler:
//   1. Receives Alexa Smart Home directives (Discovery, PowerController, etc.)
//   2. Uses the access_token Alexa provides to call YOUR OAuth backend
//   3. Translates Alexa commands into home-API utterances ("turn on", "dim to X%")
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── Config ────────────────────────────────────────────────────────────────────
const OAUTH_BACKEND = process.env.OAUTH_BACKEND_URL || 'https://your-oauth-backend.example.com';

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  console.log('Alexa directive received:', JSON.stringify(event, null, 2));

  const namespace = event.directive.header.namespace;
  const name      = event.directive.header.name;

  if (namespace === 'Alexa.Discovery' && name === 'Discover') {
    return handleDiscovery(event);
  }

  if (namespace === 'Alexa.PowerController') {
    return handlePowerControl(event);
  }

  if (namespace === 'Alexa.BrightnessController') {
    return handleBrightness(event);
  }

  if (namespace === 'Alexa.ColorTemperatureController') {
    return handleColorTemperature(event);
  }

  if (namespace === 'Alexa' && name === 'ReportState') {
    return handleReportState(event);
  }

  // Fallback — unsupported directive
  return buildErrorResponse(event, 'INVALID_DIRECTIVE', `Unsupported: ${namespace}/${name}`);
};

// ── Discovery ─────────────────────────────────────────────────────────────────
async function handleDiscovery(event) {
  const accessToken = event.directive.payload.scope.token;

  let devicesRaw;
  try {
    devicesRaw = await callBackend('POST', '/api/devices', {}, accessToken);
  } catch (err) {
    console.error('Discovery failed:', err.message);
    return buildErrorResponse(event, 'INTERNAL_ERROR', err.message);
  }

  const alexaEndpoints = [];
  const deviceMap = devicesRaw?.data?.devices || {};

  for (const [id, device] of Object.entries(deviceMap)) {
    const type = device.metadata?.type?.toLowerCase() || 'light';
    const capabilities = buildCapabilities(type);

    alexaEndpoints.push({
      endpointId:        device.id,
      friendlyName:      device.name,
      description:       `${type} in your home`,
      manufacturerName:  'Smart Home',
      displayCategories: [mapTypeToCategory(type)],
      capabilities,
    });
  }

  return {
    event: {
      header: {
        namespace:      'Alexa.Discovery',
        name:           'Discover.Response',
        payloadVersion: '3',
        messageId:      generateMessageId(),
      },
      payload: { endpoints: alexaEndpoints },
    },
  };
}

// ── Power Control (On / Off) ──────────────────────────────────────────────────
async function handlePowerControl(event) {
  const { endpointId, scope }       = event.directive.endpoint;
  const { name: directiveName }     = event.directive.header;
  const accessToken                 = scope.token;

  const utterance = directiveName === 'TurnOn' ? 'turn on' : 'turn off';

  try {
    await callBackend('POST', '/api/device/control', { deviceId: endpointId, utterance }, accessToken);
  } catch (err) {
    return buildErrorResponse(event, 'ENDPOINT_UNREACHABLE', err.message);
  }

  const powerState = directiveName === 'TurnOn' ? 'ON' : 'OFF';

  return buildResponse(event, [
    buildProperty('Alexa.PowerController', 'powerState', powerState),
  ]);
}

// ── Brightness Control ────────────────────────────────────────────────────────
async function handleBrightness(event) {
  const { endpointId, scope }   = event.directive.endpoint;
  const { name: directiveName } = event.directive.header;
  const accessToken             = scope.token;
  const payload                 = event.directive.payload;

  let brightness;
  let utterance;

  if (directiveName === 'SetBrightness') {
    brightness = payload.brightness; // 0-100
    utterance  = `set to ${brightness}%`;
  } else if (directiveName === 'AdjustBrightness') {
    const delta = payload.brightnessDelta;
    utterance   = delta > 0 ? `brighten by ${delta}%` : `dim by ${Math.abs(delta)}%`;
    brightness  = Math.max(0, Math.min(100, 50 + delta)); // approximate
  }

  try {
    await callBackend('POST', '/api/device/control', {
      deviceId:  endpointId,
      utterance,
      params: { brightness },
    }, accessToken);
  } catch (err) {
    return buildErrorResponse(event, 'ENDPOINT_UNREACHABLE', err.message);
  }

  return buildResponse(event, [
    buildProperty('Alexa.BrightnessController', 'brightness', brightness),
  ]);
}

// ── Color Temperature Control ─────────────────────────────────────────────────
async function handleColorTemperature(event) {
  const { endpointId, scope } = event.directive.endpoint;
  const accessToken           = scope.token;
  const payload               = event.directive.payload;
  const { name }              = event.directive.header;

  let kelvin;
  let utterance;

  if (name === 'SetColorTemperature') {
    kelvin    = payload.colorTemperatureInKelvin;
    utterance = kelvin < 4000 ? 'set warm white' : kelvin > 5500 ? 'set cool white' : 'set neutral white';
  } else if (name === 'IncreaseColorTemperature') {
    utterance = 'set cool white';
    kelvin    = 6500;
  } else {
    utterance = 'set warm white';
    kelvin    = 2700;
  }

  try {
    await callBackend('POST', '/api/device/control', {
      deviceId:  endpointId,
      utterance,
      params: { colorTemperature: kelvin },
    }, accessToken);
  } catch (err) {
    return buildErrorResponse(event, 'ENDPOINT_UNREACHABLE', err.message);
  }

  return buildResponse(event, [
    buildProperty('Alexa.ColorTemperatureController', 'colorTemperatureInKelvin', kelvin),
  ]);
}

// ── Report State ──────────────────────────────────────────────────────────────
async function handleReportState(event) {
  // For now return a basic state — enhance with a real device status endpoint if available
  return buildResponse(event, [
    buildProperty('Alexa.PowerController', 'powerState', 'ON'),
    buildProperty('Alexa.EndpointHealth', 'connectivity', { value: 'OK' }),
  ], 'StateReport');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function callBackend(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(OAUTH_BACKEND + path);
    const data = JSON.stringify(body);

    const req = https.request({
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Backend error ${res.statusCode}: ${raw}`));
        }
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function buildCapabilities(deviceType) {
  const base = [
    { type: 'AlexaInterface', interface: 'Alexa',              version: '3' },
    { type: 'AlexaInterface', interface: 'Alexa.EndpointHealth', version: '3',
      properties: { supported: [{ name: 'connectivity' }], retrievable: true, proactivelyReported: false } },
    { type: 'AlexaInterface', interface: 'Alexa.PowerController', version: '3',
      properties: { supported: [{ name: 'powerState' }], retrievable: true, proactivelyReported: false } },
  ];

  if (['light', 'dimmer', 'lamp'].includes(deviceType)) {
    base.push(
      { type: 'AlexaInterface', interface: 'Alexa.BrightnessController', version: '3',
        properties: { supported: [{ name: 'brightness' }], retrievable: false, proactivelyReported: false } },
      { type: 'AlexaInterface', interface: 'Alexa.ColorTemperatureController', version: '3',
        properties: { supported: [{ name: 'colorTemperatureInKelvin' }], retrievable: false, proactivelyReported: false } }
    );
  }

  return base;
}

function mapTypeToCategory(type) {
  const map = {
    light:  'LIGHT',
    switch: 'SWITCH',
    fan:    'FAN',
    lock:   'SMARTLOCK',
    plug:   'SMARTPLUG',
    camera: 'CAMERA',
    sensor: 'MOTION_SENSOR',
    thermostat: 'THERMOSTAT',
  };
  return map[type] || 'OTHER';
}

function buildProperty(namespace, name, value) {
  return {
    namespace,
    name,
    value,
    timeOfSample:            new Date().toISOString(),
    uncertaintyInMilliseconds: 500,
  };
}

function buildResponse(event, properties, responseName = 'Response') {
  return {
    context: { properties },
    event: {
      header: {
        namespace:      'Alexa',
        name:           responseName,
        payloadVersion: '3',
        messageId:      generateMessageId(),
        correlationToken: event.directive.header.correlationToken,
      },
      endpoint: event.directive.endpoint,
      payload:  {},
    },
  };
}

function buildErrorResponse(event, type, message) {
  return {
    event: {
      header: {
        namespace:      'Alexa',
        name:           'ErrorResponse',
        payloadVersion: '3',
        messageId:      generateMessageId(),
        correlationToken: event.directive?.header?.correlationToken,
      },
      endpoint: event.directive?.endpoint,
      payload:  { type, message },
    },
  };
}

function generateMessageId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}