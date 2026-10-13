import crypto from 'node:crypto';

const TOKEN = () => process.env.SLACK_BOT_TOKEN;

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

export async function call(method, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
  return data;
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
