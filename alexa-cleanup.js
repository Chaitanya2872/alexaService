#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright');

const DEFAULT_REPORT_PATH = path.join(process.cwd(), 'cleanup-report.json');
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BROWSER = 'chrome';
const DEFAULT_URLS = [
  'https://alexa.amazon.com/spa/index.html#devices/smart-home',
  'https://alexa.amazon.in/spa/index.html#devices/smart-home',
  'https://www.amazon.com/alexasmarthome',
];

const LIST_READY_SELECTORS = [
  '[data-testid="device-list"]',
  '[data-test-id="device-list"]',
  '[data-test-id*="device"]',
  '[data-testid*="device"]',
  '[aria-label*="device" i]',
  'div[role="list"]',
  'main',
];

const DEVICE_CARD_SELECTORS = [
  '[data-testid*="device-card"]',
  '[data-test-id*="device-card"]',
  '[data-testid*="device-item"]',
  '[data-test-id*="device-item"]',
  '[data-testid*="device-row"]',
  '[data-test-id*="device-row"]',
  '[data-card-type="device"]',
  '[role="listitem"]',
  'section article',
  'main article',
  'main li',
];

const NAME_SELECTORS = [
  '[data-testid*="device-name"]',
  '[data-test-id*="device-name"]',
  '[aria-label*="device name" i]',
  'h1',
  'h2',
  'h3',
  'header',
  '[role="heading"]',
  'strong',
];

const TYPE_SELECTORS = [
  '[data-testid*="device-type"]',
  '[data-test-id*="device-type"]',
  '[aria-label*="type" i]',
  '[data-testid*="category"]',
  '[data-test-id*="category"]',
];

const ROOM_SELECTORS = [
  '[data-testid*="room"]',
  '[data-test-id*="room"]',
  '[aria-label*="room" i]',
  '[aria-label*="group" i]',
];

const DELETE_BUTTON_SELECTORS = [
  'button:has-text("Delete")',
  'button:has-text("Remove")',
  '[role="button"]:has-text("Delete")',
  '[role="button"]:has-text("Remove")',
  'button[aria-label*="Delete" i]',
  'button[aria-label*="Remove" i]',
];

const MENU_BUTTON_SELECTORS = [
  'button[aria-label*="More" i]',
  'button[aria-label*="Actions" i]',
  'button[aria-label*="Options" i]',
  '[role="button"][aria-haspopup="menu"]',
];

const DIALOG_CONFIRM_SELECTORS = [
  'button:has-text("Delete")',
  'button:has-text("Remove")',
  'button:has-text("Confirm")',
  'button:has-text("Yes")',
];

const ALEXA_DEVICE_MARKERS = [
  'echo',
  'alexa',
  'fire tv',
  'firetv',
  'kindle',
  'amazon tap',
  'amazon smart plug',
];

function printUsage() {
  console.log(`
Alexa Smart Home cleanup utility

Usage:
  node alexa-cleanup.js --dry-run
  node alexa-cleanup.js --delete --name-contains "Hive"
  node alexa-cleanup.js --delete --skip-name-contains "Main"
  node alexa-cleanup.js --delete --all

Options:
  --dry-run                    List devices only. Default mode.
  --delete                     Delete matching devices.
  --all                        Select all matched devices.
  --name-contains <text>       Only include device names containing text.
  --type <text>                Only include device type/category containing text.
  --skip-name-contains <text>  Exclude device names containing text.
  --include-alexa-devices      Allow deleting Echo/Alexa/Amazon devices.
  --delay-ms <number>          Delay between deletions. Default: ${DEFAULT_DELAY_MS}
  --browser <chrome|edge|chromium>
  --user-data-dir <path>       Existing Chrome/Edge profile root to reuse.
  --profile-directory <name>   Profile directory inside the user data dir, e.g. "Default".
  --url <url>                  Override the Alexa web page URL.
  --report <path>              Output report path. Default: cleanup-report.json
  --timeout-ms <number>        Selector/navigation timeout. Default: ${DEFAULT_TIMEOUT_MS}
  --help                       Show this help.
`);
}

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    deleteAll: false,
    includeAlexaDevices: false,
    delayMs: DEFAULT_DELAY_MS,
    browser: DEFAULT_BROWSER,
    userDataDir: null,
    profileDirectory: null,
    url: null,
    reportPath: DEFAULT_REPORT_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    filters: {
      nameContains: null,
      type: null,
      skipNameContains: null,
    },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--dry-run':
        options.mode = 'dry-run';
        break;
      case '--delete':
        options.mode = 'delete';
        break;
      case '--all':
        options.deleteAll = true;
        break;
      case '--include-alexa-devices':
        options.includeAlexaDevices = true;
        break;
      case '--name-contains':
        options.filters.nameContains = requireValue(arg, next);
        i += 1;
        break;
      case '--type':
        options.filters.type = requireValue(arg, next);
        i += 1;
        break;
      case '--skip-name-contains':
        options.filters.skipNameContains = requireValue(arg, next);
        i += 1;
        break;
      case '--delay-ms':
        options.delayMs = parsePositiveNumber(requireValue(arg, next), arg);
        i += 1;
        break;
      case '--browser':
        options.browser = requireValue(arg, next).toLowerCase();
        i += 1;
        break;
      case '--user-data-dir':
        options.userDataDir = path.resolve(requireValue(arg, next));
        i += 1;
        break;
      case '--profile-directory':
        options.profileDirectory = requireValue(arg, next);
        i += 1;
        break;
      case '--url':
        options.url = requireValue(arg, next);
        i += 1;
        break;
      case '--report':
        options.reportPath = path.resolve(requireValue(arg, next));
        i += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveNumber(requireValue(arg, next), arg);
        i += 1;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['chrome', 'edge', 'chromium'].includes(options.browser)) {
    throw new Error(`Unsupported browser "${options.browser}". Use chrome, edge, or chromium.`);
  }

  return options;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative number.`);
  }
  return parsed;
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function containsNormalized(haystack, needle) {
  return normalizeText(haystack).toLowerCase().includes(normalizeText(needle).toLowerCase());
}

function isLikelyAlexaDevice(device) {
  const combined = `${device.name} ${device.type}`.toLowerCase();
  return ALEXA_DEVICE_MARKERS.some((marker) => combined.includes(marker));
}

function createEmptyReport(options) {
  return {
    mode: options.mode,
    generatedAt: new Date().toISOString(),
    totalFound: 0,
    totalMatched: 0,
    totalDeleted: 0,
    failedDevices: [],
    skippedDevices: [],
    deletedDevices: [],
  };
}

async function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Report written to ${reportPath}`);
}

async function launchBrowser(options) {
  const channel = options.browser === 'edge' ? 'msedge' : options.browser === 'chrome' ? 'chrome' : undefined;
  const userDataDir = options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-cleanup-'));
  const launchOptions = {
    channel,
    headless: false,
    slowMo: 50,
    viewport: { width: 1440, height: 960 },
    args: [],
  };

  if (options.profileDirectory) {
    launchOptions.args.push(`--profile-directory=${options.profileDirectory}`);
  }

  const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
  context.__cleanupTempProfile = !options.userDataDir;
  context.__cleanupUserDataDir = userDataDir;
  return context;
}

async function cleanupBrowserContext(context) {
  const cleanupTempProfile = context.__cleanupTempProfile;
  const userDataDir = context.__cleanupUserDataDir;
  await context.close();
  if (cleanupTempProfile && userDataDir) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function ensurePage(context) {
  const existing = context.pages();
  if (existing.length > 0) return existing[0];
  return context.newPage();
}

async function gotoAnyAlexaPage(page, options) {
  const urls = options.url ? [options.url] : DEFAULT_URLS;
  let lastError = null;

  for (const url of urls) {
    try {
      console.log(`Opening ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: Math.min(options.timeoutMs, 8000) }).catch(() => {});
      return url;
    } catch (error) {
      lastError = error;
      console.warn(`Failed to open ${url}: ${error.message}`);
    }
  }

  throw lastError || new Error('Unable to open any Alexa page.');
}

async function promptForManualLogin(page, options) {
  console.log('If you are not already logged in, sign in manually in the browser window.');
  console.log('After login, navigate to the Smart Home devices page if needed, then press Enter here to continue.');

  const rl = readline.createInterface({ input, output });
  try {
    await rl.question('Press Enter after the devices page is visible: ');
  } finally {
    rl.close();
  }

  await page.waitForLoadState('networkidle', { timeout: options.timeoutMs }).catch(() => {});
}

async function waitForDevicesPage(page, options) {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const bodyText = normalizeText(await page.locator('body').innerText().catch(() => ''));
    const hasDeviceWords = /device|smart home|appliance|light|switch/i.test(bodyText);

    for (const selector of LIST_READY_SELECTORS) {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        if (hasDeviceWords) return true;
      }
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function findDeviceCards(page) {
  for (const selector of DEVICE_CARD_SELECTORS) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      return { selector, locator, count };
    }
  }

  return { selector: null, locator: null, count: 0 };
}

async function readTextFromSelectors(root, selectors) {
  for (const selector of selectors) {
    const locator = root.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const text = normalizeText(await locator.innerText().catch(() => ''));
    if (text) return text;
  }
  return '';
}

function inferTypeAndRoomFromText(textLines) {
  let type = '';
  let room = '';

  for (const line of textLines) {
    if (!type && /light|switch|plug|fan|thermostat|speaker|camera|echo|sensor/i.test(line)) {
      type = line;
    }
    if (!room && /room|group|kitchen|bedroom|office|hall|living|garage/i.test(line)) {
      room = line.replace(/^(room|group)\s*:?/i, '').trim();
    }
  }

  return { type, room };
}

async function listDeviceSummaries(page, options) {
  const list = await findDeviceCards(page);
  if (!list.count) return [];

  const devices = [];
  for (let i = 0; i < list.count; i += 1) {
    const card = list.locator.nth(i);
    if (!(await card.isVisible().catch(() => false))) continue;

    const cardText = normalizeText(await card.innerText().catch(() => ''));
    if (!cardText) continue;

    const lines = cardText.split(/\n+/).map(normalizeText).filter(Boolean);
    const name = normalizeText(await readTextFromSelectors(card, NAME_SELECTORS)) || lines[0] || `Device ${i + 1}`;
    const explicitType = normalizeText(await readTextFromSelectors(card, TYPE_SELECTORS));
    const explicitRoom = normalizeText(await readTextFromSelectors(card, ROOM_SELECTORS));
    const inferred = inferTypeAndRoomFromText(lines.slice(1));
    const type = explicitType || inferred.type || 'Unknown';
    const room = explicitRoom || inferred.room || '';

    devices.push({
      index: i,
      name,
      type,
      room,
      cardText,
      canDelete: null,
      isAlexaDevice: isLikelyAlexaDevice({ name, type }),
      deleteReason: '',
    });
  }

  return dedupeDevices(devices);
}

function dedupeDevices(devices) {
  const seen = new Set();
  const deduped = [];

  for (const device of devices) {
    const key = `${device.name.toLowerCase()}|${device.type.toLowerCase()}|${device.room.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(device);
  }

  return deduped;
}

async function openDeviceFromList(page, device) {
  const list = await findDeviceCards(page);
  if (!list.count || device.index >= list.count) {
    throw new Error(`Device index ${device.index} is no longer available in the list.`);
  }

  const card = list.locator.nth(device.index);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.click({ timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

async function clickAny(pageOrLocator, selectors) {
  for (const selector of selectors) {
    const locator = pageOrLocator.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    await locator.click();
    return true;
  }
  return false;
}

async function inspectDeleteCapability(page, device) {
  const result = { canDelete: false, deleteReason: 'Delete action not visible' };

  try {
    await openDeviceFromList(page, device);

    const directDelete = await clickAny(page, DELETE_BUTTON_SELECTORS);
    if (directDelete) {
      result.canDelete = true;
      result.deleteReason = 'Delete button visible';
      await dismissDialog(page);
      return result;
    }

    const openedMenu = await clickAny(page, MENU_BUTTON_SELECTORS);
    if (openedMenu) {
      const deleteInMenu = await clickAny(page, DELETE_BUTTON_SELECTORS);
      if (deleteInMenu) {
        result.canDelete = true;
        result.deleteReason = 'Delete action available in menu';
        await dismissDialog(page);
        return result;
      }
    }
  } catch (error) {
    result.deleteReason = error.message;
  } finally {
    await navigateBackToList(page);
  }

  return result;
}

async function dismissDialog(page) {
  await page.keyboard.press('Escape').catch(() => {});
  const cancelButtons = ['button:has-text("Cancel")', 'button:has-text("No")', 'button:has-text("Close")'];
  await clickAny(page, cancelButtons).catch(() => {});
  await page.waitForTimeout(300);
}

async function navigateBackToList(page) {
  const backClicked = await clickAny(page, [
    'button[aria-label*="Back" i]',
    'a[aria-label*="Back" i]',
    '[role="button"]:has-text("Back")',
  ]).catch(() => false);

  if (!backClicked) {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
  }

  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

function applyFilters(devices, options, report) {
  const matched = [];

  for (const device of devices) {
    const reasons = [];

    if (options.filters.nameContains && !containsNormalized(device.name, options.filters.nameContains)) {
      reasons.push(`name does not contain "${options.filters.nameContains}"`);
    }
    if (options.filters.type && !containsNormalized(device.type, options.filters.type)) {
      reasons.push(`type does not contain "${options.filters.type}"`);
    }
    if (options.filters.skipNameContains && containsNormalized(device.name, options.filters.skipNameContains)) {
      reasons.push(`name matches skip filter "${options.filters.skipNameContains}"`);
    }
    if (device.isAlexaDevice && !options.includeAlexaDevices) {
      reasons.push('protected Alexa/Amazon device');
    }

    if (reasons.length > 0) {
      report.skippedDevices.push({
        name: device.name,
        type: device.type,
        room: device.room,
        reason: reasons.join('; '),
      });
      continue;
    }

    matched.push(device);
  }

  return matched;
}

function printDryRun(devices) {
  if (!devices.length) {
    console.log('No devices found.');
    return;
  }

  console.log(`Found ${devices.length} device(s):`);
  for (const device of devices) {
    console.log(`- Name: ${device.name}`);
    console.log(`  Type: ${device.type}`);
    console.log(`  Room/Group: ${device.room || 'N/A'}`);
    console.log(`  Deletable: ${device.canDelete ? 'yes' : 'no'}${device.deleteReason ? ` (${device.deleteReason})` : ''}`);
  }
}

async function confirmDeletion(devices, options) {
  if (!devices.length) return false;

  console.log(`Delete mode matched ${devices.length} device(s).`);
  if (!options.deleteAll) {
    console.log('Tip: pass --all if you intend to target all matched devices.');
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question('Type DELETE to continue: ')).trim();
    return answer === 'DELETE';
  } finally {
    rl.close();
  }
}

async function confirmPerDevice(device) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`Delete "${device.name}" (${device.type})? [y/N]: `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

async function deleteDevice(page, device, options) {
  await openDeviceFromList(page, device);

  let deleteTriggered = await clickAny(page, DELETE_BUTTON_SELECTORS);
  if (!deleteTriggered) {
    const openedMenu = await clickAny(page, MENU_BUTTON_SELECTORS);
    if (openedMenu) {
      deleteTriggered = await clickAny(page, DELETE_BUTTON_SELECTORS);
    }
  }

  if (!deleteTriggered) {
    throw new Error('Delete action was not available.');
  }

  const confirmed = await clickAny(page, DIALOG_CONFIRM_SELECTORS);
  if (!confirmed) {
    throw new Error('Delete confirmation button was not available.');
  }

  await page.waitForTimeout(options.delayMs);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const report = createEmptyReport(options);
  let context;

  try {
    if (
      options.mode === 'delete' &&
      !options.deleteAll &&
      !options.filters.nameContains &&
      !options.filters.type &&
      !options.filters.skipNameContains
    ) {
      throw new Error('Delete mode without filters requires --all.');
    }

    context = await launchBrowser(options);
    const page = await ensurePage(context);

    await gotoAnyAlexaPage(page, options);
    await promptForManualLogin(page, options);

    const detected = await waitForDevicesPage(page, options);
    if (!detected) {
      throw new Error('Could not confirm the Alexa devices page. Refusing to continue.');
    }

    const devices = await listDeviceSummaries(page, options);
    report.totalFound = devices.length;

    if (devices.length === 0) {
      throw new Error('No devices were found. Refusing to continue.');
    }

    for (const device of devices) {
      const inspection = await inspectDeleteCapability(page, device);
      device.canDelete = inspection.canDelete;
      device.deleteReason = inspection.deleteReason;
    }

    const matched = applyFilters(devices, options, report);
    report.totalMatched = matched.length;

    printDryRun(matched);

    if (options.mode !== 'delete') {
      await writeReport(options.reportPath, report);
      return;
    }

    if (!matched.length) {
      throw new Error('No devices matched the requested filters. Refusing to continue.');
    }

    const confirmed = await confirmDeletion(matched, options);
    if (!confirmed) {
      console.log('Deletion canceled.');
      await writeReport(options.reportPath, report);
      return;
    }

    for (const device of matched) {
      if (!device.canDelete) {
        report.failedDevices.push({
          name: device.name,
          type: device.type,
          room: device.room,
          reason: device.deleteReason || 'Device is not deletable from the current UI.',
        });
        continue;
      }

      const perDeviceConfirmed = await confirmPerDevice(device);
      if (!perDeviceConfirmed) {
        report.skippedDevices.push({
          name: device.name,
          type: device.type,
          room: device.room,
          reason: 'Skipped by operator confirmation.',
        });
        continue;
      }

      try {
        await deleteDevice(page, device, options);
        report.totalDeleted += 1;
        report.deletedDevices.push({
          name: device.name,
          type: device.type,
          room: device.room,
        });
        console.log(`Deleted: ${device.name}`);
      } catch (error) {
        report.failedDevices.push({
          name: device.name,
          type: device.type,
          room: device.room,
          reason: error.message,
        });
        console.error(`Failed to delete ${device.name}: ${error.message}`);
      }
    }

    await writeReport(options.reportPath, report);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    await writeReport(options.reportPath, report);
    process.exitCode = 1;
  } finally {
    if (context) {
      await cleanupBrowserContext(context).catch((error) => {
        console.warn(`Browser cleanup warning: ${error.message}`);
      });
    }
  }
}

run();
