// Card images: a cover and up to 5 more, all of the creative's work. Never a screenshot of the site.
//
// The sheet decides first:
//   Image   → the cover
//   Gallery → the images after it (without an Image, the first Gallery link is the cover)
// With no Gallery, the images are found on the site itself: the images in its homepage HTML,
// then, if that gives fewer than 6, the images on the rendered page (Microlink, for sites built
// in JavaScript), and the site's share image last. Each one is downloaded and size-checked, so
// logos, icons and thin strips drop out.
//
// Everything is captured once, on the card's first view, and stored in Vercel Blob.

import crypto from 'node:crypto';
import * as store from './store.js';
import { imageSize } from './imagesize.js';

// Swappable for tests.
export const deps = {
  put: async (...args) => (await import('@vercel/blob')).put(...args),
};

const MAX_IMAGES = 6; // cover + 5
const MAX_CANDIDATES = 24;
const MAX_BYTES = 8 * 1024 * 1024;
const RETRY_MS = 7 * 864e5; // a site with no usable images is looked at again after a week
const LOCK_MS = 45_000; // another request already capturing this card
const UA = 'Mozilla/5.0 (compatible; GDGLibrary/1.0)';
const SKIP = /(^|[\/_.-])(logo|icon|favicon|sprite|avatar|emoji|badge|pixel|spacer|tracking|loader|placeholder|blank)([\/_.-]|$)/i;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

// ——— The sheet's choices ———

/** The admin's cover: Image, or else the first Gallery link. */
const coverSrc = (e) => e.image || e.picks?.[0] || '';

/** The admin's gallery: the Gallery links after the cover, up to 5. */
const pickedGallery = (e) => (e.image ? e.picks || [] : (e.picks || []).slice(1)).slice(0, MAX_IMAGES - 1);

const choiceKey = (e) => [coverSrc(e), ...((e.picks || []).length ? pickedGallery(e) : ['auto'])].join(' ');
const tag = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

/** Version tag for /api/cover and /api/gallery links, so new choices skip cached responses. */
export const version = (e) => tag(choiceKey(e));

/** After an edit to Image or Gallery, clear the stored images so they're captured again. */
export function recaptureIfChanged(prev, next) {
  if (choiceKey(prev) === choiceKey(next)) return;
  for (const k of ['thumb', 'gallery', 'galleryAt']) delete next[k];
}

/** True until the card's images are captured, and again a week after a capture that found nothing. */
export const needsCapture = (e) => !e.galleryAt || (!e.thumb && Date.now() - Date.parse(e.galleryAt) > RETRY_MS);

// ——— Finding images on the site ———

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/gi, '/');

/** Largest candidate in a srcset. */
function bestFromSrcset(srcset) {
  let best = null, bestW = -1;
  for (const part of srcset.split(/,\s+(?=\S)/)) {
    const [u, d] = part.trim().split(/\s+/);
    if (!u) continue;
    const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
    if (w > bestW) { bestW = w; best = u; }
  }
  return best;
}

/** Image URLs in page order, de-duplicated by path (keeping the largest srcset variant). The share image goes last. */
export function candidatesFromHtml(html, base) {
  const body = [], share = [];
  const add = (list, u) => {
    if (!u) return;
    u = decode(u.trim());
    if (/^data:|\.svg(\?|$)|^blob:/i.test(u)) return;
    try { u = new URL(u, base).toString(); } catch { return; }
    if (!/^https?:/i.test(u) || SKIP.test(new URL(u).pathname)) return;
    list.push(u);
  };
  const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];

  for (const m of html.matchAll(/<(img|source)\b[^>]*>/gi)) {
    const t = m[0];
    const w = parseInt(attr(t, 'width') || '0', 10);
    if (w && w < 300) continue;
    const set = attr(t, 'srcset') || attr(t, 'data-srcset');
    add(body, set ? bestFromSrcset(set) : attr(t, 'data-src') || attr(t, 'data-lazy-src') || attr(t, 'src'));
  }
  for (const m of html.matchAll(/<video\b[^>]*\sposter\s*=\s*["']([^"']+)["']/gi)) add(body, m[1]);
  for (const m of html.matchAll(/background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(body, m[1]);
  for (const m of html.matchAll(/<meta[^>]+>/gi)) {
    if (/(og:image|twitter:image)(:src)?["']/i.test(m[0])) add(share, attr(m[0], 'content'));
  }
  return dedupe([...body, ...share]).slice(0, MAX_CANDIDATES);
}

function dedupe(urls) {
  const seen = new Set();
  return urls.filter((u) => {
    let key;
    try { key = new URL(u).origin + new URL(u).pathname; } catch { return false; }
    return !seen.has(key) && seen.add(key);
  });
}

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) return { html: '', base: url };
    return { html: (await res.text()).slice(0, 1_500_000), base: res.url || url };
  } catch {
    return { html: '', base: url };
  }
}

/** Images on the rendered page, for sites built in JavaScript (Microlink: free 50 a day, or set MICROLINK_API_KEY). */
async function renderedImages(url) {
  const key = process.env.MICROLINK_API_KEY;
  const q = new URLSearchParams({
    url,
    meta: 'false',
    'data.images.selectorAll': 'img',
    'data.images.attr': 'src',
    'viewport.width': '1440',
    'viewport.height': '900',
    waitForTimeout: '1500',
  });
  try {
    const res = await fetch(`https://${key ? 'pro' : 'api'}.microlink.io/?${q}`, {
      headers: key ? { 'x-api-key': key } : {},
      signal: AbortSignal.timeout(25_000),
    });
    if (res.status === 429) return { limited: true, candidates: [] };
    const data = await res.json().catch(() => ({}));
    const imgs = data?.data?.images;
    const candidates = (Array.isArray(imgs) ? imgs : [])
      .map((x) => (typeof x === 'string' ? x : x?.url || x?.src))
      .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u) && !/\.svg(\?|$)/i.test(u) && !SKIP.test(new URL(u).pathname))
      .slice(0, MAX_CANDIDATES);
    return { candidates };
  } catch {
    return { limited: true, candidates: [] }; // timeouts count as "try again later"
  }
}

/** Download an image. `strict` keeps only images big enough to be work, not logos, icons or strips. */
async function download(src, strict = false) {
  try {
    const res = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !TYPES[type]) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    if (strict) {
      if (buf.length < 15_000) return null; // icons are tiny
      const size = imageSize(buf);
      if (!size) return null;
      const { w, h } = size;
      if (w < 700 || h < 450 || w / h > 2.6 || h / w > 2.2) return null;
    }
    return { src, buf, type };
  } catch {
    return null;
  }
}

/** Download candidates a few at a time, in order, until there are enough. */
async function pick(candidates, want, skip) {
  const kept = [];
  const queue = candidates.filter((u) => !skip.has(u));
  while (queue.length && kept.length < want) {
    const got = await Promise.all(queue.splice(0, 4).map((u) => download(u, true)));
    for (const g of got) if (g && kept.length < want) { kept.push(g); skip.add(g.src); }
  }
  return kept;
}

/** Up to `want` images of work from the site. `limited` when Microlink was needed but unavailable. */
async function fromSite(e, want, skip) {
  const { html, base } = await fetchHtml(e.url);
  const fromHtml = candidatesFromHtml(html, base);
  const share = e.og ? [e.og] : [];
  const kept = await pick(fromHtml.filter((u) => !share.includes(u)), want, skip);
  let limited = false;
  if (kept.length < want) {
    const r = await renderedImages(e.url);
    limited = !!r.limited;
    kept.push(...(await pick(r.candidates, want - kept.length, skip)));
  }
  if (kept.length < want) kept.push(...(await pick(share, want - kept.length, skip)));
  return { images: kept, limited };
}

// ——— Capture ———

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make sure a card has its images. Returns the updated entry, or null when nothing could be
 * found right now because Microlink's daily limit was reached (try again later).
 */
export async function captureImages(id, e) {
  if (!needsCapture(e)) return e;

  // The cover and the gallery are asked for together: one request captures, the other waits for it.
  if (!(await store.lock(id, LOCK_MS))) {
    for (let waited = 0; waited < LOCK_MS; waited += 1000) {
      await wait(1000);
      const [fresh] = await store.get([id]);
      if (!fresh || fresh.removedAt) return null;
      if (!needsCapture(fresh)) return fresh;
    }
    return null;
  }
  try {
    return await capture(id, e);
  } finally {
    await store.unlock(id);
  }
}

async function capture(id, e) {
  let images, limited = false;
  if ((e.picks || []).length) {
    // The admin chose every image: use them as they are, in order.
    images = (await Promise.all([coverSrc(e), ...pickedGallery(e)].map((u) => download(u)))).filter(Boolean);
  } else {
    const lead = e.image ? [await download(e.image)].filter(Boolean) : [];
    const found = await fromSite(e, MAX_IMAGES - lead.length, new Set(e.image ? [e.image] : []));
    images = [...lead, ...found.images];
    limited = found.limited;
  }

  if (!images.length && limited) return null;

  const stem = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
  const t = Date.now().toString(36);
  const urls = [];
  for (let i = 0; i < images.length; i++) {
    const blob = await deps.put(`sites/${stem}/${i}-${t}.${TYPES[images[i].type]}`, images[i].buf, {
      access: 'public', contentType: images[i].type, addRandomSuffix: false, cacheControlMaxAge: 31536000,
    });
    urls.push(blob.url);
  }
  return patch(id, { thumb: urls[0] || '', gallery: urls.slice(1), galleryAt: new Date().toISOString() });
}

// Merge fields into the latest copy of an entry (it may have changed while we worked).
async function patch(id, fields) {
  const [fresh] = await store.get([id]);
  if (!fresh || fresh.removedAt) return null;
  const next = { ...fresh, ...fields };
  await store.put({ [id]: next });
  return next;
}
