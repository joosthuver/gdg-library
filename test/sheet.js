// Google Sheet sync + monthly check, end to end with everything mocked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sheets, reactions, validations, resetClaims, hash, sheetAccess, PRIVATE_PEM } from './mocks.js';

Object.assign(process.env, {
  SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'xoxb-test', APPROVERS: 'UADMIN', SLACK_CHANNEL_ID: 'CSITES',
  KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 'redis-token', ADMIN_TOKEN: 'admin-token', CRON_SECRET: 'cron-secret',
  GOOGLE_SHEET_ID: 'SHEET1', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'gdg@test.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: PRIVATE_PEM.replace(/\n/g, '\\n'), // as pasted into Vercel
});

const { POST } = await import('../api/slack.js');
const { GET: SITES } = await import('../api/sites.js');
const { GET: CHECK } = await import('../api/check.js');
const { GET: STATUS } = await import('../api/status.js');

const signed = (body) => {
  const raw = JSON.stringify(body), ts = Math.floor(Date.now() / 1000);
  const sig = 'v0=' + crypto.createHmac('sha256', 'test-secret').update(`v0:${ts}:${raw}`).digest('hex');
  return new Request('https://x/api/slack', { method: 'POST', body: raw, headers: { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig } });
};
const react = (type, ts) => signed({ type: 'event_callback', event: { type, user: 'UADMIN', reaction: 'white_check_mark', item: { type: 'message', channel: 'CSITES', ts }, event_ts: '1760000000.000' } });
const approve = (ts) => { reactions[ts] = [{ name: 'white_check_mark', users: ['UADMIN'] }]; return POST(react('reaction_added', ts)); };
const unapprove = (ts) => { reactions[ts] = []; return POST(react('reaction_removed', ts)); };
const hosts = async () => (await (await SITES()).json()).sites.map((s) => s.host).sort();
const rows = () => sheets.Sites.rows.slice(1);
// Column positions of a freshly created Sites tab.
const C = { name: 0, url: 1, title: 2, company: 3, location: 4, country: 5, availability: 6, image: 7, gallery: 8, added: 9, status: 10, checked: 11 };
const HEADERS = ['Name', 'URL', 'Title', 'Company', 'Location', 'Country', 'Availability', 'Image', 'Gallery', 'Added', 'Status', 'Last checked'];
const row = (o) => { const r = Array(12).fill(''); for (const [k, v] of Object.entries(o)) r[C[k]] = v; return r; };
const urls = () => rows().map((r) => r[1]);
const check = async (token = 'cron-secret') => CHECK(new Request('https://x/api/check', { headers: { authorization: `Bearer ${token}` } }));
const lastLog = () => sheets.Checks.rows.at(-1);

// Break / restore the Sheets API to simulate an outage.
const realFetch = globalThis.fetch;
const sheetsDown = (on) => { globalThis.fetch = on ? async (u, o) => (String(u).includes('sheets.googleapis') ? Response.json({ error: { message: 'down' } }, { status: 503 }) : realFetch(u, o)) : realFetch; };

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };
const keepAlive = setInterval(() => {}, 1000);
console.log('Sheet sync + monthly check');

await t('approving creates the Sites tab with headers and one row per link', async () => {
  await approve('100.1');
  assert.deepEqual(sheets.Sites.rows[0], HEADERS);
  assert.deepEqual(urls().sort(), ['https://mara.example/', 'https://www.ondine.example/']);
  const mara = rows().find((r) => r[1].includes('mara'));
  assert.deepEqual(mara, row({ name: 'Mara Lindqvist', url: 'https://mara.example/', added: '2025-10-09', status: 'Live' }));
});

await t('retrying the same approval adds no duplicate rows', async () => {
  await approve('100.1');
  assert.equal(rows().length, 2);
});

await t('un-approving deletes the rows and takes the sites off', async () => {
  await unapprove('100.1');
  assert.equal(rows().length, 0);
  assert.deepEqual(await hosts(), []);
});

await t('check endpoint needs the cron secret', async () => {
  assert.equal((await check('nope')).status, 401);
});

await t('check: a row typed into the sheet goes live; statuses + log written', async () => {
  await approve('100.3'); // north.example
  sheets.Sites.rows.push(row({ name: 'Hand Added', url: 'https://hand.example/', title: 'Photographer', company: 'Hand Studio', location: 'Santiago', country: 'Chile', availability: 'Available', added: '2024-02-01' }));
  const r = await (await check()).json();
  assert.equal(r.addedToSite, 1);
  assert.deepEqual(await hosts(), ['hand.example', 'north.example']);
  const hand = rows().find((x) => x[1].includes('hand'));
  assert.equal(hand[C.status], 'Added to site');
  assert.match(hand[C.checked], /^\d{4}-\d\d-\d\d$/);
  assert.equal(rows().find((x) => x[1].includes('north'))[C.status], 'Live');
  assert.equal(lastLog()[4], 'In sync');
  const site = (await (await SITES()).json()).sites.find((s) => s.host === 'hand.example');
  assert.equal(site.title, 'Hand Added');
  assert.equal(site.practice, 'Photographer');
  assert.equal(site.company, 'Hand Studio');
  assert.equal(site.available, true);
  assert.equal(site.location, 'Santiago');
  assert.equal(site.country, 'Chile');
  assert.ok(site.added.startsWith('2024-02-01'));
});

await t('check: deleting a row takes the site off', async () => {
  sheets.Sites.rows = sheets.Sites.rows.filter((r) => !String(r[1]).includes('north'));
  const r = await (await check()).json();
  assert.equal(r.removedFromSite, 1);
  assert.deepEqual(await hosts(), ['hand.example']);
  assert.match(lastLog()[4], /Removed: https:\/\/north\.example/);
});

await t('check: putting the row back brings the site back', async () => {
  sheets.Sites.rows.push(['North again', 'https://north.example']);
  await check();
  assert.deepEqual(await hosts(), ['hand.example', 'north.example']);
});

await t('sheet outage during approval: site still updates, check appends the missing row', async () => {
  sheetsDown(true);
  assert.equal((await approve('100.4')).status, 200);
  sheetsDown(false);
  assert.ok((await hosts()).includes('ondine.example'));
  assert.ok(!urls().some((u) => u.includes('ondine')));
  const r = await (await check()).json();
  assert.equal(r.addedToSheet, 1);
  assert.equal(rows().find((x) => x[1].includes('ondine'))[C.status], 'Added to sheet');
  assert.ok((await hosts()).includes('ondine.example'), 'not removed');
});

await t('sheet shared as Viewer: the site still updates, and the status page says why the row is missing and what to do', async () => {
  await unapprove('100.4');
  sheetAccess.readOnly = true;
  try {
    assert.equal((await approve('100.4')).status, 200);
    assert.ok((await hosts()).includes('ondine.example'));
    assert.ok(!urls().some((u) => u.includes('ondine')));
    const html = await (await STATUS()).text();
    assert.match(html, /can’t edit the sheet/);
    assert.match(html, /Couldn’t add ondine\.example to the sheet/);
    assert.match(html, /gdg@test\.iam\.gserviceaccount\.com as Editor/);
  } finally { sheetAccess.readOnly = false; }
  assert.match(await (await STATUS()).text(), /Connected and can edit/);
  await check();
  assert.ok(urls().some((u) => u.includes('ondine')), 'the check adds the row once editing works');
});

await t('sheet outage during un-approval: check deletes the leftover row, Slack wins', async () => {
  await approve('200.9');
  sheetsDown(true);
  await unapprove('200.9');
  sheetsDown(false);
  assert.ok(urls().some((u) => u.includes('thread.example')));
  const r = await (await check()).json();
  assert.equal(r.rowsDeleted, 1);
  assert.ok(!urls().some((u) => u.includes('thread.example')));
  assert.ok(!(await hosts()).includes('thread.example'));
});

await t('check: invalid and duplicate rows are flagged, not published', async () => {
  sheets.Sites.rows.push(row({ name: 'Typo', url: 'not a link' }), row({ name: 'Dupe', url: 'https://www.hand.example' }));
  await check();
  assert.equal(rows().find((x) => x[1] === 'not a link')[C.status], 'Not a valid link');
  assert.match(rows().find((x) => x[1] === 'https://www.hand.example')[C.status], /^Duplicate of row \d+$/);
  assert.equal((await hosts()).filter((h) => h === 'hand.example').length, 1);
});

await t('check: an emptied sheet changes nothing and logs why', async () => {
  const before = await hosts();
  const saved = sheets.Sites.rows;
  sheets.Sites.rows = [saved[0]];
  const r = await (await check()).json();
  assert.equal(r.ok, false);
  assert.deepEqual(await hosts(), before);
  assert.match(lastLog()[4], /Nothing changed/);
  sheets.Sites.rows = saved;
});

await t('daily sync: name, title, company, location, country, availability and image edits reach live sites; nothing else changes', async () => {
  const before = rows().length;
  const north = rows().find((x) => x[1].includes('north'));
  Object.assign(north, { [C.name]: 'North Works', [C.title]: 'Studio', [C.company]: 'North & Co', [C.location]: 'Toronto and Copenhagen', [C.country]: 'Canada, Denmark', [C.availability]: 'available', [C.image]: 'https://img.example/north-cover.jpg' });
  const r = await (await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }))).json();
  assert.equal(r.updated, 1);
  const s = (await (await SITES()).json()).sites.find((x) => x.host === 'north.example');
  assert.equal(s.title, 'North Works');
  assert.equal(s.practice, 'Studio');
  assert.equal(s.company, 'North & Co');
  assert.equal(s.available, true, 'any capitalization of Available');
  assert.equal(s.location, 'Toronto and Copenhagen');
  assert.equal(s.country, 'Canada, Denmark');
  const list = await (await SITES()).json();
  assert.equal(list.countries, 3, 'Chile + Canada + Denmark');
  assert.match(s.image, /^\/api\/cover/, 'new image → recapture');
  assert.equal(rows().length, before, 'sync never adds or deletes rows');
});

await t('daily sync: Gallery links reach live sites, one per line or space-separated', async () => {
  const north = rows().find((x) => x[1].includes('north'));
  const before = (await (await SITES()).json()).sites.find((x) => x.host === 'north.example');
  north[C.gallery] = 'https://img.example/w1.jpg\nhttps://img.example/w_10,h_20/w2.jpg  not-a-link';
  const r = await (await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }))).json();
  assert.equal(r.updated, 1);
  const s = (await (await SITES()).json()).sites.find((x) => x.host === 'north.example');
  assert.ok(s.galleryUrl && s.galleryUrl !== before.galleryUrl, 'images captured again from the new links');
  assert.match(s.image, /^\/api\/cover/);
  const again = await (await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }))).json();
  assert.equal(again.updated, 0, 'no change, no work');
});

await t('daily sync ignores rows that are not live yet', async () => {
  sheets.Sites.rows.push(row({ name: 'Not yet', url: 'https://notyet.example/', title: 'Designer' }));
  await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }));
  assert.ok(!(await hosts()).includes('notyet.example'));
  sheets.Sites.rows.pop();
});

await t('daily sync: setting Availability to "Not available" takes the pill off', async () => {
  rows().find((x) => x[1].includes('north'))[C.availability] = 'Not available';
  await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }));
  assert.equal((await (await SITES()).json()).sites.find((x) => x.host === 'north.example').available, false);
});

await t('columns are read by header name: reordering them in the sheet changes nothing', async () => {
  const swap = (r) => { [r[C.location], r[C.country]] = [r[C.country], r[C.location]]; };
  sheets.Sites.rows.forEach(swap); // the admin dragged Country before Location
  const r = await (await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }))).json();
  assert.equal(r.updated, 0, 'same data, nothing to update');
  sheets.Sites.rows.forEach(swap);
});

await t('an older sheet (Title | URL | Practice | …) is upgraded in place, data kept', async () => {
  const saved = sheets.Sites.rows;
  validations.length = 0;
  sheets.Sites.rows = [
    ['Title', 'URL', 'Practice', 'Location', 'Country', 'Image', 'Gallery', 'Added', 'Status', 'Last checked'],
    ['Hand Added', 'https://hand.example/', 'Photographer', 'Santiago', 'Chile', '', '', '2024-02-01', 'Live', '2026-10-01'],
  ];
  await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } }));
  assert.deepEqual(sheets.Sites.rows[0], HEADERS);
  assert.deepEqual(sheets.Sites.rows[1], row({ name: 'Hand Added', url: 'https://hand.example/', title: 'Photographer', location: 'Santiago', country: 'Chile', added: '2024-02-01', status: 'Live', checked: '2026-10-01' }));
  assert.ok(validations.some((v) => v.range.startColumnIndex === C.availability), 'Availability dropdown added');
  sheets.Sites.rows = saved;
});

await t('serving the list syncs sheet edits in the background, at most every 10 minutes', async () => {
  const { freshen } = await import('../api/sites.js');
  await new Promise((r) => setTimeout(r, 50)); // let earlier background syncs finish
  resetClaims();
  const north = rows().find((x) => x[1].includes('north'));
  north[C.gallery] = 'https://img.example/g1.jpg\nhttps://img.example/g2.jpg';
  await freshen();
  assert.deepEqual(JSON.parse(hash.get('north.example')).picks, ['https://img.example/g1.jpg', 'https://img.example/g2.jpg'], 'Gallery links picked up without waiting for the morning');
  north[C.title] = 'Changed again';
  await freshen();
  assert.notEqual(JSON.parse(hash.get('north.example')).practice, 'Changed again', 'not twice within 10 minutes');
  resetClaims();
  await freshen();
  assert.equal(JSON.parse(hash.get('north.example')).practice, 'Changed again', 'next window: synced');
});

await t('admin token can run the check by hand', async () => {
  assert.equal((await check('admin-token')).status, 200);
});

clearInterval(keepAlive);
console.log(`\n${pass} passed`);
