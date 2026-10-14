// URL normalizing + page title lookup.

const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|si$)/i;

/** Stable id for a site so the same link posted twice lands on one entry. */
export function normalize(raw) {
  const u = new URL(raw);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  return s;
}

/** Display form of the link: tracking params and hash removed, protocol kept. */
export function tidy(raw) {
  const u = new URL(raw);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

export function host(raw) {
  return new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function privateHost(h) {
  return /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith('.local') || h.includes(':') /* ipv6 literal */;
}

/** A page title as a name: "Pedro Barroso - Designer and Creative Director — Home" → "Pedro Barroso". */
export function nameFromTitle(t) {
  const clean = String(t || '').replace(/\s+/g, ' ').trim();
  const first = clean.split(/\s+[|—–\-·•:]\s+/)[0].trim();
  return (first.length >= 2 ? first : clean).slice(0, 140);
}

/** Best-effort page title + share image. Quick timeout so the Slack request stays under 3 s. */
export async function fetchMeta(url, ms = 1500) {
  try {
    const h = new URL(url).hostname;
    if (privateHost(h)) return {};
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(ms),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GDGLibrary/1.0)', Accept: 'text/html' },
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('html')) return {};
    // Read only the head of the document.
    const reader = res.body.getReader();
    let html = '';
    const dec = new TextDecoder();
    while (html.length < 150_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    const meta = (name) =>
      (html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] ||
       html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'))?.[1] || '').trim();
    const t = meta('og:title') || (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '').trim() || meta('og:site_name');
    let image = decode(meta('og:image') || meta('twitter:image'));
    try { image = image ? new URL(image, res.url || url).toString() : ''; } catch { image = ''; }
    return { title: nameFromTitle(decode(t)), image: /^https:\/\//.test(image) ? image : '' };
  } catch {
    return {};
  }
}
