// Public list for the homepage. Newest first; only name, URL, host, title, company, location, country, availability, images and the (hidden) date go out.
import * as store from '../lib/store.js';
import { version, needsCapture } from '../lib/images.js';
import { countCountries } from '../lib/countries.js';

export async function GET() {
  try {
    const sites = (await store.all())
      .filter(([, e]) => !e.removedAt)
      .map(([id, e]) => ({
        title: e.title,
        url: e.url,
        host: e.host,
        practice: e.practice || '',
        company: e.company || '',
        location: e.location || '',
        available: !!e.available,
        country: e.country || '',
        added: e.added, // not shown; orders Latest
        // Cover + up to 5 more, all of their work. Until captured, where to fetch them.
        ...(needsCapture(e)
          ? { image: `/api/cover?id=${encodeURIComponent(id)}&v=${version(e)}`, galleryUrl: `/api/gallery?id=${encodeURIComponent(id)}&v=${version(e)}` }
          : { image: e.thumb || '', gallery: e.gallery || [] }),
      }))
      .sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : a.title.localeCompare(b.title))); // newest first; same time → A–Z
    const countries = countCountries(sites.map((s) => s.country));
    return Response.json(
      { count: sites.length, countries, sites },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
