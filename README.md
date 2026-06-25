# Alexa Smart Home Cleanup Tool

Local-only Node.js utility for listing and bulk deleting old Alexa Smart Home devices from your own Amazon developer/test account through browser automation.

This is not an official Amazon API. It drives the Alexa web UI with Playwright.

## Safety

- Default mode is `dry-run`.
- The script does not ask for or store Amazon credentials.
- You can reuse an existing Chrome/Edge profile or log in manually in the opened browser window.
- Echo/Alexa/Amazon devices are protected by default.
- The script refuses to delete when no devices are found or when the page cannot be detected.

## Setup

1. Install dependencies:

```bash
npm install
```

2. If you want to use Playwright's bundled Chromium, install it once:

```bash
npx playwright install chromium
```

If you use local Chrome or Edge with `--browser chrome` or `--browser edge`, that browser must already be installed.

## Run

Dry run is the default:

```bash
node alexa-cleanup.js --dry-run
```

Delete matching devices:

```bash
node alexa-cleanup.js --delete --all
```

The browser opens locally. If the Alexa devices page is not already logged in, sign in manually in that window and then continue in the terminal.

## Existing Browser Profile

Reuse an existing Chrome or Edge profile:

```bash
node alexa-cleanup.js --dry-run --browser chrome --user-data-dir "C:\Users\you\AppData\Local\Google\Chrome\User Data" --profile-directory "Default"
```

Edge example:

```bash
node alexa-cleanup.js --dry-run --browser edge --user-data-dir "C:\Users\you\AppData\Local\Microsoft\Edge\User Data" --profile-directory "Default"
```

If you omit `--user-data-dir`, the tool opens a temporary local browser profile and lets you log in manually.

## Examples

Dry run:

```bash
node alexa-cleanup.js --dry-run
```

Delete all matched devices:

```bash
node alexa-cleanup.js --delete --all
```

Delete devices whose names contain `Hive`:

```bash
node alexa-cleanup.js --delete --name-contains "Hive"
```

Delete all matched devices except names containing `Main`:

```bash
node alexa-cleanup.js --delete --all --skip-name-contains "Main"
```

Delete only a type/category:

```bash
node alexa-cleanup.js --delete --all --type "Light"
```

Allow deletion of Alexa/Amazon devices explicitly:

```bash
node alexa-cleanup.js --delete --all --include-alexa-devices
```

## Output

The tool writes `cleanup-report.json` in the current working directory by default.

The report contains:

- `totalFound`
- `totalMatched`
- `totalDeleted`
- `failedDevices`
- `skippedDevices`
- `deletedDevices`

Override the path if needed:

```bash
node alexa-cleanup.js --dry-run --report ".\reports\cleanup-report.json"
```

## Notes

- This tool depends on the current Alexa web UI structure, so selectors may need adjustment if Amazon changes the page.
- Review the dry-run output before using delete mode.
- Delete mode asks for a global confirmation and then a per-device confirmation before each deletion.
