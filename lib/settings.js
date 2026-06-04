// Load/save dashboard-editable settings from /config/settings.json, and merge
// them over the NF app `config`. Values set in the dashboard take precedence
// over the static config options (which in turn fall back to code defaults).
// This lets the webhook + thresholds be edited from the dashboard with no
// restart — the hooks read the merged config fresh on every run.

const fs = require("fs");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "..", "config", "settings.json");

const KEYS = [
  "slackWebhookUrl", "siteLabel", "silentMinutes", "freshnessHours",
  "errorRateThreshold", "includeYellow", "fleetErrorJump", "fleetErrorFraction",
  "memThresholdPct", "diskThresholdPct", "resourceRealertHours",
];

function load() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) || {}; }
  catch (_) { return {}; }
}

// Persist only known, non-empty keys (empty → fall back to config/defaults).
function save(obj) {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const clean = {};
  for (const k of KEYS) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== "") clean[k] = obj[k];
  }
  const tmp = `${SETTINGS_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
  return clean;
}

// File values override nf config (only when the file value is non-empty).
function merged(nfConfig) {
  const file = load();
  const out = Object.assign({}, nfConfig || {});
  for (const k of KEYS) {
    if (file[k] !== undefined && file[k] !== null && file[k] !== "") out[k] = file[k];
  }
  return out;
}

module.exports = { load, save, merged, SETTINGS_PATH, KEYS };
