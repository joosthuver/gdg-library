// Browser tests: phones, tablet and desktop, light and dark, with real data through /api/sites (mocked).
// Run: npm run test:browser          (CHROMIUM_PATH=/path/to/chrome to use a specific browser)
// Screenshots land in test/shots/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ——— Static server for the repo ———
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;

// ——— Fixture: 40 sites, with the awkward cases real data will have ———
const PRACTICES = ['Designer', 'Product Designer', 'Creative Technologist', 'Photographer', 'Director', 'Art Director', 'Studio', 'Illustrator'];
const COUNTRIES = ['United States', 'United Kingdom', 'France', 'Japan', 'Chile', 'chile ', 'Germany', 'Norway', 'Canada, Denmark', 'Sweden'];
const LOCATIONS = ['San Francisco', 'Crail', 'Paris', 'Tokyo', 'Santiago', 'Valparaíso', 'Berlin', 'Oslo', 'Toronto and Copenhagen', 'Stockholm'];
const NAMES = ['Ondine', 'Halvard', 'Brume', 'Lindqvist', 'North Pole', 'Low Tide', 'Salt & Signal', 'Ota', 'Open Form', 'Reyes', 'Concrete', 'Field Notes', 'Paper Weight', 'Kiosk', 'Atlas', 'Signal', 'Common Ground', 'Marrow', 'Vessel', 'Quiet Hours'];
const day = 864e5;
const sites = Array.from({ length: 40 }, (_, i) => {
  const host = `${NAMES[i % NAMES.length].toLowerCase().replace(/[^a-z]+/g, '')}${i}.example`;
  const img = i % 10;
  return {
    title: `${NAMES[i % NAMES.length]} ${i < 20 ? 'Studio' : 'Works'}`,
    url: `https://${host}/`, host,
    practice: PRACTICES[i % PRACTICES.length], location: LOCATIONS[i % LOCATIONS.length], country: COUNTRIES[i % COUNTRIES.length],
    added: new Date(Date.UTC(2026, 9, 8) - i * day).toISOString(),
    image: `/test/fixtures/images/${String(img).padStart(2, '0')}.jpg`,
    ...(i % 3 === 0 ? { galleryUrl: `/api/gallery?id=${host}` } : { gallery: [`/test/fixtures/images/g/${String(img).padStart(2, '0')}-0.jpg`, `/test/fixtures/images/g/${String(img).padStart(2, '0')}-1.jpg`] }),
  };
});
// Edge cases
sites.push(
  { title: 'The Extraordinarily Long Name Studio for Experimental Typography and Moving Image Research', url: 'https://long.example/', host: 'an-unusually-long-hostname-for-a-portfolio.example', practice: 'Creative Technologist, Art Director', country: 'United Kingdom', added: '2020-01-01T00:00:00Z', image: '/test/fixtures/images/03.jpg', gallery: [] },
  { title: 'Ólafur Ærøe', url: 'https://olafur.example/', host: 'olafur.example', practice: 'Photographer', location: 'Reykjavík', country: 'Iceland', added: '2019-05-01T00:00:00Z', image: '', gallery: [] },
  { title: '3am Studio', url: 'https://3am.example/', host: '3am.example', practice: '', country: '', added: '2019-04-01T00:00:00Z', image: '/missing.jpg', gallery: [] },
);
const COUNTRY_COUNT = new Set(sites.flatMap((s) => s.country.split(/\s*(?:,|\band\b)\s*/).map((c) => c.trim().toLowerCase())).filter(Boolean)).size;
const API = { count: sites.length, countries: COUNTRY_COUNT, sites };

// ——— Devices ———
const D = (w, h) => ({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const VIEWPORTS = {
  'iPhone SE': devices['iPhone SE'],
  'iPhone 15': devices['iPhone 15'] || devices['iPhone 14'],
  'iPhone 15 Pro Max': devices['iPhone 15 Pro Max'] || devices['iPhone 14 Pro Max'],
  'iPhone landscape': devices['iPhone 15 landscape'] || devices['iPhone 14 landscape'],
  'iPad': devices['iPad (gen 7)'],
  'Laptop 1440': D(1440, 900),
  'Desktop 1920': D(1920, 1080),
  'Wide 2560': D(2560, 1440),
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

const results = [];
let failures = 0;
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok, detail });
  if (!ok) failures++;
}

async function open(opts, url = '', { api = API, gsapOn = true, reduced = false, scheme = 'light', gallery = [] } = {}) {
  const ctx = await browser.newContext({ ...opts, timezoneId: 'America/New_York', locale: 'en-US', colorScheme: scheme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  if (!gsapOn) await p.route('**/vendor/gsap/**', (r) => r.abort());
  await p.route('**/api/sites', (r) => (api === 500 ? r.fulfill({ status: 500, body: '{}' }) : r.fulfill({ json: api })));
  await p.route('**/api/gallery?**', (r) => { gallery.push(r.request().url()); r.fulfill({ json: { images: ['/test/fixtures/images/g/01-2.jpg', '/test/fixtures/images/g/02-1.jpg'] } }); });
  await p.goto(BASE + url);
  await p.waitForFunction(() => document.querySelector('#list').children.length > 0);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(1800);
  return { ctx, p, errors };
}

// ——— Layout + design rules, every viewport, both themes ———
for (const [name, dev] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark']) {
    const g = `${name} · ${scheme}`;
    const { ctx, p, errors } = await open(dev, '', { scheme });
    const r = await p.evaluate(() => {
      const vis = (el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      // Every element that directly holds visible text
      const sizes = new Set();
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('.sr, svg, [hidden]') || !vis(el)) continue;
        if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) sizes.add(getComputedStyle(el).fontSize);
      }
      const meta = document.querySelector('meta[name=viewport]').content;
      const dock = [...document.querySelectorAll('.dock > *')].map((e) => e.getBoundingClientRect());
      const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      const mark = document.querySelector('.top .mark').getBoundingClientRect();
      const tools = document.querySelector('.top .tools').getBoundingClientRect();
      const stats = document.querySelector('#stats').getBoundingClientRect();
      // Tap targets: the point 21px from center in each direction must still hit the control.
      const targets = [...document.querySelectorAll('.dock > *, .tools > *, .card .more')].filter(vis).filter((e) => { const b = e.getBoundingClientRect(); return b.top > 30 && b.bottom < innerHeight - 30; });
      const small = [];
      for (const t of targets) {
        const b = t.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
        for (const [dx, dy] of [[-21, 0], [21, 0], [0, -21], [0, 21]]) {
          const hit = document.elementFromPoint(cx + dx, cy + dy);
          if (!hit || !(t === hit || t.contains(hit))) { small.push(t.className || t.id); break; }
        }
      }
      const capOverflow = [...document.querySelectorAll('.card')].filter((c) => c.scrollWidth > c.clientWidth + 1).length;
      return {
        overflowX: document.documentElement.scrollWidth - innerWidth,
        font: document.fonts.check('40px "ABC Areal"'),
        sizes: [...sizes],
        bodyPx: parseFloat(getComputedStyle(document.body).fontSize),
        inputPx: parseFloat(getComputedStyle(document.querySelector('#q')).fontSize),
        ink: getComputedStyle(document.body).color,
        zoomLocked: /maximum-scale|user-scalable\s*=\s*no/i.test(meta),
        dockInside: dock.every((b) => b.left >= 0 && b.right <= innerWidth + 0.5),
        dockOverlap: dock.some((a, i) => dock.some((b, j) => i < j && overlap(a, b))),
        headerOverlap: overlap(mark, tools) || overlap(stats, tools) || overlap(stats, mark),
        small, capOverflow,
        stats: document.querySelector('#stats').textContent,
        clock: document.querySelector('#clock').textContent,
        eager: [...document.querySelectorAll('img.slide')].filter((i) => i.loading === 'eager').length,
        pills: [...new Set([...document.querySelectorAll('.dock .pill, .tools .pill')].map((e) => Math.round(e.getBoundingClientRect().height)))],
        circle: (() => { const m = document.querySelector('.card .more'); if (!m) return null; const b = m.getBoundingClientRect(), i = m.querySelector('svg').getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), Math.round(i.width), Math.round(i.height)].join('x'); })(),
      };
    });
    const touch = !!dev.hasTouch;
    check(g, 'no errors in the console', errors.length === 0, errors.join(' | '));
    check(g, 'no sideways scroll', r.overflowX <= 0, `${r.overflowX}px`);
    check(g, 'ABC Areal loaded', r.font);
    check(g, 'one type size on the page', r.sizes.length === 1, r.sizes.join(', '));
    check(g, 'type is 16px (body and search)', r.bodyPx === 16 && r.inputPx === 16, `${r.bodyPx}px / ${r.inputPx}px`);
    check(g, `ink is pure ${scheme === 'dark' ? 'white' : 'black'}`, r.ink === (scheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'), r.ink);
    check(g, 'pinch zoom left on', !r.zoomLocked);
    check(g, 'dock fits the screen, no pills overlapping', r.dockInside && !r.dockOverlap);
    check(g, 'logo, count and header pills don’t collide', !r.headerOverlap);
    check(g, 'tap targets ≥ 44px', r.small.length === 0, r.small.join(', '));
    check(g, 'card text stays inside cards', r.capOverflow === 0, `${r.capOverflow} cards`);
    check(g, 'clock shows UTC offset and time', /^UTC−4 \d{1,2}:\d{2}\s?(AM|PM)$/.test(r.clock), r.clock);
    check(g, 'live count is right', r.stats === `${sites.length} sites from ${COUNTRY_COUNT} countries`, r.stats);
    check(g, 'only the first 3 images load eagerly', r.eager <= 3, `${r.eager}`);
    check(g, 'pills are 40px tall', r.pills.length === 1 && r.pills[0] === 40, r.pills.join(','));
    check(g, 'circle buttons 32×32, icons 12×12', r.circle === '32x32x12x12', r.circle);
    await p.screenshot({ path: path.join(SHOTS, `${name.replace(/\s+/g, '-').toLowerCase()}-${scheme}.png`) });
    if (scheme === 'light' && !touch) {
      await p.click('#view'); await p.waitForTimeout(1200);
      await p.screenshot({ path: path.join(SHOTS, `${name.replace(/\s+/g, '-').toLowerCase()}-index.png`) });
    }
    await ctx.close();
  }
}

// ——— Interactions: one phone, one desktop ———
for (const [name, dev] of [['iPhone 15', VIEWPORTS['iPhone 15']], ['Laptop 1440', VIEWPORTS['Laptop 1440']]]) {
  const g = `${name} · interactions`;
  const touch = !!dev.hasTouch;
  const tap = (p, sel) => (touch ? p.tap(sel) : p.click(sel));
  const gallery = [];
  const { ctx, p, errors } = await open(dev, '', { gallery });

  // Card panel
  const first = '.card:nth-child(1)';
  await tap(p, `${first} .more`); await p.waitForTimeout(800);
  check(g, '+ opens the frosted panel', await p.isVisible(`${first} .panel`));
  check(g, 'focus moves to × in the panel', await p.evaluate((s) => document.activeElement === document.querySelector(`${s} .x`), first));
  check(g, 'panel lists practice, location and Visit link', await p.evaluate((s) => { const t = document.querySelector(`${s} .panel`).innerText; return /Designer/.test(t) && /San Francisco/.test(t) && /Visit site/.test(t); }, first));
  await tap(p, `${first} .x`); await p.waitForTimeout(700);
  check(g, '× closes it, focus back on +', !(await p.isVisible(`${first} .panel`)) && await p.evaluate((s) => document.activeElement === document.querySelector(`${s} .more`), first));
  await tap(p, `${first} .more`); await p.waitForTimeout(700); await p.keyboard.press('Escape'); await p.waitForTimeout(700);
  check(g, 'Esc closes the panel', !(await p.isVisible(`${first} .panel`)));
  await tap(p, '.card:nth-child(1) .more'); await p.waitForTimeout(500); await tap(p, '.card:nth-child(2) .more'); await p.waitForTimeout(700);
  check(g, 'only one panel open at a time', (await p.locator('.panel:not([hidden])').count()) === 1);
  await p.keyboard.press('Escape'); await p.waitForTimeout(600);

  // Info panel
  await tap(p, '#info-open'); await p.waitForTimeout(900);
  check(g, 'logo opens the info panel at #info', (await p.isVisible('#info')) && new URL(p.url()).hash === '#info');
  const cols = await p.evaluate(() => { const ps = [...document.querySelectorAll('#info .copy > p')].map((e) => e.getBoundingClientRect()); const x = document.querySelector('#info .x').getBoundingClientRect(); return { lefts: ps.map((b) => Math.round(b.left)), x: [Math.round(x.width), Math.round(x.height)] }; });
  check(g, touch ? 'info: one column on phones' : 'info: two columns on desktop', touch ? new Set(cols.lefts).size === 1 : (cols.lefts[1] > cols.lefts[0] + 100 && cols.lefts[1] === cols.lefts[2]), cols.lefts.join(','));
  check(g, 'info close button is 32×32', cols.x.join('x') === '32x32', cols.x.join('x'));
  check(g, 'info panel has the copy and font credit', /Global Design Group \[GDG\]/.test(await p.innerText('#info')) && /Areal by Dinamo/.test(await p.innerText('#info')));
  await p.goBack(); await p.waitForTimeout(800);
  check(g, 'back button closes the info panel', !(await p.isVisible('#info')));
  await tap(p, '#info-open'); await p.waitForTimeout(700); await tap(p, '#info-close'); await p.waitForTimeout(800);
  check(g, '× closes the info panel and clears #info', !(await p.isVisible('#info')) && new URL(p.url()).hash === '');

  // Images
  const before = await p.evaluate(() => [...document.querySelectorAll('.card')].slice(0, 3).map((c) => c.querySelectorAll('img.slide').length));
  check(g, 'cards near the screen load their extra images', before.some((n) => n > 1), before.join(','));
  check(g, 'gallery fetched only for cards near the screen', gallery.length > 0 && gallery.length <= 6, `${gallery.length} requests`);
  if (touch) {
    const at = async () => p.evaluate(() => [...document.querySelectorAll('.card')].slice(0, 2).map((c) => [...c.querySelectorAll('img.slide')].findIndex((i) => i.classList.contains('on'))).join(','));
    const a = await at(); await p.waitForTimeout(3400); const b = await at();
    check(g, 'touch: cards on screen cycle their images', a !== b, `${a} → ${b}`);
  } else {
    const m = await p.locator('.card:nth-child(2) .media').boundingBox();
    await p.mouse.move(m.x + 5, m.y + m.height / 2); await p.mouse.move(m.x + m.width - 5, m.y + m.height / 2, { steps: 5 }); await p.waitForTimeout(600);
    const idx = await p.evaluate(() => [...document.querySelectorAll('.card:nth-child(2) img.slide')].findIndex((i) => i.classList.contains('on')));
    check(g, 'mouse: moving across a card flips its images', idx > 0, `slide ${idx}`);
    await p.mouse.move(m.x + m.width / 2, m.y - 60); await p.waitForTimeout(600);
    const back = await p.evaluate(() => [...document.querySelectorAll('.card:nth-child(2) img.slide')].findIndex((i) => i.classList.contains('on')));
    check(g, 'mouse: leaving a card returns to the cover', back === 0, `slide ${back}`);
  }

  // Views, sort, search, URL state
  await tap(p, '#view'); await p.waitForTimeout(900);
  check(g, 'Index shows every site', (await p.locator('a.row').count()) === sites.length);
  if (!touch) {
    await p.mouse.move(400, 400); await p.hover('a.row:nth-of-type(3)'); await p.waitForTimeout(400);
    check(g, 'Index: hovering a row shows its preview', await p.isVisible('#peek'));
  } else check(g, 'Index: no hover preview on touch', !(await p.isVisible('#peek')));
  await tap(p, '#sort'); await p.waitForTimeout(900);
  const names = await p.$$eval('a.row .t', (els) => els.map((e) => e.textContent));
  const col = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  const key = (t) => t.replace(/^(the|a)\s+/i, '');
  check(g, 'A–Z sorts by name (ignoring “The”)', names.every((n, i) => i === 0 || col.compare(key(names[i - 1]), key(n)) <= 0));
  await p.reload(); await p.waitForSelector('a.row'); await p.waitForTimeout(800);
  check(g, 'reload keeps Index + A–Z (from the URL)', (await p.textContent('#view')) === 'Index' && (await p.textContent('#sort')) === 'A–Z');
  await tap(p, '#sort'); await p.waitForTimeout(900);
  const dates = await p.evaluate(() => [...document.querySelectorAll('a.row .t')].map((e) => e.textContent));
  check(g, 'Latest puts the newest first', dates[0] === sites[0].title);
  await p.fill('#q', 'photographer'); await p.waitForTimeout(300);
  check(g, 'search matches practice', (await p.locator('a.row').count()) === sites.filter((s) => /photographer/i.test(s.practice)).length);
  await p.fill('#q', 'copenhagen'); await p.waitForTimeout(300);
  check(g, 'search matches location', (await p.locator('a.row').count()) === sites.filter((s) => /copenhagen/i.test(s.location || '')).length);
  check(g, 'Index shows the location column', /Toronto and Copenhagen/.test(await p.textContent('#list')));
  await p.fill('#q', 'japan'); await p.waitForTimeout(300);
  check(g, 'search matches country', (await p.locator('a.row').count()) === sites.filter((s) => /japan/i.test(s.country)).length);
  await p.fill('#q', 'zzzz'); await p.waitForTimeout(300);
  check(g, 'no matches shows a message', /No sites match/.test(await p.textContent('#list')));
  await p.fill('#q', '');

  // Theme
  const t0 = await p.textContent('#theme');
  await tap(p, '#theme'); await p.waitForTimeout(400);
  const t1 = await p.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).color]);
  check(g, 'theme pill switches to dark', t0 === 'Light' && t1[0] === 'dark' && t1[1] === 'rgb(255, 255, 255)');
  await p.reload(); await p.waitForFunction(() => document.querySelector('#list').children.length > 0);
  check(g, 'theme choice survives a reload', (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark');

  // Fallback card + broken image
  await p.evaluate(() => { document.querySelector('#view').textContent === 'Index' && document.querySelector('#view').click(); });
  await p.waitForTimeout(900);
  check(g, 'site with no image shows the text card', await p.evaluate(() => [...document.querySelectorAll('.card')].some((c) => /Ólafur/.test(c.textContent) && !c.querySelector('img.slide'))));
  await p.evaluate(() => [...document.querySelectorAll('.card')].find((c) => /3am Studio/.test(c.textContent)).scrollIntoView());
  await p.waitForTimeout(1200);
  check(g, 'broken image falls back to the text card', await p.evaluate(() => [...document.querySelectorAll('.card')].some((c) => /3am Studio/.test(c.textContent) && !c.querySelector('img.slide'))));
  check(g, 'no errors in the console', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ——— GDG logo: size, place, color in both modes ———
{
  const M390 = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: devices['iPhone 15']?.userAgent || devices['iPhone 14'].userAgent };
  for (const [vp, dev, wantW] of [['Desktop 1440', VIEWPORTS['Laptop 1440'], 64], ['Mobile 390', M390, (390 - 32 - 11 * 12) / 12 * 3 + 2 * 12]]) {
    for (const scheme of ['light', 'dark']) {
      const g = `Logo · ${vp} · ${scheme}`;
      const { ctx, p, errors } = await open(dev, '', { scheme });
      const r = await p.evaluate(() => {
        const mark = document.querySelector('.top .mark');
        const b = mark.getBoundingClientRect();
        return {
          w: b.width, h: b.height, x: b.left, y: b.top,
          color: getComputedStyle(mark).color, ink: getComputedStyle(document.body).color,
          label: mark.getAttribute('aria-label'), role: mark.getAttribute('role'),
          still: mark.getAnimations({ subtree: true }).length === 0,
        };
      });
      check(g, `logo is ${Math.round(wantW * 10) / 10}px wide at the top left`, Math.abs(r.w - wantW) < 0.6 && Math.abs(r.x - 16) < 0.6 && Math.abs(r.y - 16) < 0.6, `${r.w.toFixed(1)}×${r.h.toFixed(1)} at ${r.x},${r.y}`);
      check(g, 'logo keeps its shape', Math.abs(r.w / r.h - 906.49 / 785.05) < 0.01);
      check(g, `logo draws in the ${scheme} ink`, r.color === r.ink && r.color === (scheme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)'), r.color);
      check(g, 'logo is static and labelled for screen readers', r.still && r.role === 'img' && r.label === 'Global Design Group');
      check(g, 'no errors in the console', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  }
}

// ——— Deep link, motion off, GSAP missing, empty, API down ———
{
  const { ctx, p } = await open(VIEWPORTS['iPhone 15'], '#info');
  check('Edge cases', '#info link opens the info panel on load', await p.isVisible('#info'));
  await ctx.close();
}
{
  const { ctx, p, errors } = await open(VIEWPORTS['Laptop 1440'], '', { reduced: true });
  await p.click('.card:nth-child(1) .more');
  const instant = await p.evaluate(() => !document.querySelector('.card:nth-child(1) .panel').hidden && (window.gsap ? window.gsap.getTweensOf(document.querySelector('.card:nth-child(1) .panel')).length === 0 : true));
  check('Edge cases', 'reduced motion: panels open instantly, no tweens', instant);
  check('Edge cases', 'reduced motion: cards visible without scroll animation', await p.evaluate(() => getComputedStyle(document.querySelector('.card')).opacity === '1'));
  check('Edge cases', 'reduced motion: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, p, errors } = await open(VIEWPORTS['iPhone 15'], '', { gsapOn: false });
  await p.tap('.card:nth-child(1) .more');
  check('Edge cases', 'GSAP blocked: page works, panels open', await p.isVisible('.card:nth-child(1) .panel'));
  check('Edge cases', 'GSAP blocked: count still shows', /sites/.test(await p.textContent('#stats')));
  check('Edge cases', 'GSAP blocked: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, p } = await open(VIEWPORTS['Laptop 1440'], '', { api: { count: 0, countries: 0, sites: [] } });
  check('Edge cases', 'empty index says “Nothing here yet.”', /Nothing here yet/.test(await p.textContent('#list')) && (await p.textContent('#stats')) === '');
  await ctx.close();
}
{
  const { ctx, p } = await open(VIEWPORTS['Laptop 1440'], '', { api: 500 });
  check('Edge cases', 'API down shows a plain message', /unavailable right now/.test(await p.textContent('#list')));
  await ctx.close();
}

await browser.close();
server.close();

// ——— Report ———
const groups = [...new Set(results.map((r) => r.group))];
for (const g of groups) {
  const rs = results.filter((r) => r.group === g);
  const bad = rs.filter((r) => !r.ok);
  console.log(`${bad.length ? '✗' : '✓'} ${g}  (${rs.length - bad.length}/${rs.length})`);
  for (const b of bad) console.log(`    ✗ ${b.name}${b.detail ? ` — ${b.detail}` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed. Screenshots: test/shots/`);
process.exit(failures ? 1 : 0);
