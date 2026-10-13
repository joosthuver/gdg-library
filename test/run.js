// End-to-end test with Slack, Redis and the open web mocked. Run: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SLACK_SIGNING_SECRET = 'test-secret';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.APPROVERS = 'UADMIN,UADMIN2';
process.env.SLACK_CHANNEL_ID = 'CSITES';
process.env.KV_REST_API_URL = 'https://redis.test';
process.env.KV_REST_API_TOKEN = 'redis-token';
process.env.ADMIN_TOKEN = 'admin-token';

import { hash, messages, thread, reactions, calls } from './mocks.js';

const { POST, GET } = await import('../api/slack.js');
const { GET: SITES } = await import('../api/sites.js');
const { POST: IMPORT } = await import('../api/import.js');

function signed(body, { secret = 'test-secret', ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  return new Request('https://x/api/slack', { method: 'POST', body: raw, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, 'content-type': 'application/json' } });
}
const react = (type, user, ts, reaction = 'white_check_mark', channel = 'CSITES') =>
  signed({ type: 'event_callback', event: { type, user, reaction, item: { type: 'message', channel, ts }, event_ts: '1760000000.000' } });
const sites = async () => (await (await SITES()).json()).sites;

let pass = 0;
async function t(name, fn) { await fn(); pass++; console.log('  ✓ ' + name); }

console.log('GDG Library tests');
const keepAlive = setInterval(() => {}, 1000); // AbortSignal.timeout timers are unref'd

await t('health check', async () => assert.equal((await GET()).status, 200));

await t('url_verification answers challenge when signed', async () => {
  const r = await POST(signed({ type: 'url_verification', challenge: 'abc' }));
  assert.deepEqual(await r.json(), { challenge: 'abc' });
});

await t('rejects bad signature, stale timestamp', async () => {
  assert.equal((await POST(signed({ type: 'event_callback' }, { secret: 'wrong' }))).status, 401);
  assert.equal((await POST(signed({ type: 'event_callback' }, { ts: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
});

await t('non-approver ✅ does nothing', async () => {
  assert.equal((await POST(react('reaction_added', 'URANDOM', '100.1'))).status, 200);
  assert.equal((await sites()).length, 0);
});

await t('approver with a different emoji does nothing', async () => {
  await POST(react('reaction_added', 'UADMIN', '100.1', 'fire'));
  assert.equal((await sites()).length, 0);
});

await t('other channel ignored', async () => {
  await POST(react('reaction_added', 'UADMIN', '100.1', 'white_check_mark', 'COTHER'));
  assert.equal((await sites()).length, 0);
});

await t('approver ✅ publishes every link in the message, with titles', async () => {
  reactions['100.1'] = [{ name: 'white_check_mark', users: ['UADMIN'] }];
  assert.equal((await POST(react('reaction_added', 'UADMIN', '100.1'))).status, 200);
  const s = await sites();
  assert.equal(s.length, 2);
  const ond = s.find((x) => x.host === 'ondine.example');
  assert.equal(ond.title, 'Ondine Studio — Identity & motion');
  assert.equal(ond.url, 'https://www.ondine.example/', 'tracking params stripped');
  assert.equal(s.find((x) => x.host === 'mara.example').title, 'Mara Lindqvist');
  assert.ok(!('srcs' in ond), 'internal fields not public');
});

await t('message with no links is a no-op', async () => {
  await POST(react('reaction_added', 'UADMIN', '100.2'));
  assert.equal((await sites()).length, 2);
});

await t('unfurl title + image used, no page fetch', async () => {
  const before = calls.filter((c) => c.includes('north.example')).length;
  await POST(react('reaction_added', 'UADMIN', '100.3'));
  assert.equal((await sites()).find((x) => x.host === 'north.example').title, 'North Works — Studio');
  assert.equal(calls.filter((c) => c.includes('north.example')).length, before);
});

await t('same site posted again merges into one entry, keeps title + date', async () => {
  reactions['100.4'] = [{ name: 'white_check_mark', users: ['UADMIN'] }];
  await POST(react('reaction_added', 'UADMIN', '100.4'));
  const s = await sites();
  assert.equal(s.filter((x) => x.host === 'ondine.example').length, 1);
  assert.equal(s.find((x) => x.host === 'ondine.example').title, 'Ondine Studio — Identity & motion');
});

await t('slow site falls back to hostname within the time budget', async () => {
  const t0 = Date.now();
  await POST(react('reaction_added', 'UADMIN', '100.5'));
  assert.ok(Date.now() - t0 < 2500);
  assert.equal((await sites()).find((x) => x.host === 'slow.example').title, 'slow.example');
});

await t('message inside a thread is found', async () => {
  await POST(react('reaction_added', 'UADMIN', '200.9'));
  assert.equal((await sites()).find((x) => x.host === 'thread.example').title, 'Thread – Work');
});

await t('retry of the same event is idempotent', async () => {
  const n = (await sites()).length;
  await POST(react('reaction_added', 'UADMIN', '100.1'));
  assert.equal((await sites()).length, n);
});

await t('removing ✅ keeps links while another approver still has ✅', async () => {
  reactions['100.1'] = [{ name: 'white_check_mark', users: ['UADMIN2'] }];
  await POST(react('reaction_removed', 'UADMIN', '100.1'));
  assert.ok((await sites()).some((x) => x.host === 'mara.example'));
});

await t('removing the last approver ✅ unpublishes that message only', async () => {
  reactions['100.1'] = [];
  await POST(react('reaction_removed', 'UADMIN2', '100.1'));
  const s = await sites();
  assert.ok(!s.some((x) => x.host === 'mara.example'), 'mara removed');
  assert.ok(s.some((x) => x.host === 'ondine.example'), 'ondine still approved via message 100.4, stays');
  assert.ok(s.some((x) => x.host === 'north.example'));
});

await t('un-approving the second message finally removes the shared site', async () => {
  reactions['100.4'] = [];
  await POST(react('reaction_removed', 'UADMIN', '100.4'));
  assert.ok(!(await sites()).some((x) => x.host === 'ondine.example'));
});

await t('import endpoint: auth, add, remove', async () => {
  const req = (token, body) => new Request('https://x/api/import', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  assert.equal((await IMPORT(req('nope', {}))).status, 401);
  const r = await IMPORT(req('admin-token', { sites: [{ url: 'https://old.example/', title: 'Old One', added: '2021-03-01' }], remove: ['https://north.example'] }));
  assert.deepEqual(await r.json(), { added: 1, removed: 1 });
  const s = await sites();
  assert.equal(s.at(-1).title, 'Old One', 'oldest last');
  assert.ok(!s.some((x) => x.host === 'north.example'));
});

await t('Redis failure returns 500 so Slack retries', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, o) => (String(u).includes('redis') ? new Response('down', { status: 500 }) : real(u, o));
  const r = await POST(react('reaction_added', 'UADMIN', '100.1'));
  globalThis.fetch = real;
  assert.equal(r.status, 500);
});

await t('countries are counted once each, case-insensitively, several per site allowed', async () => {
  hash.clear();
  for (const [h, c] of [['c1.example', 'Chile'], ['c2.example', 'chile '], ['c3.example', 'Japan'], ['c4.example', ''], ['c5.example', 'Japan, Denmark'], ['c6.example', 'Canada and Denmark']]) {
    hash.set(h, JSON.stringify({ url: `https://${h}/`, host: h, title: h, country: c, added: new Date().toISOString(), srcs: ['import'] }));
  }
  assert.equal((await (await SITES()).json()).countries, 4, 'Chile, Japan, Denmark, Canada');
});

clearInterval(keepAlive);
console.log(`\n${pass} passed`);
