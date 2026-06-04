# Site Monitor

End-to-end site monitoring for Normal Framework with Slack alerting.

Site Monitor watches a deployment's points, devices, and host resources and
pushes a **daily heartbeat** plus **real-time transition alerts** to a Slack
channel. It is fully config-driven — **nothing about the site is hardcoded**, so
the same app drops onto any NF instance unchanged.

---

## What it does

### 1. Daily heartbeat (`heartbeat` hook — scheduled, once/day)
A once-a-day Slack summary:

- **Active points** — how many of the site's points received data within the
  freshness window (default 24h), as `active / total (%)`, with a
  **day-over-day delta**.
- **Idle points** — stale vs. never-valued counts.
- **Device rollup** — total / reporting / silent / erroring, split by protocol
  (BACnet, Modbus, …).
- **Host** — memory % and disk % (most-full mount).
- **Errors** — top BACnet error types over the window.
- **Needs attention** — the specific devices that are silent or erroring.

It also writes a snapshot to `config/.heartbeat-state.json` so the dashboard can
show the last result instantly without re-scanning every point.

### 2. Transition alerts (`monitor` hook — scheduled, every ~5 min)
Each run gathers fleet + host diagnostics, compares against the previous run's
state, and posts **a single Slack message** summarising everything that changed
(so a fleet-wide event is one message, not a storm). It detects:

- **Device went silent** — no data within `silentMinutes` — and **recovered**.
- **Device started erroring** — `currentErrorStatus` RED, or error rate over
  `errorRateThreshold` (optionally YELLOW too) — and **errors cleared**.
- **Fleet-level events** — the erroring or silent device count jumps by
  `fleetErrorJump`, or crosses `fleetErrorFraction` of the fleet. This is the
  "all devices started erroring" signal, rolled up into one alert.
- **Host resources** — memory % or disk % over threshold. Uses hysteresis
  (clears 2% under the threshold) and **re-alerts every `resourceRealertHours`**
  while a condition persists, so an ongoing problem stays visible without
  spamming every interval.

Liveness (silent/reporting) and health (ok/erroring) are tracked on
**independent axes** — a device that is both stale and RED is reported as both,
never masked.

### 3. Dashboard (`static/`)
An in-console UI tab to:

- See live fleet status (active points, reporting / silent / erroring, per
  device, per protocol), top errors, and host memory/disk (red over threshold).
- **Configure the Slack webhook + all thresholds** and save them — applied on
  each hook's next run, no restart needed.
- **Send a test alert** and **Run monitor / heartbeat now** on demand.

---

## Setup

1. **Create a Slack Incoming Webhook**
   - <https://api.slack.com/apps> → **Create New App** → **From scratch**.
   - **Incoming Webhooks** → activate → **Add New Webhook to Workspace** → pick a
     channel → copy the `https://hooks.slack.com/services/…` URL.
2. **Configure the app** — open the Site Monitor dashboard, paste the webhook
   into **Slack Incoming Webhook URL**, adjust thresholds if desired, **Save**.
   (Alternatively set the options in the app's NF Configuration panel.)
3. **Test** — click **Send test alert**; a message should land in your channel.

Until a webhook is set, hooks run normally but **log the would-be message**
instead of sending (`[slack:disabled] …` in the hook logs), so everything is
testable up front.

---

## Configuration

Settings can be set from the dashboard (written to `config/settings.json`) or as
NF app config options. Dashboard values take precedence; both fall back to the
code defaults below.

| Key | Default | Meaning |
|-----|---------|---------|
| `slackWebhookUrl` | `""` | Slack Incoming Webhook. Empty → log instead of send. |
| `siteLabel` | `""` | Friendly site name in messages. Empty → NF site name. |
| `silentMinutes` | `30` | Device is "silent" if no data within this many minutes. |
| `freshnessHours` | `24` | Heartbeat "active point" window. |
| `errorRateThreshold` | `0.1` | Device is "erroring" above this rate (or status RED). |
| `includeYellow` | `false` | Treat YELLOW devices as erroring too. |
| `fleetErrorJump` | `3` | Fleet alert when erroring/silent count jumps by this many. |
| `fleetErrorFraction` | `0.5` | Fleet alert when erroring/silent reach this fraction. |
| `memThresholdPct` | `90` | Alert when host memory usage reaches this %. |
| `diskThresholdPct` | `90` | Alert when host disk usage reaches this %. |
| `resourceRealertHours` | `6` | Re-alert cadence while a mem/disk condition persists. |

### Schedules
- `monitor` — every 5 minutes (`RRULE:FREQ=MINUTELY;INTERVAL=5`).
- `heartbeat` — daily at 14:00 UTC (`RRULE:FREQ=DAILY;INTERVAL=1`).

To change cadence, edit the hook's schedule (e.g. via `deploy_hook` /
`update_hook`).

---

## Hooks

| Hook | Mode | Purpose |
|------|------|---------|
| `monitor` | scheduled (5 min), no points | Device / fleet / host transition alerts. |
| `heartbeat` | scheduled (daily), no points | Daily summary + dashboard snapshot. |
| `test-alert` | on request | Send a test Slack message; confirm wiring. |

---

## How it works (data sources)

All data comes from generic NF REST endpoints (called via `sdk.http` in hooks,
and same-origin `fetch` in the dashboard):

- `GET /api/v1/bacnet/devicestatus` — per-device health for **all** protocols:
  `deviceName`, `lastAlive` (ISO 8601), `currentErrorRate`,
  `currentErrorStatus`, `layer`.
- `GET /api/v1/bacnet/errorsummary?window.seconds=…` — error counts by type.
- `GET /api/v1/platform/info` — version + `resources[]` with `memory`
  (`totalBytes/usedBytes/freeBytes`) and `storage`
  (`mountPoint/sizeBytes/usedBytes/freeBytes`).
- `POST /api/v1/point/query` (layer `default`) — points with `latestValue.ts`,
  paginated, to count freshness for the heartbeat.

State persists across runs in the app's `config/` dir:
`.monitor-state.json` (per-device + resource alert state) and
`.heartbeat-state.json` (dashboard snapshot).

---

## File layout

```
site-monitor/
├── monitor.js              # transition-alert hook logic
├── heartbeat.js            # daily summary hook logic
├── test-alert.js           # manual test hook
├── hook-*.js               # thin entry points (require the real modules)
├── lib/
│   ├── diag.js             # REST gatherers + classification + formatting
│   ├── slack.js            # Slack webhook transport (swappable)
│   └── settings.js         # config/settings.json load/save + merge over NF config
├── static/                 # dashboard (vanilla JS, Tailwind from CDN)
│   ├── index.html
│   ├── app.js
│   ├── utils.js            # auth + file/hook REST helpers
│   ├── styles.css
│   └── logo.svg
└── config/                 # runtime settings + state (created at runtime)
```

Slack delivery is isolated in `lib/slack.js` behind a small `post()` interface,
so it can be swapped for a bot token (`chat.postMessage`) later without touching
any monitoring logic.

---

## Troubleshooting

- **Alerts log but don't send** — no webhook configured; set it and Save.
- **Dashboard shows stale data** — hard-refresh (Cmd/Ctrl + Shift + R); script
  assets are versioned (`?v=…`) to avoid this.
- **No transitions ever fire** — on static/replayed demo data, device state may
  not change. Lower thresholds, toggle `includeYellow`, or use **Run monitor
  now** after a config change to force evaluation.
- **Connection errors in a hook run** — tunnels drop intermittently; retry.
