// Shared mocks: Slack, Upstash Redis, Google Sheets and a few web pages.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
export const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// ——— Mocks ———
export const hash = new Map(); // the sites hash
const other = {}; // any other Redis hash (locks)
export const lists = {}; // Redis lists (the Slack activity log)
export const messages = {
  '100.1': { ts: '100.1', text: 'New site! <https://www.ondine.example/?utm_source=slack|ondine.example> and <https://mara.example>' },
  '100.2': { ts: '100.2', text: 'no links here' },
  '100.3': { ts: '100.3', text: 'Unfurled <https://north.example>', attachments: [{ original_url: 'https://north.example', title: 'North Works — Studio', service_name: 'North', image_url: 'https://img.example/north.jpg' }] },
  '100.4': { ts: '100.4', text: 'Dupe of ondine <https://ondine.example/>' },
  '100.5': { ts: '100.5', text: 'Slow site <https://slow.example>' },
};
export const thread = { '200.9': { ts: '200.9', text: 'in a thread <https://thread.example/work>' } };
export const reactions = {}; // ts -> [{name, users}]
export const calls = [];
export const slack = { posts: [], views: [], scopes: 'channels:history,reactions:read,chat:write,commands', nextTs: 300 }; // what the app sent to Slack
export const sheets = {}; // title -> { id, rows: [[...]] }  (row 0 = header)
export const validations = []; // dropdowns set on the sheet
let nextSheetId = 100;

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  calls.push(url);
  if (url === 'https://oauth2.googleapis.com/token') {
    const assertion = new URLSearchParams(opts.body).get('assertion');
    const [h, p, sig] = assertion.split('.');
    const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    return ok ? Response.json({ access_token: 'g-token', expires_in: 3600 }) : Response.json({ error: 'invalid_grant' }, { status: 400 });
  }
  if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/SHEET1')) return sheetsApi(url, opts);
  if (url.startsWith('https://redis.test/pipeline')) {
    assert.equal(opts.headers.Authorization, 'Bearer redis-token');
    const out = JSON.parse(opts.body).map(([cmd, key, ...a]) => {
      const h = key === 'gdg:sites' ? hash : (other[key] ||= new Map());
      if (cmd === 'HGETALL') return { result: [...h].flat() };
      if (cmd === 'HGET') return { result: h.get(a[0]) ?? null };
      if (cmd === 'HMGET') return { result: a.map((f) => h.get(f) ?? null) };
      if (cmd === 'HSET') { for (let i = 0; i < a.length; i += 2) h.set(a[i], a[i + 1]); return { result: a.length / 2 }; }
      if (cmd === 'HSETNX') { if (h.has(a[0])) return { result: 0 }; h.set(a[0], a[1]); return { result: 1 }; }
      if (cmd === 'LPUSH') { const l = (lists[key] ||= []); l.unshift(...a); return { result: l.length }; }
      if (cmd === 'LTRIM') { lists[key] = (lists[key] || []).slice(Number(a[0]), Number(a[1]) + 1); return { result: 'OK' }; }
      if (cmd === 'LRANGE') return { result: (lists[key] || []).slice(Number(a[0]), Number(a[1]) + 1) };
      if (cmd === 'HDEL') { let n = 0; for (const f of a) n += h.delete(f) ? 1 : 0; return { result: n }; }
      return { error: 'unknown' };
    });
    return Response.json(out);
  }
  if (url.startsWith('https://slack.com/api/')) {
    const u = new URL(url);
    const method = u.pathname.split('/').pop();
    const p = Object.fromEntries(new URLSearchParams(typeof opts.body === 'string' ? opts.body : u.search));
    if (method === 'conversations.history') return Response.json({ ok: true, messages: messages[p.latest] ? [messages[p.latest]] : [] });
    if (method === 'conversations.replies') return Response.json({ ok: true, messages: thread[p.ts] ? [{ ts: '200.0', text: 'parent' }, thread[p.ts]] : [] });
    if (method === 'auth.test') return Response.json({ ok: true, team: 'GDG', user: 'gdg_library' }, { headers: { 'x-oauth-scopes': slack.scopes } });
    if (method === 'views.open') { slack.views.push({ trigger: p.trigger_id, view: JSON.parse(p.view) }); return Response.json({ ok: true }); }
    if (method === 'chat.postMessage') { const ts = `${slack.nextTs++}.0`; slack.posts.push({ ...p, ts }); return Response.json({ ok: true, channel: p.channel, ts }); }
    if (method === 'reactions.get') return Response.json({ ok: true, message: { reactions: reactions[p.timestamp] || [] } });
    return Response.json({ ok: false, error: 'unknown_method' });
  }
  if (url.includes('slow.example')) {
    return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
  }
  const pages = {
    'https://www.ondine.example/?utm_source=slack': '<html><head><meta property="og:title" content="Ondine Studio &mdash; Identity &amp; motion"></head>',
    'https://mara.example': '<html><head><title>  Mara\n Lindqvist </title></head>',
    'https://thread.example/work': '<html><head><title>Thread &#8211; Work</title></head>',
    'https://ondine.example/': '<title>Should not be used</title>',
  };
  if (pages[url]) return new Response(pages[url], { headers: { 'content-type': 'text/html; charset=utf-8' } });
  return new Response('nope', { status: 404 });
};


const col = (c) => c.charCodeAt(0) - 65;
function parseRange(r) {
  const m = decodeURIComponent(r).match(/^'(.+)'!([A-Z])(\d+)?(?::([A-Z])(\d+)?)?$/);
  return { tab: m[1].replace(/''/g, "'"), c0: col(m[2]), r0: m[3] ? +m[3] : 1, c1: m[4] ? col(m[4]) : col(m[2]), r1: m[5] ? +m[5] : Infinity };
}
function put(rg, values) {
  const s = sheets[rg.tab];
  values.forEach((v, i) => {
    const row = (s.rows[rg.r0 - 1 + i] ||= []);
    v.forEach((x, j) => { row[rg.c0 + j] = String(x ?? ''); });
  });
}
async function sheetsApi(url, opts) {
  assert.equal(opts.headers.Authorization, 'Bearer g-token');
  const u = new URL(url);
  const path = u.pathname.replace('/v4/spreadsheets/SHEET1', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  const method = opts.method || 'GET';
  if (path === '' && method === 'GET') return Response.json({ sheets: Object.entries(sheets).map(([title, s]) => ({ properties: { title, sheetId: s.id } })) });
  if (path === ':batchUpdate') {
    for (const q of body.requests) {
      if (q.addSheet) sheets[q.addSheet.properties.title] = { id: nextSheetId++, rows: [] };
      if (q.deleteDimension) {
        const s = Object.values(sheets).find((x) => x.id === q.deleteDimension.range.sheetId);
        s.rows.splice(q.deleteDimension.range.startIndex, 1);
      }
      if (q.insertDimension) {
        const { sheetId, dimension, startIndex } = q.insertDimension.range;
        assert.equal(dimension, 'COLUMNS');
        const s = Object.values(sheets).find((x) => x.id === sheetId);
        for (const r of s.rows) if (r && r.length > startIndex) r.splice(startIndex, 0, '');
      }
      if (q.setDataValidation) validations.push(q.setDataValidation);
    }
    return Response.json({});
  }
  if (path === '/values:batchUpdate') {
    for (const d of body.data) put(parseRange(d.range), d.values);
    return Response.json({});
  }
  const m = path.match(/^\/values\/([^:?]+)(:append)?$/);
  const rg = parseRange(m[1]);
  const s = sheets[rg.tab];
  if (!s) return Response.json({ error: { message: 'Unable to parse range' } }, { status: 400 });
  if (m[2]) { for (const v of body.values) s.rows.push(v.map(String)); return Response.json({}); }
  if (method === 'PUT') { put(rg, body.values); return Response.json({}); }
  // GET values: trim trailing empty rows
  const out = s.rows.slice(rg.r0 - 1, rg.r1 === Infinity ? undefined : rg.r1).map((r) => (r || []).slice(rg.c0, rg.c1 + 1));
  while (out.length && !out.at(-1).some((x) => x)) out.pop();
  return Response.json(out.length ? { values: out } : {});
}
