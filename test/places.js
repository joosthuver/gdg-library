// The Map view's data: where members are, and the country count. Everything mocked.
import assert from 'node:assert/strict';
import { hash, geo, resetClaims } from './mocks.js';

Object.assign(process.env, {
  KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 'redis-token',
  SLACK_SIGNING_SECRET: 'test-secret', SLACK_BOT_TOKEN: 'xoxb-test', APPROVERS: 'UADMIN', SLACK_CHANNEL_ID: 'CSITES',
});

const { GET: SITES, place } = await import('../api/sites.js');
const { GET: STATUS } = await import('../api/status.js');
const { findPlaces, needsPlaces } = await import('../lib/places.js');
const { countCountries, canonicalCountry } = await import('../lib/countries.js');

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };
const keepAlive = setInterval(() => {}, 1000);
const add = (host, fields) => hash.set(host, JSON.stringify({ url: `https://${host}/`, host, title: host, added: new Date().toISOString(), srcs: ['import'], ...fields }));
const list = async () => (await (await SITES()).json());
const site = async (host) => (await list()).sites.find((s) => s.host === host);
const placeAll = async () => { resetClaims(); await place(); };
console.log('Map places');

await t('country names: UK, U.K. and United Kingdom are one; so are USA and United States', async () => {
  assert.equal(countCountries(['UK', 'United Kingdom', 'u.k.', 'England']), 1);
  assert.equal(countCountries(['USA', 'United States', 'us', 'United States of America']), 1);
  assert.equal(countCountries(['the Netherlands', 'Netherlands', 'Holland', 'Canada, Denmark', 'Canada and Denmark']), 3);
  assert.equal(countCountries(['Trinidad and Tobago']), 1, 'a country with “and” in its name is one');
  assert.equal(canonicalCountry('usa'), 'United States');
  assert.equal(canonicalCountry('atlantis'), 'Atlantis', 'unknown names kept as written');
});

await t('a city is found in their country, with its time zone', async () => {
  const g = await findPlaces({ location: 'Amsterdam', country: 'Netherlands' });
  assert.deepEqual(g.places, [{ name: 'Amsterdam', lat: 52.374, lng: 4.889, tz: 'Europe/Amsterdam', country: 'Netherlands', level: 'city' }]);
  assert.deepEqual(g.missing, []);
});

await t('Country narrows it down: Amsterdam in the United States is the one in New York', async () => {
  const g = await findPlaces({ location: 'Amsterdam', country: 'USA' });
  assert.equal(g.places[0].tz, 'America/New_York');
});

await t('“City, Region” picks the right one of the same name; “Area, City” works too', async () => {
  assert.equal((await findPlaces({ location: 'Portland, Maine', country: 'USA' })).places[0].tz, 'America/New_York');
  assert.equal((await findPlaces({ location: 'Portland', country: 'USA' })).places[0].tz, 'America/Los_Angeles', 'the bigger one by default');
  assert.equal((await findPlaces({ location: 'Central Coast, Sydney', country: 'Australia' })).places[0].name, 'Central Coast');
  assert.equal((await findPlaces({ location: 'London, Canada', country: '' })).places[0].country, 'Canada', 'a country written in Location counts too');
});

await t('several places: “Toronto and Copenhagen” is two', async () => {
  const g = await findPlaces({ location: 'Toronto and Copenhagen', country: 'Canada, Denmark' });
  assert.deepEqual(g.places.map((p) => p.name), ['Toronto', 'Copenhagen']);
});

await t('a country on its own sits in the middle of that country, with no time zone', async () => {
  const g = await findPlaces({ location: 'USA', country: '' });
  assert.equal(g.places[0].level, 'country');
  assert.equal(g.places[0].name, 'United States');
  assert.equal(g.places[0].tz, '');
  const none = await findPlaces({ location: '', country: 'Sweden' });
  assert.equal(none.places[0].name, 'Sweden', 'no Location: the middle of their country');
});

await t('a city that isn’t found: the middle of their country, and noted; with no country, off the map', async () => {
  const g = await findPlaces({ location: 'Atlantis', country: 'Germany' });
  assert.equal(g.places[0].name, 'Germany');
  assert.deepEqual(g.missing, ['Atlantis']);
  const off = await findPlaces({ location: 'Atlantis', country: '' });
  assert.deepEqual(off.places, []);
  assert.deepEqual(off.missing, ['Atlantis']);
});

await t('the list carries places once found, in the background, and each lookup happens once', async () => {
  hash.clear();
  add('ams.example', { location: 'Amsterdam', country: 'Netherlands' });
  add('pete.example', { location: 'USA', country: '' });
  add('bcn.example', { location: 'Barcelona', country: '' });
  assert.deepEqual((await site('ams.example')).places, [], 'not looked up yet');
  await placeAll();
  assert.equal((await site('ams.example')).places[0].tz, 'Europe/Amsterdam');
  assert.equal((await site('pete.example')).places[0].level, 'country');
  const asked = geo.asked.length;
  await placeAll();
  assert.equal(geo.asked.length, asked, 'nothing looked up twice');
});

await t('the count: each country once, and a member with no Country counts where their city is', async () => {
  add('uk1.example', { location: 'London', country: 'UK' });
  add('uk2.example', { location: 'London', country: 'United Kingdom' });
  await placeAll();
  // Netherlands, United States, Spain (Barcelona found, no Country), United Kingdom
  assert.equal((await list()).countries, 4);
});

await t('changing Location looks it up again; the old place never shows meanwhile', async () => {
  const e = JSON.parse(hash.get('ams.example'));
  hash.set('ams.example', JSON.stringify({ ...e, location: 'Copenhagen', country: 'Denmark' }));
  assert.deepEqual((await site('ams.example')).places, [], 'old place hidden');
  assert.ok(needsPlaces(JSON.parse(hash.get('ams.example'))));
  await placeAll();
  assert.equal((await site('ams.example')).places[0].name, 'Copenhagen');
});

await t('the lookup service down: nothing is marked, and it’s tried again on a later visit', async () => {
  add('tor.example', { location: 'Toronto', country: 'Canada' });
  geo.down = true;
  await placeAll();
  geo.down = false;
  assert.ok(!JSON.parse(hash.get('tor.example')).geo, 'not marked as missing');
  await placeAll();
  assert.equal((await site('tor.example')).places[0].name, 'Toronto');
});

await t('status page: how many are on the map, and who isn’t, with what to do', async () => {
  add('lost.example', { title: 'Lost Studio', location: 'Atlantis', country: '' });
  add('rough.example', { title: 'Rough Studio', location: 'Atlantis', country: 'Germany' });
  await placeAll();
  const html = await (await STATUS()).text();
  assert.match(html, /on the map\./);
  assert.match(html, /Not on the map, as their place wasn’t found: Lost Studio \(“Atlantis”\)/);
  assert.match(html, /middle of their country, as their city wasn’t found: Rough Studio/);
  assert.match(html, /Portland, Maine/);
});

clearInterval(keepAlive);
console.log(`\n${pass} passed`);
