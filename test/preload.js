// The launch preload (preload/sites.json and preload/sites.csv), both routes, end to end with everything mocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sheets, hash, PRIVATE_PEM } from './mocks.js';

Object.assign(process.env, {
  KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 'redis-token', ADMIN_TOKEN: 'admin-token', CRON_SECRET: 'cron-secret',
  GOOGLE_SHEET_ID: 'SHEET1', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'gdg@test.iam.gserviceaccount.com',
  GOOGLE_PRIVATE_KEY: PRIVATE_PEM.replace(/\n/g, '\\n'),
});

const { POST: IMPORT } = await import('../api/import.js');
const { GET: SITES } = await import('../api/sites.js');
const { GET: CHECK } = await import('../api/check.js');

const preload = JSON.parse(fs.readFileSync(new URL('../preload/sites.json', import.meta.url)));
const csv = fs.readFileSync(new URL('../preload/sites.csv', import.meta.url), 'utf8');
const NAMES = preload.sites.map((s) => s.title);
const list = async () => (await SITES()).json();

// Minimal CSV parser: quoted fields may hold commas and line breaks.
const parseCsv = (text) => {
  const rows = []; let row = [], cur = '', q = false;
  for (const ch of text.replace(/\r\n/g, '\n').trim()) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { row.push(cur); cur = ''; }
    else if (ch === '\n' && !q) { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  row.push(cur); rows.push(row);
  return rows;
};

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };
const keepAlive = setInterval(() => {}, 1000);
console.log('Launch preload');

await t('preload files agree: same nine sites, same order', async () => {
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['Title', 'URL', 'Practice', 'Location', 'Country', 'Image', 'Gallery', 'Added', 'Status', 'Last checked']);
  assert.equal(rows.length - 1, 9);
  assert.deepEqual(rows.slice(1).map((r) => r[0]), NAMES);
  assert.deepEqual(rows.slice(1).map((r) => r[1]), preload.sites.map((s) => s.url));
});

// ——— Route 1: one curl to /api/import ———
await t('import: all nine go live with name, practice and location', async () => {
  const r = await IMPORT(new Request('https://x/api/import', { method: 'POST', headers: { authorization: 'Bearer admin-token' }, body: JSON.stringify(preload) }));
  assert.deepEqual(await r.json(), { added: 9, removed: 0 });
  const d = await list();
  assert.equal(d.count, 9);
  const jonas = d.sites.find((s) => s.title === 'Jonas Emmertsen');
  assert.equal(jonas.practice, 'Creative Director & Founder');
  assert.equal(jonas.location, 'Toronto and Copenhagen');
  assert.equal(jonas.host, '28k.studio');
});

await t('import: each site brings its chosen work images (Gallery), commas inside links kept', async () => {
  const picks = (h) => JSON.parse(hash.get(h)).picks;
  assert.equal(picks('28k.studio').length, 6);
  assert.equal(picks('jordivanderoord.com').length, 3);
  assert.ok(picks('mister.studio')[0].includes('rect=0,0,1920,1080'));
});

await t('import: count reads 9 sites from 5 countries', async () => {
  assert.equal((await list()).countries, 5, 'Canada, Denmark, Netherlands, United States, United Kingdom');
});

await t('import: Latest keeps the order the sites were sent in', async () => {
  assert.deepEqual((await list()).sites.map((s) => s.title), NAMES);
});

await t('import: rows written to the sheet with Location and Country', async () => {
  const rows = sheets.Sites.rows;
  assert.deepEqual(rows[0].slice(0, 5), ['Title', 'URL', 'Practice', 'Location', 'Country']);
  assert.equal(rows.length - 1, 9);
  const jordi = rows.find((r) => r[0] === 'Jordi van der Oord');
  assert.deepEqual(jordi.slice(2, 5), ['Creative Director', 'Rotterdam', 'Netherlands']);
});

await t('import: the monthly check afterwards changes nothing', async () => {
  const r = await (await CHECK(new Request('https://x/api/check', { headers: { authorization: 'Bearer cron-secret' } }))).json();
  assert.deepEqual([r.addedToSite, r.removedFromSite, r.addedToSheet, r.rowsDeleted], [0, 0, 0, 0]);
  assert.equal((await list()).count, 9);
});

// ——— Route 2: paste the CSV rows into the sheet, then run the check ———
await t('paste: CSV rows typed into an empty sheet all go live on the next check', async () => {
  hash.clear();
  for (const k of Object.keys(sheets)) delete sheets[k];
  await CHECK(new Request('https://x/api/check?mode=sync', { headers: { authorization: 'Bearer cron-secret' } })); // creates the tab + headers
  // Sheets stores "2026-10-09 09:08" as a date: hand it back as a serial number, as the API does.
  const serial = (s) => { const [d, hm] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return Date.UTC(y, m - 1, dd, h, mi) / 864e5 + 25569; };
  for (const r of parseCsv(csv).slice(1)) sheets.Sites.rows.push([...r.slice(0, 7), serial(r[7])]);
  const res = await (await CHECK(new Request('https://x/api/check', { headers: { authorization: 'Bearer cron-secret' } }))).json();
  assert.equal(res.addedToSite, 9);
  const d = await list();
  assert.equal(d.count, 9);
  assert.equal(d.countries, 5);
  assert.deepEqual(d.sites.map((s) => s.title), NAMES, 'order from the Added times');
  assert.ok(d.sites[0].added.startsWith('2026-10-09T09:08'), d.sites[0].added);
  assert.equal(sheets.Sites.rows.find((r) => r[0] === 'Mike Sullivan')[8], 'Added to site');
  assert.deepEqual(JSON.parse(hash.get('mister.studio')).picks, preload.sites.find((x) => x.title === 'Mike Sullivan').gallery, 'Gallery cell → the same images');
});

clearInterval(keepAlive);
console.log(`\n${pass} passed`);
