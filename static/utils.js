// Auth + fetch helpers for the Site Monitor dashboard. Mirrors the proven
// pattern used by the abound plugin (token from URL, browser-origin requests,
// gRPC-transcoded file + hook endpoints).

// Derive the app id from the URL the plugin is served at. Plugin static files
// are served at /api/v1/apps/static/<app>/...  (see src/application/static.go),
// so the app id is the path segment right AFTER "static". The file/hook API,
// by contrast, lives at /api/v1/apps/<app>/files/... (no "static").
// Never hardcode the id — the same code runs under different app ids
// (e.g. site-monitor, slack-dev) and a fixed id makes saves land in the wrong app.
function deriveAppId() {
  const m = window.location.pathname.match(/\/apps\/static\/([^\/]+)/);
  const id = (m && m[1]) || "site-monitor";
  console.log("[site-monitor][deriveAppId]", { pathname: window.location.pathname, APP_ID: id });
  return id;
}

export const APP_ID = deriveAppId();

export function getAuthToken() {
  const params = new URLSearchParams(window.location.search);
  let token = params.get("token") || params.get("auth_token");
  if (!token && window.location.hash) {
    const hp = new URLSearchParams(window.location.hash.substring(1));
    token = hp.get("token") || hp.get("auth_token");
  }
  return token;
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  const tok = getAuthToken();
  if (tok) h["Authorization"] = `Bearer ${tok}`;
  return h;
}

async function throwIfAuth(r) {
  if (r.status === 401 || r.status === 403) {
    console.warn("[site-monitor] auth failed, reloading");
    window.location.reload();
    throw new Error("auth failed");
  }
}

export async function apiGet(path, params) {
  let url = `${window.location.origin}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
      else if (v !== undefined && v !== null) qs.append(k, v);
    }
    url += (url.includes("?") ? "&" : "?") + qs.toString();
  }
  const r = await fetch(url, { headers: authHeaders() });
  await throwIfAuth(r);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function apiPost(path, body, contentType = "application/json") {
  const r = await fetch(`${window.location.origin}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": contentType }),
    body: JSON.stringify(body === undefined ? {} : body),
  });
  await throwIfAuth(r);
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${(await r.text()) || r.statusText}`);
  const txt = await r.text();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch (_) { return { raw: txt }; }
}

function utf8ToB64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToUtf8(b) {
  const bin = atob(b);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Read an app file. Returns a UTF-8 string, or null on 404.
export async function readFile(path) {
  const url = `${window.location.origin}/api/v1/apps/${APP_ID}/files${path}`;
  const r = await fetch(url, { headers: authHeaders() });
  await throwIfAuth(r);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`readFile ${path} → ${r.status}: ${await r.text()}`);
  const txt = await r.text();
  if (!txt) return null;
  try {
    const js = JSON.parse(txt);
    if (js && typeof js.data === "string") {
      try { return b64ToUtf8(js.data); } catch (_) { return js.data; }
    }
    if (js && typeof js.content === "string") return js.content;
    if (js && typeof js.body === "string") return js.body;
    return txt;
  } catch (_) {
    return txt;
  }
}

// Write an app file. NF's file API expects a JSON-encoded base64 `data` scalar.
export async function writeFile(path, content) {
  const b64 = utf8ToB64(content);
  const url = `${window.location.origin}/api/v1/apps/${APP_ID}/files${path}`;
  console.log("[site-monitor][writeFile] POST", url, `(APP_ID=${APP_ID})`);
  const r = await fetch(url, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(b64),
  });
  await throwIfAuth(r);
  if (!r.ok) throw new Error(`writeFile ${path} → ${r.status}: ${await r.text()}`);
}

export async function listHooks() {
  const d = await apiGet(`/api/v1/apps`);
  const app = (d.applications || []).find((a) => a.id === APP_ID);
  return (app && app.hooks) || [];
}

export async function startHook(hookId, args) {
  return apiPost(`/api/v1/apps/${APP_ID}/hooks/${hookId}`, args || {}, "application/grpc-web+json");
}

export async function getHookRuns(hookId, pageSize = 5) {
  return apiGet(`/api/v1/apps/${APP_ID}/hooks/${hookId}/runs`, { pageSize });
}

export function showToast(kind, msg, ms = 4000) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}
