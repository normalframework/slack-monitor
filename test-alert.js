// Manual test hook (on_request). Sends a test Slack message and reports whether
// the webhook is configured + reachable. Also logs which config keys the hook
// actually received, to confirm configuration is wired through.

const diag = require("./lib/diag");
const slack = require("./lib/slack");
const settings = require("./lib/settings");

module.exports = async ({ sdk, config }) => {
  const cfg = settings.merged(config);
  const webhook = diag.cfgStr(cfg, "slackWebhookUrl", "");
  const siteLabel = diag.cfgStr(cfg, "siteLabel", "");
  sdk.logEvent(`test-alert: webhook ${webhook ? "set" : "EMPTY"}`);

  let sys = {};
  try { sys = await diag.getSystemInfo(sdk); }
  catch (e) { sdk.logEvent(`test-alert: platform/info failed: ${e.message}`); }
  const site = siteLabel || sys.siteName || "site";

  const r = await slack.post(sdk, webhook, {
    text: ":wave: *Site Monitor* test alert",
    attachments: [slack.attachment(slack.COLORS.blue, `Site Monitor test — ${site}`,
      ["If you can read this in Slack, the webhook works. ✅", diag.footerLine(sys)])],
  });

  sdk.logEvent(`test-alert: slack ${r.ok ? "delivered" : (r.skipped || `FAILED (${r.error || r.status})`)}`);
  return { ok: true, webhookConfigured: !!webhook, slack: r };
};
