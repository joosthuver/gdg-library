// /directory: the Slack form for joining or updating a listing, end to end with everything mocked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hash, sheets, reactions, slack, PRIVATE_PEM } from './mocks.js';

Object.assign(process.env, {
  SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'xoxb-test', APPROVERS: 'UADMIN', SLACK_CHANNEL_ID: 'CSITES',
  KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 'redis-token', ADMIN_TOKEN: 'admin-token', CRON_SECRET: 'cron-secret',
  GOOGLE_SHEET_ID: 'SHEET1', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'gdg@test.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: PRIVATE_PEM,
});

const { POST } = await import('../api/slack.js');
const { GET: SITES } = await import('../api/sites.js');
const { GET: CHECK } = await import('../api/check.js');
const { POST: IMPORT } = await import('../api/import.js');
const { GET: STATUS } = await import('../api/status.js');

const sign = (raw, type, secret = 'test-secret') => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, 'content-type': type };
};
const formPost = (params, secret) => {
  const raw = new URLSearchParams(params).toString();
  return POST(new Request('https://x/api/slack', { method: 'POST', body: raw, headers: sign(raw, 'application/x-www-form-urlencoded', secret) }));
};
const command = (user) => formPost({ command: '/directory', user_id: user, trigger_id: `trig-${user}`, channel_id: 'CRANDOM' });
const values = (f) => ({
  url: { v: { value: f.url } }, title: { v: { value: f.name } }, practice: { v: { value: f.title || '' } },
  company: { v: { value: f.company || '' } }, location: { v: { value: f.location || '' } }, country: { v: { value: f.country || '' } },
  available: { v: { selected_options: f.available ? [{ value: 'yes' }] : [] } }, picks: { v: { value: f.picks || '' } },
});
const submit = async (user, f) => (await formPost({ payload: JSON.stringify({ type: 'view_submission', user: { id: user }, view: { callback_id: 'gdg_directory', state: { values: values(f) } } }) })).json();
const react = (ts) => {
  reactions[ts] = [{ name: 'white_check_mark', users: ['UADMIN'] }];
  const raw = JSON.stringify({ type: 'event_callback', event: { type: 'reaction_added', user: 'UADMIN', reaction: 'white_check_mark', item: { type: 'message', channel: 'CSITES', ts }, event_ts: '1760000000.000' } });
  return POST(new Request('https://x/api/slack', { method: 'POST', body: raw, headers: sign(raw, 'application/json') }));
};
const site = async (h) => (await (await SITES()).json()).sites.find((s) => s.host === h);
const sheetRow = (url) => { const head = sheets.Sites.rows[0]; const r = sheets.Sites.rows.find((x) => x[head.indexOf('URL')] === url); return r && Object.fromEntries(head.map((h, i) => [h, r[i]])); };
const sync = () => CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }));

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };
const keepAlive = setInterval(() => {}, 1000);
console.log('/directory form');

await t('/directory opens the form (empty for someone without a listing)', async () => {
  const r = await command('UANA');
  assert.equal(r.status, 200);
  const { trigger, view } = slack.views.at(-1);
  assert.equal(trigger, 'trig-UANA');
  assert.equal(view.title.text, 'Join the directory');
  assert.deepEqual(view.blocks.filter((b) => b.type === 'input').map((b) => b.label.text), ['Your website', 'Name', 'Title', 'Company', 'Based in', 'Country', 'Availability', 'Images of your work']);
});

await t('a wrongly signed command is rejected', async () => {
  assert.equal((await formPost({ command: '/directory', user_id: 'UANA', trigger_id: 'x' }, 'wrong')).status, 401);
});

await t('bad website or image links come back as errors on the form', async () => {
  const r = await submit('UANA', { url: 'not a site', name: 'Ana', picks: 'https://img.example/a.jpg\nsomething' });
  assert.equal(r.response_action, 'errors');
  assert.ok(r.errors.url && r.errors.picks);
});

await t('a new submission is posted in the channel for ✅, nothing goes live yet', async () => {
  const before = slack.posts.length;
  const r = await submit('UANA', { url: 'ana.example', name: 'Ana Reyes', title: 'Art Director', company: 'Studio Reyes', location: 'Lisbon', country: 'Portugal', available: true, picks: 'https://img.example/a.jpg\nhttps://img.example/b.jpg' });
  assert.equal(r.response_action, 'update');
  assert.match(r.view.blocks[0].text.text, /for an approver to ✅/);
  const post = slack.posts.at(-1);
  assert.equal(slack.posts.length, before + 1);
  assert.equal(post.channel, 'CSITES');
  assert.match(post.text, /New for the directory from <@UANA>: <https:\/\/ana\.example\/>/);
  assert.match(post.text, /\*Company:\* Studio Reyes/);
  assert.match(post.text, /Available for work/);
  assert.equal(await site('ana.example'), undefined);
});

await t('an approver’s ✅ publishes it with everything filled in, and writes the sheet row', async () => {
  const ts = slack.posts.at(-1).ts;
  assert.equal((await react(ts)).status, 200);
  const s = await site('ana.example');
  assert.deepEqual([s.title, s.practice, s.company, s.location, s.country, s.available], ['Ana Reyes', 'Art Director', 'Studio Reyes', 'Lisbon', 'Portugal', true]);
  assert.equal(JSON.parse(hash.get('ana.example')).owner, 'UANA');
  assert.deepEqual(JSON.parse(hash.get('ana.example')).picks, ['https://img.example/a.jpg', 'https://img.example/b.jpg']);
  const row = sheetRow('https://ana.example/');
  assert.deepEqual([row.Name, row.Title, row.Company, row.Availability], ['Ana Reyes', 'Art Director', 'Studio Reyes', 'Available']);
  assert.equal(row.Gallery, 'https://img.example/a.jpg\nhttps://img.example/b.jpg');
});

await t('running /directory again opens the form filled in with their listing', async () => {
  await command('UANA');
  const { view } = slack.views.at(-1);
  assert.equal(view.title.text, 'Update your listing');
  const field = (id) => view.blocks.find((b) => b.block_id === id).element;
  assert.equal(field('url').initial_value, 'https://ana.example/');
  assert.equal(field('company').initial_value, 'Studio Reyes');
  assert.equal(field('available').initial_options.length, 1);
});

await t('the owner’s own changes apply straight away (site and sheet), no approval, and the daily sync keeps them', async () => {
  const before = slack.posts.length;
  const r = await submit('UANA', { url: 'https://ana.example/', name: 'Ana Reyes', title: 'Creative Director', company: '', location: 'Lisbon', country: 'Portugal', available: false, picks: '' });
  assert.match(r.view.blocks[0].text.text, /Your listing is updated/);
  assert.equal(slack.posts.length, before, 'nothing posted');
  let s = await site('ana.example');
  assert.deepEqual([s.practice, s.company, s.available], ['Creative Director', '', false]);
  const row = sheetRow('https://ana.example/');
  assert.deepEqual([row.Title, row.Company, row.Availability, row.Gallery], ['Creative Director', '', '', '']);
  await sync();
  s = await site('ana.example');
  assert.equal(s.practice, 'Creative Director', 'not reverted by the sheet');
});

await t('someone else submitting the same site goes to approval, not straight live', async () => {
  const before = slack.posts.length;
  await submit('UMALLORY', { url: 'https://ana.example/', name: 'Not Ana', title: 'Hacker' });
  assert.equal(slack.posts.length, before + 1);
  assert.match(slack.posts.at(-1).text, /Update to a listing from <@UMALLORY>/);
  assert.equal((await site('ana.example')).title, 'Ana Reyes');
});

await t('a member claims a preloaded listing: their form + ✅ replaces the details and makes them the owner', async () => {
  await IMPORT(new Request('https://x/api/import', { method: 'POST', headers: { authorization: 'Bearer admin-token' }, body: JSON.stringify({ sites: [{ url: 'https://joost.example/', title: 'Joost', practice: 'Design Director', company: 'Old Co', location: 'Amsterdam', country: 'Netherlands' }] }) }));
  assert.equal(JSON.parse(hash.get('joost.example')).owner, undefined);
  await submit('UJOOST', { url: 'https://joost.example', name: 'Joost Huver', title: 'Design Director', location: 'Amsterdam', country: 'Netherlands', available: true });
  await react(slack.posts.at(-1).ts);
  const s = await site('joost.example');
  assert.deepEqual([s.title, s.company, s.available], ['Joost Huver', '', true]);
  assert.equal(JSON.parse(hash.get('joost.example')).owner, 'UJOOST');
  assert.equal(sheetRow('https://joost.example/').Company, '');
  assert.equal(sheets.Sites.rows.filter((r) => r[1] === 'https://joost.example/').length, 1, 'one row, updated in place');
});

await t('status page: /directory is ready when the app has its new permissions, and says how to fix it when not', async () => {
  let html = await (await STATUS()).text();
  assert.match(html, /\/directory is ready\./);
  slack.scopes = 'channels:history,reactions:read';
  html = await (await STATUS()).text();
  assert.match(html, /missing chat:write and commands/);
  assert.match(html, /App Manifest/);
  slack.scopes = 'channels:history,reactions:read,chat:write,commands';
});

clearInterval(keepAlive);
console.log(`\n${pass} passed`);
