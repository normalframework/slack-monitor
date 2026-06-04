import * as U from "./utils.js?v=3";

const DEFAULTS = {
  slackWebhookUrl: "",
  siteLabel: "",
  silentMinutes: 30,
  freshnessHours: 24,
  errorRateThreshold: 0.1,
  includeYellow: false,
  fleetErrorJump: 3,
  fleetErrorFraction: 0.5,
  memThresholdPct: 90,
  diskThresholdPct: 90,
  resourceRealertHours: 6,
};

const state = { settings: { ...DEFAULTS }, hooks: [] };

function byId(id) { return document.getElementById(id); }
function commas(n) { return Number(n || 0).toLocaleString("en-US"); }
function num(v) { const n = Number(v); return Number.isNaN(n) ? 0 : n; }
function gbStr(b) { const g = num(b) / 1e9; return g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`; }

// devicestatus.lastAlive is an ISO 8601 string; also tolerate epoch ms numbers.
function aliveMs(la) {
  if (la === null || la === undefined) return 0;
  const n = typeof la === "string" ? Date.parse(la) : Number(la);
  return Number.isNaN(n) ? 0 : n;
}
function humanAge(ms) {
  if (!isFinite(ms) || ms < 0) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Mirrors lib/diag.classifyDevice — liveness and health are independent.
// REST fields: lastAlive (ISO), currentErrorRate, currentErrorStatus.
function classify(d, opt) {
  const now = Date.now();
  const alive = aliveMs(d.lastAlive);
  const silent = alive === 0 || now - alive > opt.silentMs;
  const rate = num(d.currentErrorRate ?? d.errorRate);
  const status = String(d.currentErrorStatus || d.errorStatus || "").toUpperCase();
  let erroring = status === "RED" || rate > opt.errRate;
  if (opt.includeYellow && status === "YELLOW") erroring = true;
  return { alive, silent, erroring, rate, status };
}

function optFromForm() {
  return {
    silentMs: (num(byId("cfg-silent").value) || 30) * 60000,
    errRate: num(byId("cfg-errrate").value) || 0.1,
    includeYellow: byId("cfg-yellow").checked,
    memThr: num(byId("cfg-mem").value) || 90,
    diskThr: num(byId("cfg-disk").value) || 90,
  };
}

// ---- settings -------------------------------------------------------------

async function loadSettings() {
  let s = { ...DEFAULTS };
  try {
    const raw = await U.readFile("/config/settings.json");
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch (e) { console.warn("loadSettings", e.message); }
  state.settings = s;
  byId("cfg-webhook").value = s.slackWebhookUrl || "";
  byId("cfg-sitelabel").value = s.siteLabel || "";
  byId("cfg-silent").value = s.silentMinutes ?? 30;
  byId("cfg-fresh").value = s.freshnessHours ?? 24;
  byId("cfg-errrate").value = s.errorRateThreshold ?? 0.1;
  byId("cfg-mem").value = s.memThresholdPct ?? 90;
  byId("cfg-disk").value = s.diskThresholdPct ?? 90;
  byId("cfg-realert").value = s.resourceRealertHours ?? 6;
  byId("cfg-fleetjump").value = s.fleetErrorJump ?? 3;
  byId("cfg-fleetfrac").value = s.fleetErrorFraction ?? 0.5;
  byId("cfg-yellow").checked = !!s.includeYellow;
}

async function saveConfig() {
  const s = {
    slackWebhookUrl: byId("cfg-webhook").value.trim(),
    siteLabel: byId("cfg-sitelabel").value.trim(),
    silentMinutes: num(byId("cfg-silent").value) || 30,
    freshnessHours: num(byId("cfg-fresh").value) || 24,
    errorRateThreshold: num(byId("cfg-errrate").value) || 0.1,
    includeYellow: byId("cfg-yellow").checked,
    fleetErrorJump: num(byId("cfg-fleetjump").value) || 3,
    fleetErrorFraction: num(byId("cfg-fleetfrac").value) || 0.5,
    memThresholdPct: num(byId("cfg-mem").value) || 90,
    diskThresholdPct: num(byId("cfg-disk").value) || 90,
    resourceRealertHours: num(byId("cfg-realert").value) || 6,
  };
  try {
    await U.writeFile("/config/settings.json", JSON.stringify(s, null, 2));
    state.settings = s;
    U.showToast("success", "Configuration saved.");
    refresh();
  } catch (e) {
    U.showToast("error", `Save failed: ${e.message}`);
  }
}

// ---- status ---------------------------------------------------------------

async function refresh() {
  byId("statusText").textContent = "Loading…";
  const opt = optFromForm();
  const [devices, errs, sys, hbRaw] = await Promise.all([
    U.apiGet("/api/v1/bacnet/devicestatus", { pageSize: 2000 }).then((d) => d.results || []).catch(() => []),
    U.apiGet("/api/v1/bacnet/errorsummary", { "window.seconds": 86400 }).catch(() => ({})),
    U.apiGet("/api/v1/platform/info").catch(() => ({})),
    U.readFile("/config/.heartbeat-state.json").catch(() => null),
  ]);

  renderHeartbeat(hbRaw);
  renderFleet(devices, opt);
  renderErrors(errs);
  renderSystem(sys, opt);
  byId("statusText").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function renderHeartbeat(raw) {
  let hb = null;
  try { hb = raw ? JSON.parse(raw) : null; } catch (_) {}
  if (hb && hb.points) {
    const pct = hb.points.total ? Math.round((hb.points.active / hb.points.total) * 100) : 0;
    byId("hbActive").textContent = commas(hb.points.active);
    byId("hbSub").textContent = `of ${commas(hb.points.total)} (${pct}%) · ${new Date(hb.ts).toLocaleString()}`;
  } else {
    byId("hbActive").textContent = "—";
    byId("hbSub").textContent = "run heartbeat to compute";
  }
}

function renderFleet(devices, opt) {
  let reporting = 0, silent = 0, erroring = 0;
  const proto = {};
  const rows = devices.map((d) => {
    const c = classify(d, opt);
    const p = String(d.layer || "").includes("modbus") ? "Modbus" : String(d.layer || "").includes("bacnet") ? "BACnet" : (d.layer || "—");
    const pp = proto[p] || (proto[p] = { total: 0, reporting: 0 });
    pp.total++;
    if (c.silent) silent++; else { reporting++; pp.reporting++; }
    if (c.erroring) erroring++;
    const badges = [];
    if (c.silent) badges.push('<span class="pill pill-warn">silent</span>');
    else badges.push('<span class="pill pill-ok">reporting</span>');
    if (c.erroring) badges.push(`<span class="pill pill-err">${c.status || "erroring"}</span>`);
    return {
      sortKey: (c.erroring ? 0 : c.silent ? 1 : 2),
      html: `<tr>
        <td>${esc(d.deviceName || d.deviceId || "?")}</td>
        <td class="text-gray-500">${esc(p)}</td>
        <td>${badges.join(" ")}</td>
        <td class="text-gray-500">${c.alive ? humanAge(Date.now() - c.alive) : "never"}</td>
        <td class="text-right ${c.rate ? "text-red-600" : "text-gray-400"}">${c.rate ? c.rate.toFixed(2) : "0"}</td>
      </tr>`,
    };
  }).sort((a, b) => a.sortKey - b.sortKey);

  byId("devReporting").textContent = reporting;
  byId("devSilent").textContent = silent;
  byId("devErroring").textContent = erroring;
  byId("devTotalSub").textContent = `of ${devices.length} devices`;
  byId("protoBreakdown").textContent = Object.entries(proto).map(([k, v]) => `${k}: ${v.reporting}/${v.total} reporting`).join("   ·   ");
  byId("fleetTable").innerHTML = rows.length ? rows.map((r) => r.html).join("") : '<tr><td colspan="5" class="text-gray-400">No devices</td></tr>';
}

function renderErrors(errs) {
  const counts = (errs && (errs.errorCounts || errs.counts)) || {};
  const ent = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8);
  byId("errorsPanel").innerHTML = ent.length
    ? ent.map(([k, v]) => `<div class="flex justify-between"><span>${esc(k)}</span><span class="font-mono">${commas(v)}</span></div>`).join("")
    : '<span class="text-gray-400">No errors reported</span>';
}

function renderSystem(sys, opt) {
  const rows = [["Site", sys.siteName || "—"], ["NF version", sys.version || "—"]];
  for (const r of sys.resources || []) {
    if (r.memory) {
      const t = num(r.memory.totalBytes), f = num(r.memory.freeBytes), u = num(r.memory.usedBytes) || (t - f);
      const pct = t ? Math.round((u / t) * 100) : 0;
      rows.push(["Memory", `${pct}% (${gbStr(u)} / ${gbStr(t)})`, pct >= opt.memThr]);
    } else if (r.storage) {
      const sz = num(r.storage.sizeBytes), f = num(r.storage.freeBytes), u = num(r.storage.usedBytes) || (sz - f);
      const pct = sz ? Math.round((u / sz) * 100) : 0;
      rows.push([`Disk ${esc(r.storage.mountPoint || "")}`, `${pct}% (${gbStr(f)} free)`, pct >= opt.diskThr]);
    }
  }
  byId("sysPanel").innerHTML = rows.map(([k, v, hot]) =>
    `<div class="flex justify-between"><span class="text-gray-500">${k}</span><span class="${hot ? "text-red-600 font-semibold" : ""}">${v}</span></div>`
  ).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- hooks ----------------------------------------------------------------

async function runHook(name) {
  try {
    if (!state.hooks.length) state.hooks = await U.listHooks();
    const h = state.hooks.find((x) => x.name === name);
    if (!h) { U.showToast("error", `Hook ${name} not found`); return; }
    U.showToast("info", `Running ${name}…`, 3000);
    await U.startHook(h.id);
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 800));
      const runs = await U.getHookRuns(h.id, 1);
      const run = (runs.runs || [])[0];
      if (run && (run.state === 6 || run.state === 9)) {
        if (run.state === 6) U.showToast("success", `${name} completed${name === "test-alert" ? " — check Slack" : ""}`);
        else U.showToast("error", `${name} failed — check hook logs`);
        refresh();
        return;
      }
    }
    U.showToast("info", `${name} still running…`);
  } catch (e) {
    U.showToast("error", `${name}: ${e.message}`);
  }
}

function wire() {
  byId("btnRefresh").addEventListener("click", refresh);
  byId("btnSaveConfig").addEventListener("click", saveConfig);
  byId("btnTest").addEventListener("click", () => runHook("test-alert"));
  byId("btnRunMonitor").addEventListener("click", () => runHook("monitor"));
  byId("btnRunHeartbeat").addEventListener("click", () => runHook("heartbeat"));
}

(async function main() {
  wire();
  await loadSettings();
  try { state.hooks = await U.listHooks(); } catch (_) {}
  await refresh();
})();
