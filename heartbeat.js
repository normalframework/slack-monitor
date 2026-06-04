// Daily heartbeat.
//
// Runs once a day (no point bindings). Posts a Slack summary covering:
//   - Active points: how many of the site's points received data within the
//     freshness window (the headline "points that got data" metric), with a
//     day-over-day delta.
//   - Fleet rollup: device counts by reporting / silent / erroring, by protocol.
//   - Error totals over the window.
//   - Host: memory % + disk %.
//   - Devices needing attention.
//
// Also persists a rich snapshot to /config/.heartbeat-state.json so the
// dashboard can show the last scan instantly without re-scanning every point.
//
// Fully config-driven (dashboard settings merged over app config); nothing
// site-specific is hardcoded.

const fs = require("fs");
const path = require("path");
const diag = require("./lib/diag");
const slack = require("./lib/slack");
const settings = require("./lib/settings");

const STATE_FILE = path.join(__dirname, "config", ".heartbeat-state.json");

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) { return null; }
}
function writeState(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { /* best-effort */ }
}

module.exports = async ({ sdk, config }) => {
  const cfg = settings.merged(config);
  const webhook = diag.cfgStr(cfg, "slackWebhookUrl", "");
  const freshnessHours = diag.cfgNum(cfg, "freshnessHours", 24);
  const freshnessMs = freshnessHours * 3600 * 1000;
  const opt = {
    silentMs: diag.cfgNum(cfg, "silentMinutes", 30) * 60 * 1000,
    errorRateThreshold: diag.cfgNum(cfg, "errorRateThreshold", 0.1),
    includeYellow: diag.cfgBool(cfg, "includeYellow", false),
  };
  const siteLabel = diag.cfgStr(cfg, "siteLabel", "");

  // Point-level activity (the "points that got data" headline).
  let points = { total: 0, active: 0, stale: 0, novalue: 0 };
  try { points = await diag.scanPointFreshness(sdk, freshnessMs, "default"); }
  catch (e) { sdk.logEvent(`heartbeat: point scan failed: ${e.message}`); }

  // Fleet + system diagnostics.
  let devices = [], errs = { counts: {}, deviceErrors: [] }, sys = {};
  try { devices = await diag.getDeviceStatus(sdk); }
  catch (e) { sdk.logEvent(`heartbeat: devicestatus failed: ${e.message}`); }
  try { errs = await diag.getErrorSummary(sdk, freshnessHours * 3600); }
  catch (e) { sdk.logEvent(`heartbeat: errorsummary failed: ${e.message}`); }
  try { sys = await diag.getSystemInfo(sdk); }
  catch (e) { sdk.logEvent(`heartbeat: platform/info failed: ${e.message}`); }

  const now = Date.now();
  const site = siteLabel || sys.siteName || "site";
  const td = diag.topDisk(sys);

  // Fleet rollup, split by protocol. Liveness and health counted independently.
  let reporting = 0, silent = 0, erroring = 0;
  const byProto = {};
  const attention = [];
  for (const d of devices) {
    const c = diag.classifyDevice(d, opt);
    const proto = diag.protocolOf(d);
    const pp = byProto[proto] || (byProto[proto] = { total: 0, reporting: 0 });
    pp.total++;
    if (c.silent) silent++;
    else { reporting++; pp.reporting++; }
    if (c.erroring) erroring++;
    if (c.silent || c.erroring) {
      const tags = [];
      if (c.erroring) tags.push(`erroring${c.errorStatus && c.errorStatus !== "GREEN" ? ` ${c.errorStatus}` : ""}${c.rate ? ` (rate ${c.rate.toFixed(2)})` : ""}`);
      if (c.silent) tags.push(`silent ${diag.humanAge(c.alive ? now - c.alive : Infinity)}`);
      attention.push(`• *${d.deviceName || d.deviceId}* — ${tags.join(", ")}`);
    }
  }

  // Day-over-day delta on active points.
  const prev = readState();
  const prevActive = prev && prev.points && typeof prev.points.active === "number" ? prev.points.active : null;
  let delta = "";
  if (prevActive !== null) {
    const dd = points.active - prevActive;
    delta = dd === 0 ? "(no change)" : dd > 0 ? `(▲ +${diag.commas(dd)})` : `(▼ ${diag.commas(dd)})`;
  }

  const errorsTop = Object.entries(errs.counts || {})
    .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 6)
    .map(([k, v]) => [k, Number(v)]);

  // Rich snapshot for the dashboard.
  writeState({
    ts: new Date(now).toISOString(),
    site,
    freshnessHours,
    points,
    fleet: { total: devices.length, reporting, silent, erroring },
    byProto,
    errorsTop,
    host: {
      memPct: sys.mem ? sys.mem.usedPct : null,
      disk: td ? { mount: td.mount, usedPct: td.usedPct, freeBytes: td.freeBytes } : null,
    },
  });

  const activePct = points.total ? Math.round((points.active / points.total) * 100) : 0;
  const lines = [
    `*Points with data (last ${freshnessHours}h):* ${diag.commas(points.active)} / ${diag.commas(points.total)} (${activePct}%) ${delta}`,
    `*Idle:* ${diag.commas(points.stale)} stale · ${diag.commas(points.novalue)} no value yet`,
    `*Devices:* ${devices.length} total · ${reporting} reporting · ${silent} silent · ${erroring} erroring`,
    Object.keys(byProto).length
      ? `*By protocol:* ` + Object.entries(byProto).map(([k, v]) => `${k} ${v.reporting}/${v.total} reporting`).join(" · ")
      : null,
    sys.mem ? `*Host:* mem ${sys.mem.usedPct}%${td ? ` · disk ${td.usedPct}% (${td.mount}, ${diag.gb(td.freeBytes)} free)` : ""}` : null,
    diag.topErrorTypes(errs, 5) ? `*Errors (${freshnessHours}h):* ${diag.topErrorTypes(errs, 5)}` : null,
  ];
  if (attention.length) {
    lines.push("*Needs attention:*");
    lines.push(...attention.slice(0, 8));
    if (attention.length > 8) lines.push(`…and ${attention.length - 8} more`);
  }

  const color = erroring > 0 || silent > 0 ? slack.COLORS.yellow : slack.COLORS.green;
  const r = await slack.post(sdk, webhook, {
    text: `:bar_chart: Daily heartbeat — *${site}* — ${diag.commas(points.active)} active points`,
    attachments: [slack.attachment(color, `Daily heartbeat — ${site}`, lines, diag.footerLine(sys))],
  });
  sdk.logEvent(`heartbeat: active=${points.active}/${points.total} (${activePct}%), devices=${devices.length}, silent=${silent}, erroring=${erroring} → slack ${r.ok ? "sent" : (r.skipped || "FAILED")}`);
  return { ok: true, active: points.active, total: points.total, devices: devices.length, silent, erroring };
};
