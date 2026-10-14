import crypto from 'node:crypto';

const TOKEN = () => process.env.SLACK_BOT_TOKEN;

// Slack's error codes, in words the admin can act on.
const SLACK_ERRORS = {
  not_in_channel: 'The GDG Library bot isn’t in that channel. Type /invite @GDG Library there.',
  channel_not_found: 'Slack can’t find that channel. Invite the bot to it, and check SLACK_CHANNEL_ID.',
  invalid_auth: 'SLACK_BOT_TOKEN is wrong. Copy it again from the Slack app (Install App).',
  not_authed: 'SLACK_BOT_TOKEN is missing.',
  not_allowed_token_type: 'SLACK_BOT_TOKEN is the wrong kind of token. Use the Bot User OAuth Token, which starts with xoxb- (Slack app → OAuth & Permissions), then redeploy.',
  missing_scope: 'The Slack app is missing a permission. Update it from slack-manifest.json (App Manifest) and reinstall.',
  expired_trigger_id: 'Slack took too long to answer. Run /directory again.',
};
export const explainSlackError = (err) => {
  const code = String(err?.message || err).split(': ').pop();
  return SLACK_ERRORS[code] || `Something went wrong: ${err?.message || err}`;
};

/** Verify Slack's request signature (v0 HMAC-SHA256 over "v0:timestamp:body"). */
export function verify(secret, headers, raw) {
  const ts = headers.get('x-slack-request-timestamp');
  const sig = headers.get('x-slack-signature');
  if (!secret || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // replay window
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function call(method, params = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
}

/** The permissions the bot token has, e.g. ['channels:history', 'chat:write', …]. */
export async function scopes() {
  const res = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN()}` } });
  return (res.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Fetch a single message by channel + ts, including messages inside threads. */
export async function getMessage(channel, ts) {
  const h = await call('conversations.history', { channel, latest: ts, oldest: ts, inclusive: 'true', limit: '1' });
  let msg = (h.messages || []).find((m) => m.ts === ts);
  if (!msg) {
    const r = await call('conversations.replies', { channel, ts, limit: '200' });
    msg = (r.messages || []).find((m) => m.ts === ts);
  }
  return msg || null;
}

/** Users who currently have any of `emojis` on the message. */
export async function reactors(channel, ts, emojis) {
  const r = await call('reactions.get', { channel, timestamp: ts, full: 'true' });
  const list = r.message?.reactions || [];
  return new Set(list.filter((x) => emojis.includes(x.name)).flatMap((x) => x.users || []));
}

/**
 * Pull every web link out of a message: Slack-formatted text links, rich_text blocks
 * and unfurl attachments. Returns [{ url, title?, og? }], unfurl title + image attached where present.
 */
export function extractLinks(msg) {
  const found = new Map();
  const add = (u, title, image) => {
    if (!u || !/^https?:\/\//i.test(u)) return;
    u = u.replace(/&amp;/g, '&');
    let host;
    try { host = new URL(u).hostname; } catch { return; }
    if (/(^|\.)slack\.com$/i.test(host) || /(^|\.)slack-edge\.com$/i.test(host)) return;
    const prev = found.get(u);
    found.set(u, { url: u, title: title || prev?.title, og: image || prev?.og });
  };

  for (const m of (msg.text || '').matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/gi)) add(m[1]);

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'link' && node.url) add(node.url);
    for (const k of ['elements', 'blocks']) if (node[k]) walk(node[k]);
  };
  walk(msg.blocks);

  for (const a of msg.attachments || []) {
    const u = a.original_url || a.from_url || a.title_link;
    const img = a.image_url || a.thumb_url;
    if (u) add(u, clean(a.title) || clean(a.service_name), /^https:\/\//.test(img || '') ? img : '');
  }
  return [...found.values()];
}

function clean(s) {
  return s ? String(s).replace(/\s+/g, ' ').trim() : '';
}
