// Slack delivery. Transport is isolated here so it can be swapped for
// chat.postMessage (bot token) later without touching monitoring logic.
//
// Uses sdk.http (Axios). An absolute webhook URL overrides NF's baseURL — the
// same mechanism the abound DMS client relies on for external POSTs.

const COLORS = {
  red: "#d7263d",
  green: "#2eb67d",
  yellow: "#ecb22e",
  blue: "#36c5f0",
  gray: "#9aa0a6",
};

// message: { text, blocks?, attachments? }
// When no webhook is configured the payload is logged instead of sent, so the
// hooks are fully testable before a webhook URL is supplied.
async function post(sdk, webhookUrl, message) {
  const text = message.text || "";
  if (!webhookUrl) {
    const preview = message.attachments
      ? message.attachments.map((a) => `[${a.title}] ${a.text || ""}`).join(" | ")
      : "";
    sdk.logEvent(`[slack:disabled] ${text} ${preview}`.trim());
    return { ok: false, skipped: "no webhook configured" };
  }
  const payload = { text };
  if (message.blocks) payload.blocks = message.blocks;
  if (message.attachments) payload.attachments = message.attachments;
  try {
    const resp = await sdk.http.post(webhookUrl, payload, {
      headers: { "Content-Type": "application/json" },
    });
    return { ok: true, status: resp.status };
  } catch (e) {
    const status = e.response && e.response.status;
    const body = e.response && e.response.data;
    sdk.logEvent(`slack: POST failed: ${status || ""} ${e.message} ${body ? JSON.stringify(body).slice(0, 200) : ""}`);
    return { ok: false, error: e.message, status };
  }
}

// Build a colored Slack attachment. lines is an array of mrkdwn strings.
function attachment(color, title, lines, footer) {
  const att = {
    color,
    title,
    text: (lines || []).filter(Boolean).join("\n"),
    mrkdwn_in: ["text"],
  };
  if (footer) att.footer = footer;
  return att;
}

module.exports = { post, attachment, COLORS };
