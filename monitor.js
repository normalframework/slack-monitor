// Device + fleet + host-resource transition monitor.
//
// Runs on a short interval (default every 5 min, no point bindings). Each run:
//   1. Pulls fleet diagnostics (devicestatus + errorsummary + platform/info).
//   2. Classifies every device on two INDEPENDENT axes:
//        - liveness: live (reporting) vs silent (no data within silentMinutes)
//        - health:   ok vs erroring (errorStatus RED, or rate over threshold)
//   3. Checks host resources (memory %, disk %) against thresholds.
//   4. Diffs against the previous run's state (persisted to a local file).
//   5. Emits a SINGLE Slack message summarizing every transition this run
//      (storm-proof), plus fleet-level and host-resource alerts.
//
// Resource alerts use hysteresis (clear 2% under the threshold) and re-alert
// every resourceRealertHours while a condition persists, so an ongoing problem
// stays visible without spamming each interval.
//
// Nothing is site-specific; thresholds come from config (dashboard settings
// merged over app config) with safe defaults.

const fs = require("fs");
const path = require("path");
const diag = require("./lib/diag");
const slack = require("./lib/slack");
const settings = require("./lib/settings");

const STATE_FILE = path.join(__dirname, "config", ".monitor-state.json");

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (_) { return null; }
}
function writeState(s) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${STATE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { /* best-effort persistence */ }
}

function deviceLine(c, reason, now) {
  const bits = [`*${c.name}*`, c.protocol, `→ ${reason}`];
  if (!c.live) bits.push(`last data ${diag.humanAge(c.alive ? now - c.alive : Infinity)} ago`);
  if (c.errorStatus && c.errorStatus !== "GREEN") bits.push(`status ${c.errorStatus}`);
  if (c.rate) bits.push(`err rate ${c.rate.toFixed(2)}`);
  return "• " + bits.join("  ·  ");
}

// Resource transition with hysteresis + periodic re-alert.
// Returns { state: { alerting, lastTs }, kind: "problem"|"recover"|null }.
function resourceEvent(prevR, pct, thr, now, realertMs) {
  const p = prevR || { alerting: false, lastTs: 0 };
  if (pct == null) return { state: p, kind: null };
  const was = !!p.alerting;
  const is = was ? pct >= thr - 2 : pct >= thr;
  if (!was && is) return { state: { alerting: true, lastTs: now }, kind: "problem" };
  if (was && is) {
    if (now - (p.lastTs || 0) >= realertMs) return { state: { alerting: true, lastTs: now }, kind: "problem" };
    return { state: { alerting: true, lastTs: p.lastTs || now }, kind: null };
  }
  if (was && !is) return { state: { alerting: false, lastTs: 0 }, kind: "recover" };
  return { state: { alerting: false, lastTs: 0 }, kind: null };
}

module.exports = async ({ sdk, config }) => {
  const cfg = settings.merged(config);
  const webhook = diag.cfgStr(cfg, "slackWebhookUrl", "");
  const opt = {
    silentMs: diag.cfgNum(cfg, "silentMinutes", 30) * 60 * 1000,
    errorRateThreshold: diag.cfgNum(cfg, "errorRateThreshold", 0.1),
    includeYellow: diag.cfgBool(cfg, "includeYellow", false),
  };
  const fleetJump = diag.cfgNum(cfg, "fleetErrorJump", 3);
  const fleetFraction = diag.cfgNum(cfg, "fleetErrorFraction", 0.5);
  const memThr = diag.cfgNum(cfg, "memThresholdPct", 90);
  const diskThr = diag.cfgNum(cfg, "diskThresholdPct", 90);
  const realertMs = diag.cfgNum(cfg, "resourceRealertHours", 6) * 3600 * 1000;
  const siteLabel = diag.cfgStr(cfg, "siteLabel", "");

  // Gather diagnostics — tolerate partial failures (tunnels can drop).
  let devices = [], errs = { counts: {}, deviceErrors: [] }, sys = {};
  try { devices = await diag.getDeviceStatus(sdk); }
  catch (e) { sdk.logEvent(`monitor: devicestatus failed: ${e.message}`); }
  try { errs = await diag.getErrorSummary(sdk, 3600); }
  catch (e) { sdk.logEvent(`monitor: errorsummary failed: ${e.message}`); }
  try { sys = await diag.getSystemInfo(sdk); }
  catch (e) { sdk.logEvent(`monitor: platform/info failed: ${e.message}`); }

  if (!devices.length) {
    sdk.logEvent("monitor: no devices returned — skipping (no state change)");
    return { ok: false, error: "no devices" };
  }

  const site = siteLabel || sys.siteName || "site";
  const now = Date.now();
  const memPct = sys.mem ? sys.mem.usedPct : null;
  const td = diag.topDisk(sys);
  const diskPct = td ? td.usedPct : null;

  // Classify current fleet on both axes.
  const cur = {};
  let erroringCount = 0, silentCount = 0;
  for (const d of devices) {
    const c = diag.classifyDevice(d, opt);
    if (c.erroring) erroringCount++;
    if (c.silent) silentCount++;
    cur[diag.deviceKey(d)] = {
      name: d.deviceName || d.deviceId || diag.deviceKey(d),
      protocol: diag.protocolOf(d),
      live: !c.silent,
      erroring: c.erroring,
      errorStatus: c.errorStatus,
      rate: c.rate,
      alive: c.alive,
    };
  }
  const total = devices.length;
  const prev = readState();

  // First run: establish a baseline and announce that monitoring is live.
  // Resource state starts "not alerting" so any current over-threshold
  // condition surfaces on the next interval instead of being silently adopted.
  if (!prev || !prev.devices) {
    writeState({
      ts: new Date(now).toISOString(), total, erroringCount, silentCount, devices: cur,
      resources: { mem: { alerting: false, lastTs: 0 }, disk: { alerting: false, lastTs: 0 } },
    });
    const lines = [
      `Monitoring *${total}* devices — ${erroringCount} erroring, ${silentCount} silent, ${total - silentCount} reporting.`,
      memPct != null ? `Host: mem ${memPct}%${td ? `, disk ${diskPct}% (${td.mount})` : ""}` : null,
      diag.topErrorTypes(errs) ? `Errors (1h): ${diag.topErrorTypes(errs)}` : null,
    ];
    await slack.post(sdk, webhook, {
      text: `:satellite_antenna: Site Monitor online — *${site}*`,
      attachments: [slack.attachment(slack.COLORS.blue, `Monitoring online — ${site}`, lines, diag.footerLine(sys))],
    });
    sdk.logEvent(`monitor: baseline established (${total} devices, ${erroringCount} erroring, ${silentCount} silent, mem ${memPct}%, disk ${diskPct}%)`);
    return { ok: true, baseline: true, total, erroringCount, silentCount, memPct, diskPct };
  }

  // Diff each device against previous run on both axes.
  const problems = [], recoveries = [];
  for (const key of Object.keys(cur)) {
    const c = cur[key];
    const p = prev.devices[key] || { live: true, erroring: false };
    if (p.live && !c.live) problems.push(deviceLine(c, "SILENT (no data)", now));
    if (!p.live && c.live) recoveries.push(deviceLine(c, "back online", now));
    if (!p.erroring && c.erroring) problems.push(deviceLine(c, "ERRORING", now));
    if (p.erroring && !c.erroring) recoveries.push(deviceLine(c, "errors cleared", now));
  }

  // Host-resource transitions.
  const prevRes = prev.resources || {};
  const memEv = resourceEvent(prevRes.mem, memPct, memThr, now, realertMs);
  const diskEv = resourceEvent(prevRes.disk, diskPct, diskThr, now, realertMs);
  const resProblems = [], resRecoveries = [];
  if (memEv.kind === "problem") resProblems.push(`• *Memory* ${memPct}% used (${diag.gb(sys.mem.usedBytes)} / ${diag.gb(sys.mem.totalBytes)}) — over ${memThr}%`);
  if (memEv.kind === "recover") resRecoveries.push(`• *Memory* back under threshold — ${memPct}% used`);
  if (diskEv.kind === "problem") resProblems.push(`• *Disk ${td.mount}* ${diskPct}% used (${diag.gb(td.usedBytes)} / ${diag.gb(td.sizeBytes)}, ${diag.gb(td.freeBytes)} free) — over ${diskThr}%`);
  if (diskEv.kind === "recover") resRecoveries.push(`• *Disk ${td.mount}* back under threshold — ${diskPct}% used`);

  // Fleet-level transition.
  const prevErroring = prev.erroringCount || 0;
  const prevSilent = prev.silentCount || 0;
  const prevTotal = prev.total || total;
  const crossed = (curN, prevN, pt) => total > 0 && curN / total >= fleetFraction && prevN / pt < fleetFraction;
  const erroringFleet = erroringCount - prevErroring >= fleetJump || crossed(erroringCount, prevErroring, prevTotal);
  const silentFleet = silentCount - prevSilent >= fleetJump || crossed(silentCount, prevSilent, prevTotal);
  const fleetEvent = erroringFleet || silentFleet;

  writeState({
    ts: new Date(now).toISOString(), total, erroringCount, silentCount, devices: cur,
    resources: { mem: memEv.state, disk: diskEv.state },
  });

  if (!problems.length && !recoveries.length && !fleetEvent && !resProblems.length && !resRecoveries.length) {
    sdk.logEvent(`monitor: no transitions (${total} dev, ${erroringCount} err, ${silentCount} silent, mem ${memPct}%, disk ${diskPct}%)`);
    return { ok: true, changes: 0, erroringCount, silentCount, memPct, diskPct };
  }

  // Compose one message with all changes this run.
  const attachments = [];
  if (fleetEvent) {
    attachments.push(slack.attachment(slack.COLORS.red, `:rotating_light: Fleet alert — ${site}`, [
      erroringFleet ? `Erroring devices: *${prevErroring} → ${erroringCount}* of ${total}` +
        (crossed(erroringCount, prevErroring, prevTotal) ? ` (≥ ${Math.round(fleetFraction * 100)}% of fleet)` : "") : null,
      silentFleet ? `Silent devices: *${prevSilent} → ${silentCount}* of ${total}` +
        (crossed(silentCount, prevSilent, prevTotal) ? ` (≥ ${Math.round(fleetFraction * 100)}% of fleet)` : "") : null,
      diag.topErrorTypes(errs) ? `Errors (1h): ${diag.topErrorTypes(errs)}` : null,
    ], diag.footerLine(sys)));
  }
  if (resProblems.length) {
    attachments.push(slack.attachment(slack.COLORS.red, `:floppy_disk: Host resource alert — ${site}`, resProblems, diag.footerLine(sys)));
  }
  if (problems.length) {
    const shown = problems.slice(0, 20);
    if (problems.length > 20) shown.push(`…and ${problems.length - 20} more`);
    attachments.push(slack.attachment(slack.COLORS.red,
      `:warning: ${problems.length} device issue${problems.length > 1 ? "s" : ""}`, shown, diag.footerLine(sys)));
  }
  if (recoveries.length || resRecoveries.length) {
    const shown = recoveries.slice(0, 20);
    if (recoveries.length > 20) shown.push(`…and ${recoveries.length - 20} more`);
    attachments.push(slack.attachment(slack.COLORS.green,
      `:white_check_mark: Recovered`, resRecoveries.concat(shown), diag.footerLine(sys)));
  }

  const anyProblem = fleetEvent || problems.length || resProblems.length;
  const headline = fleetEvent ? `:rotating_light: Fleet health change on *${site}*`
    : anyProblem ? `:warning: Status change on *${site}*`
    : `:white_check_mark: Recovery on *${site}*`;
  const r = await slack.post(sdk, webhook, { text: headline, attachments });
  sdk.logEvent(`monitor: ${problems.length} dev problems, ${recoveries.length} recoveries, ${resProblems.length} resource alerts, fleet=${fleetEvent} (mem ${memPct}%, disk ${diskPct}%) → slack ${r.ok ? "sent" : (r.skipped || "FAILED")}`);
  return { ok: true, problems: problems.length, recoveries: recoveries.length, resourceAlerts: resProblems.length, fleetEvent, memPct, diskPct };
};
