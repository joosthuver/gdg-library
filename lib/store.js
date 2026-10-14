// Storage: one Redis hash, field = normalized URL, value = JSON entry.
// Talks to Upstash over its REST API with plain fetch, so there are no npm deps.
// Connecting an Upstash Redis store to the project in Vercel injects these env vars.

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'gdg:sites';
const LOCKS = `${KEY}:locks`;
const LOG = `${KEY}:slack-log`; // the last few things Slack sent, for the status page
const FORMS = `${KEY}:submissions`; // /directory submissions waiting for (or past) approval, by channel:ts

function assertConfigured() {
  if (!BASE || !TOKEN) throw new Error('Redis not configured: set KV_REST_API_URL and KV_REST_API_TOKEN');
}

async function pipeline(commands) {
  assertConfigured();
  const res = await fetch(`${BASE.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}: ${await res.text()}`);
  const out = await res.json();
  for (const r of out) if (r.error) throw new Error(`Redis: ${r.error}`);
  return out.map((r) => r.result);
}

function parse(v) {
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}

/** Every entry, as [id, entry] pairs. */
export async function all() {
  const [flat] = await pipeline([['HGETALL', KEY]]);
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    const e = parse(flat[i + 1]);
    if (e) out.push([flat[i], e]);
  }
  return out;
}

/** Entries for the given ids (null where missing). */
export async function get(ids) {
  if (!ids.length) return [];
  const [vals] = await pipeline([['HMGET', KEY, ...ids]]);
  return vals.map(parse);
}

/** Upsert a map of id -> entry. */
export async function put(map) {
  const args = Object.entries(map).flatMap(([id, e]) => [id, JSON.stringify(e)]);
  if (!args.length) return;
  await pipeline([['HSET', KEY, ...args]]);
}

/** Claim a short lock on one id, so two requests don't do the same work. A claim older than `ms` is stale. */
export async function lock(id, ms) {
  const now = Date.now();
  const [claimed] = await pipeline([['HSETNX', LOCKS, id, String(now)]]);
  if (claimed === 1) return true;
  const [held] = await pipeline([['HGET', LOCKS, id]]);
  if (now - Number(held) < ms) return false;
  await pipeline([['HSET', LOCKS, id, String(now)]]);
  return true;
}

export async function unlock(id) {
  await pipeline([['HDEL', LOCKS, id]]);
}

/** A /directory submission, stored against the approval message it was posted as. */
export async function putSubmission(src, submission) {
  await pipeline([['HSET', FORMS, src, JSON.stringify(submission)]]);
}
export async function getSubmission(src) {
  const [v] = await pipeline([['HGET', FORMS, src]]);
  return parse(v);
}

/** Remember what happened to something Slack sent (keeps the last 10). Never throws. */
export async function logEvent(entry) {
  try {
    await pipeline([['LPUSH', LOG, JSON.stringify({ at: new Date().toISOString(), ...entry })], ['LTRIM', LOG, '0', '9']]);
  } catch {}
}

/** The last 10 things Slack sent, newest first. */
export async function recentEvents() {
  const [list] = await pipeline([['LRANGE', LOG, '0', '9']]);
  return (list || []).map(parse).filter(Boolean);
}

/** Claim a named slot for `seconds` (e.g. "sync at most every 10 minutes"). True if this caller got it. */
export async function claim(name, seconds) {
  const [r] = await pipeline([['SET', `${KEY}:claim:${name}`, String(Date.now()), 'NX', 'EX', String(seconds)]]);
  return r === 'OK';
}

export async function remove(ids) {
  if (!ids.length) return;
  await pipeline([['HDEL', KEY, ...ids]]);
}
