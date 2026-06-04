// Shared diagnostics gatherers + formatting helpers for the Site Monitor app.
// All data comes from generic NF REST endpoints — nothing site-specific is
// hardcoded, so the app is portable across deployments.

// ---------------------------------------------------------------------------
// Config helpers — read app configuration (passed to hooks as `config`) with
// code-level defaults so the app runs anywhere even before it is configured.
// ---------------------------------------------------------------------------
function cfgStr(config, key, dflt) {
  const v = config && config[key];
  return v === undefined || v === null || v === "" ? dflt : String(v);
}
function cfgNum(config, key, dflt) {
  const v = config && config[key];
  if (v === undefined || v === null || v === "") return dflt;
  const n = Number(v);
  return Number.isNaN(n) ? dflt : n;
}
function cfgBool(config, key, dflt) {
  const v = config && config[key];
  if (v === undefined || v === null || v === "") return dflt;
  return v === true || v === "true" || v === 1 || v === "1";
}

// ---------------------------------------------------------------------------
// Time / freshness / formatting helpers.
// ---------------------------------------------------------------------------
// Accepts an ISO 8601 string (devicestatus.lastAlive, point latestValue.ts) or
// an epoch-ms number. Returns 0 when unparseable.
function tsMs(ts) {
  if (ts === null || ts === undefined) return 0;
  const t = typeof ts === "string" ? Date.parse(ts) : Number(ts);
  return Number.isNaN(t) ? 0 : t;
}
function humanAge(ms) {
  if (!isFinite(ms) || ms < 0) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}
function num(v) {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}
function commas(n) {
  return Number(n || 0).toLocaleString("en-US");
}
function gb(bytes) {
  const g = num(bytes) / 1e9;
  return g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// REST gatherers.
// ---------------------------------------------------------------------------
// All devices (BACnet + Modbus) with health. Fields (per /bacnet/devicestatus):
//   deviceId, deviceName, deviceUuid, up, lastAlive (ISO string),
//   currentErrorRate, currentErrorStatus, layer, siteRef.
async function getDeviceStatus(sdk) {
  const resp = await sdk.http.get("/api/v1/bacnet/devicestatus", {
    params: { pageSize: 2000 },
  });
  return resp.data?.results || [];
}

// Error summary over a window. Returns { counts: {type: n}, deviceErrors: [...] }.
async function getErrorSummary(sdk, windowSeconds = 3600) {
  const resp = await sdk.http.get("/api/v1/bacnet/errorsummary", {
    params: { "window.seconds": windowSeconds },
  });
  const d = resp.data || {};
  return {
    counts: d.errorCounts || d.counts || {},
    deviceErrors: d.deviceErrors || [],
  };
}

// System info: version, license, memory + storage utilization.
// resources[] entries carry either { memory: { totalBytes, usedBytes, freeBytes } }
// or { storage: { mountPoint, sizeBytes, usedBytes, freeBytes } }.
async function getSystemInfo(sdk) {
  const resp = await sdk.http.get("/api/v1/platform/info");
  const d = resp.data || {};
  let mem = null;
  const disks = [];
  for (const r of d.resources || []) {
    if (r.memory) {
      const total = num(r.memory.totalBytes);
      const free = num(r.memory.freeBytes);
      const used = num(r.memory.usedBytes) || (total - free);
      mem = { totalBytes: total, freeBytes: free, usedBytes: used, usedPct: total ? Math.round((used / total) * 100) : 0 };
    } else if (r.storage) {
      const size = num(r.storage.sizeBytes);
      const free = num(r.storage.freeBytes);
      const used = num(r.storage.usedBytes) || (size - free);
      disks.push({
        mount: r.storage.mountPoint || "",
        sizeBytes: size, freeBytes: free, usedBytes: used,
        usedPct: size ? Math.round((used / size) * 100) : 0,
      });
    }
  }
  return {
    siteName: d.siteName || "",
    version: d.version || "",
    license: d.license || "",
    timezone: d.timezone || "",
    mem,
    disks,
  };
}

// The most-full disk (the one worth alerting on).
function topDisk(sys) {
  const ds = (sys && sys.disks) || [];
  return ds.slice().sort((a, b) => b.usedPct - a.usedPct)[0] || null;
}

// Paginate every point on a layer, classifying value freshness.
// Returns { total, active, stale, novalue }. active = has a value whose
// timestamp is within freshnessMs.
async function scanPointFreshness(sdk, freshnessMs, layer = "default") {
  let total = 0, active = 0, stale = 0, novalue = 0;
  const pageSize = 500;
  const MAX_PAGES = 400; // safety cap (~200k points)
  const now = Date.now();
  for (let i = 0, offset = 0; i < MAX_PAGES; i++, offset += pageSize) {
    const resp = await sdk.http.post("/api/v1/point/query", {
      pageSize,
      pageOffset: offset,
      layer,
      responseFormat: "LAYERS_COLLAPSED",
    });
    const rows = resp.data?.points || [];
    for (const p of rows) {
      total++;
      const lv = p.latestValue;
      if (!lv || lv.ts == null) { novalue++; continue; }
      if (now - tsMs(lv.ts) <= freshnessMs) active++;
      else stale++;
    }
    if (rows.length < pageSize) break;
  }
  return { total, active, stale, novalue };
}

// ---------------------------------------------------------------------------
// Device classification + identity. Liveness and health are INDEPENDENT.
// opt: { silentMs, errorRateThreshold, includeYellow }
// ---------------------------------------------------------------------------
function classifyDevice(d, opt) {
  const now = Date.now();
  const alive = tsMs(d.lastAlive);                       // ISO string -> ms
  const silent = alive === 0 || now - alive > opt.silentMs;
  const rate = num(d.currentErrorRate ?? d.errorRate);   // REST uses current*
  const status = String(d.currentErrorStatus || d.errorStatus || "").toUpperCase();
  let erroring = status === "RED" || rate > opt.errorRateThreshold;
  if (opt.includeYellow && status === "YELLOW") erroring = true;
  let state = "ok";
  if (silent) state = "silent";
  else if (erroring) state = "erroring";
  return { state, alive, silent, erroring, rate, errorStatus: status };
}
function protocolOf(d) {
  const l = String(d.layer || "");
  if (l.includes("bacnet")) return "BACnet";
  if (l.includes("modbus")) return "Modbus";
  return l || "other";
}
function deviceKey(d) {
  return d.deviceUuid || `${d.deviceId || ""}:${d.deviceName || ""}`;
}

// ---------------------------------------------------------------------------
// Message formatting helpers (shared by both hooks).
// ---------------------------------------------------------------------------
function topErrorTypes(errs, max = 4) {
  const ent = Object.entries(errs.counts || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, max);
  if (!ent.length) return null;
  return ent.map(([k, v]) => `${k} ${commas(v)}`).join(", ");
}
function footerLine(sys) {
  const td = topDisk(sys);
  return [
    sys.siteName || null,
    sys.version ? `NF ${sys.version}` : null,
    sys.mem ? `mem ${sys.mem.usedPct}%` : null,
    td ? `disk ${td.usedPct}%` : null,
  ].filter(Boolean).join(" · ");
}

module.exports = {
  cfgStr, cfgNum, cfgBool,
  tsMs, humanAge, num, commas, gb,
  getDeviceStatus, getErrorSummary, getSystemInfo, topDisk, scanPointFreshness,
  classifyDevice, protocolOf, deviceKey,
  topErrorTypes, footerLine,
};
