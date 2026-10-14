// Card images: work only, found on the site or chosen in the sheet, stored in Blob. Never a screenshot.
import assert from 'node:assert/strict';
import { hash } from './mocks.js';

Object.assign(process.env, { KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 'redis-token', ADMIN_TOKEN: 'admin-token' });

const { imageSize } = await import('../lib/imagesize.js');
const { deps, candidatesFromHtml, recaptureIfChanged, version, needsCapture } = await import('../lib/images.js');
const { GET: COVER } = await import('../api/cover.js');
const { GET: GALLERY } = await import('../api/gallery.js');
const { GET: SITES } = await import('../api/sites.js');
const { POST: IMPORT } = await import('../api/import.js');

// ——— Fake image bytes with real headers ———
const pad = (b, n = 20000) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length))]);
const png = (w, h, n) => { const b = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return pad(b, n); };
const jpg = (w, h, n) => { const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]); return pad(b, n); };
const webp = (w, h, n) => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8X', 12); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return pad(b, n); };
const gif = (w, h) => { const b = Buffer.alloc(30); b.write('GIF89a', 0); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };

const work = () => ['image/jpeg', jpg(1600, 1000)];
const images = {
  'https://work.example/img/hero.jpg': work(),
  'https://work.example/img/project-2400.jpg': ['image/jpeg', jpg(2400, 1500)],
  'https://work.example/img/project-800.jpg': ['image/jpeg', jpg(800, 500)],
  'https://work.example/img/logo.png': ['image/png', png(1200, 800)],
  'https://work.example/img/tiny.png': ['image/png', png(64, 64)],
  'https://work.example/img/small-bytes.jpg': ['image/jpeg', jpg(1600, 1000, 4000)],
  'https://work.example/img/strip.jpg': ['image/jpeg', jpg(3000, 300)],
  'https://work.example/share.png': ['image/png', png(1200, 630)],
  'https://work.example/img/plate.webp': ['image/webp', webp(1400, 900)],
  'https://cdn.example/a.jpg': work(),
  'https://cdn.example/b.jpg': work(),
  'https://cdn.example/c.jpg': work(),
  'https://cdn.example/d.jpg': work(),
  'https://cdn.example/e.jpg': work(),
  'https://cdn.example/f.jpg': work(),
  'https://cdn.example/g.jpg': work(),
  'https://js.example/rendered-1.jpg': work(),
  'https://js.example/rendered-2.jpg': work(),
  'https://js.example/share.jpg': work(),
  'https://picks.example/cover.jpg': work(),
  'https://picks.example/1.jpg': work(),
  'https://picks.example/2.jpg': work(),
  'https://picks.example/small.png': ['image/png', png(400, 300)],
};
const PAGE = `<!doctype html><html><head>
<meta property="og:image" content="/share.png">
</head><body>
<img src="/img/logo.png" alt="Studio">
<img src="/img/hero.jpg" width="1600">
<img srcset="/img/project-800.jpg 800w, /img/project-2400.jpg 2400w" src="/img/project-800.jpg">
<img src="/img/tiny.png" width="64">
<img src="/img/small-bytes.jpg">
<img src="/img/strip.jpg">
<img data-src="/img/plate.webp" src="data:image/gif;base64,R0lGOD">
<img src="/img/mark.svg">
<div style="background-image:url('https://cdn.example/a.jpg')"></div>
</body></html>`;
const FULL = `<html><body>${['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `<img src="https://cdn.example/${x}.jpg">`).join('')}</body></html>`;
const pages = {
  'https://work.example/': PAGE,
  'https://full.example/': FULL,
  'https://js.example/': '<html><body><div id="app"></div></body></html>',
  'https://bare.example/': '<html><body>no images</body></html>',
};

// ——— Mocks: sites, image hosts, Microlink, Blob ———
let microlink = 'ok'; // 'ok' | 'limited' | 'fail'
let microCalls = 0;
const fetched = [];
const puts = [];
deps.put = async (name) => { puts.push(name); return { url: `https://abc.public.blob.vercel-storage.com/${name}` }; };
const mocked = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  fetched.push(url);
  if (url.startsWith('https://api.microlink.io/')) {
    microCalls++;
    assert.ok(!new URL(url).searchParams.has('screenshot'), 'never asks for a screenshot');
    if (microlink === 'limited') return new Response('{}', { status: 429 });
    if (microlink === 'fail') return Response.json({ status: 'fail' });
    const target = new URL(url).searchParams.get('url');
    const rendered = target === 'https://js.example/' ? ['https://js.example/rendered-1.jpg', 'https://js.example/logo.png', 'https://js.example/rendered-2.jpg'] : [];
    return Response.json({ status: 'success', data: { images: rendered.map((u) => ({ url: u })) } });
  }
  if (pages[url]) return new Response(pages[url], { headers: { 'content-type': 'text/html' } });
  if (images[url]) return new Response(images[url][1], { headers: { 'content-type': images[url][0] } });
  if (url.startsWith('https://notimage.example/')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
  return mocked(url, opts);
};

const entry = (h, url, extra = {}) => hash.set(h, JSON.stringify({ url, host: h, title: h, added: new Date().toISOString(), srcs: ['import'], ...extra }));
const stored = (h) => JSON.parse(hash.get(h));
const list = async () => (await (await SITES()).json()).sites;
const site = async (h) => (await list()).find((s) => s.host === h);
const cover = (h) => COVER(new Request(`https://x/api/cover?id=${h}&v=1`));
const gallery = async (h) => (await (await GALLERY(new Request(`https://x/api/gallery?id=${h}&v=1`))).json()).images;
const imp = (sites) => IMPORT(new Request('https://x/api/import', { method: 'POST', headers: { authorization: 'Bearer admin-token' }, body: JSON.stringify({ sites }) }));

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ✓ ' + name); };
const keepAlive = setInterval(() => {}, 1000);
console.log('Card images');

await t('reads sizes from JPEG, PNG, WebP and GIF headers', async () => {
  assert.deepEqual(imageSize(jpg(1600, 1000)), { w: 1600, h: 1000 });
  assert.deepEqual(imageSize(png(1200, 630)), { w: 1200, h: 630 });
  assert.deepEqual(imageSize(webp(1400, 900)), { w: 1400, h: 900 });
  assert.deepEqual(imageSize(gif(640, 480)), { w: 640, h: 480 });
  assert.equal(imageSize(Buffer.from('not an image at all, just some text here')), null);
});

await t('finds images in page order, largest srcset, lazy data-src, backgrounds; never the share image; skips svg, data:, logos', async () => {
  const c = candidatesFromHtml(PAGE, 'https://work.example/');
  assert.equal(c[0], 'https://work.example/img/hero.jpg');
  assert.ok(!c.includes('https://work.example/share.png'), 'share image never a candidate');
  assert.ok(c.includes('https://work.example/img/project-2400.jpg'));
  assert.ok(!c.includes('https://work.example/img/project-800.jpg'), 'smaller srcset variant dropped');
  assert.ok(c.includes('https://work.example/img/plate.webp'));
  assert.ok(c.includes('https://cdn.example/a.jpg'));
  assert.ok(!c.some((u) => /logo|\.svg|^data:|tiny/.test(u)));
});

await t('before capture, the card points at /api/cover and /api/gallery', async () => {
  entry('full.example', 'https://full.example/');
  const s = await site('full.example');
  assert.match(s.image, /^\/api\/cover\?id=full\.example&v=\w{8}$/);
  assert.match(s.galleryUrl, /^\/api\/gallery\?id=full\.example&v=\w{8}$/);
});

await t('first view: 6 images of work from the page, cover first; no screenshot service needed', async () => {
  const n = microCalls;
  const r = await cover('full.example');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^https:\/\/abc\.public\.blob\.vercel-storage\.com\/sites\/\w{16}\/0-\w+\.jpg$/);
  assert.equal(microCalls, n, 'page had enough');
  const s = await site('full.example');
  assert.equal(s.image, r.headers.get('location'));
  assert.equal(s.gallery.length, 5);
  assert.ok(!('galleryUrl' in s));
});

await t('later views reuse what was stored', async () => {
  const p = puts.length;
  assert.equal((await gallery('full.example')).length, 5);
  assert.equal((await cover('full.example')).status, 302);
  assert.equal(puts.length, p);
});

await t('size check drops logos, icons, tiny files and strips; the share image is never used', async () => {
  entry('work.example', 'https://work.example/');
  await cover('work.example');
  const e = stored('work.example');
  assert.equal(e.gallery.length, 3, 'hero is the cover, then project-2400, plate, a.jpg — no share.png');
  const fromPage = fetched.filter((u) => u.startsWith('https://work.example/img/'));
  assert.ok(!fromPage.includes('https://work.example/img/mark.svg'));
});

await t('sites built in JavaScript: images from the rendered page', async () => {
  entry('js.example', 'https://js.example/', { og: 'https://js.example/share.jpg' });
  const r = await cover('js.example');
  assert.equal(r.status, 302);
  const e = stored('js.example');
  assert.equal(e.gallery.length, 1, 'rendered-1 is the cover, then rendered-2 — not the share image');
});

await t('Microlink at its daily limit and nothing on the page → nothing stored, tried again later', async () => {
  microlink = 'limited';
  entry('js2.example', 'https://js.example/');
  const r = await cover('js2.example');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('cache-control'), /s-maxage=600/);
  assert.ok(needsCapture(stored('js2.example')));
  microlink = 'ok';
  assert.equal((await cover('js2.example')).status, 302);
});

await t('no usable images anywhere → text card, looked at again after a week', async () => {
  entry('bare.example', 'https://bare.example/');
  assert.equal((await cover('bare.example')).status, 404);
  const s = await site('bare.example');
  assert.equal(s.image, '', 'page shows the text card without asking again');
  assert.deepEqual(s.gallery, []);
  const e = stored('bare.example');
  assert.ok(!needsCapture(e));
  assert.ok(needsCapture({ ...e, galleryAt: new Date(Date.now() - 8 * 864e5).toISOString() }));
});

await t('cover and gallery asked for at once → captured once', async () => {
  entry('both.example', 'https://full.example/');
  const p = puts.length;
  const [r, g] = await Promise.all([cover('both.example'), gallery('both.example')]);
  assert.equal(r.status, 302);
  assert.equal(g.length, 5);
  assert.equal(puts.length - p, 6);
});

await t('Image column: that is the cover, then images from the site (not repeated)', async () => {
  await imp([{ url: 'https://work.example/', title: 'Work', image: 'https://cdn.example/a.jpg' }]);
  await cover('work.example');
  const e = stored('work.example');
  assert.equal(e.gallery.length, 3, 'hero, project-2400, plate — a.jpg not repeated, no share image');
});

await t('Gallery links with an Image: used as chosen, any size, without looking at the site', async () => {
  entry('p1.example', 'https://p1.example/', { image: 'https://picks.example/cover.jpg', picks: ['https://picks.example/1.jpg', 'https://picks.example/2.jpg', 'https://picks.example/small.png'] });
  const before = fetched.length;
  assert.equal((await cover('p1.example')).status, 302);
  assert.equal(stored('p1.example').gallery.length, 3);
  assert.ok(!fetched.slice(before).some((u) => u.includes('p1.example') || u.includes('microlink')));
});

await t('Gallery links without an Image: the first is the cover', async () => {
  entry('p2.example', 'https://p2.example/', { picks: ['https://picks.example/1.jpg', 'https://picks.example/2.jpg'] });
  await cover('p2.example');
  const e = stored('p2.example');
  assert.match(e.thumb, /\/0-/);
  assert.equal(e.gallery.length, 1);
});

await t('changing Image or Gallery clears the stored images and the link version; no change keeps them', async () => {
  const base = { image: 'https://picks.example/cover.jpg', picks: ['https://picks.example/1.jpg'], thumb: 't', gallery: ['g'], galleryAt: 'd' };
  const same = { ...base };
  recaptureIfChanged(base, same);
  assert.equal(same.thumb, 't');
  const changed = { ...base, picks: ['https://picks.example/2.jpg'] };
  recaptureIfChanged(base, changed);
  assert.ok(!changed.thumb && !changed.galleryAt);
  assert.notEqual(version(base), version(changed));
  const cleared = { ...base, image: '', picks: [] };
  recaptureIfChanged(base, cleared);
  assert.ok(!cleared.galleryAt, 'back to images from the site');
});

await t('import with a new Image recaptures; one that is not an image falls back to the site', async () => {
  await imp([{ url: 'https://full.example/', image: 'https://notimage.example/page' }]);
  assert.ok(needsCapture(stored('full.example')));
  assert.equal((await cover('full.example')).status, 302);
  assert.equal(stored('full.example').gallery.length, 5, 'six from the page, the bad link skipped');
});

await t('a card captured under the old rules (share image allowed) is captured again once; chosen Gallery images are left alone', async () => {
  const now = new Date().toISOString();
  const old = { url: 'https://work.example/', thumb: 'https://abc.public.blob.vercel-storage.com/sites/x/0.png', gallery: [], galleryAt: now };
  assert.ok(needsCapture(old), 'found automatically before the rule: look again');
  assert.ok(!needsCapture({ ...old, rule: 2 }), 'already captured under the current rule');
  assert.ok(!needsCapture({ ...old, picks: ['https://cdn.example/a.jpg'] }), 'chosen in the Gallery: kept');
  entry('again.example', 'https://work.example/', { og: 'https://work.example/share.png', ...old });
  await cover('again.example');
  const e = stored('again.example');
  assert.equal(e.rule, 2);
  assert.notEqual(e.thumb, old.thumb);
  assert.ok(!needsCapture(e), 'only once');
});

await t('unknown or removed id → 404', async () => {
  assert.equal((await cover('nope.example')).status, 404);
  assert.equal((await COVER(new Request('https://x/api/cover'))).status, 404);
  assert.equal((await GALLERY(new Request('https://x/api/gallery?id=nope.example'))).status, 404);
});

clearInterval(keepAlive);
console.log(`\n${pass} passed`);
