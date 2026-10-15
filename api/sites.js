// Public list for the homepage. Serving it also keeps the site in step with the sheet: at most every
// 10 minutes, sheet edits (names, titles, availability, images…) are copied over in the background,
// and members whose places aren't known yet are put on the map.
// Newest first; only name, URL, host, title, company, location, country, availability, images, places
// and the (hidden) date go out.
import * as store from '../lib/store.js';
import { version, needsCapture } from '../lib/images.js';
import { countCountries, countryList } from '../lib/countries.js';
import { placesOf, placeMembers } from '../lib/places.js';
import { enabled as sheetEnabled } from '../lib/sheet.js';
import { runSync } from '../lib/check.js';
import { waitUntil } from '@vercel/functions';

const SYNC_EVERY = 600; // seconds
const PLACE_EVERY = 60; // seconds between background place lookups

/** Copy sheet edits to the site, if nobody has in the last 10 minutes. Never throws. */
export async function freshen() {
  try {
    if (sheetEnabled() && (await store.claim('sync', SYNC_EVERY))) await runSync();
  } catch (err) { console.error('background sync failed', err); }
}

/** Put members on the map whose places aren't known yet, at most once a minute. Never throws. */
export async function place() {
  try {
    if (await store.claim('place', PLACE_EVERY)) await placeMembers();
  } catch (err) { console.error('placing members failed', err); }
}

export async function GET() {
  try {
    const live = (await store.all()).filter(([, e]) => !e.removedAt);
    const sites = live
      .map(([id, e]) => ({
        title: e.title,
        url: e.url,
        host: e.host,
        practice: e.practice || '',
        company: e.company || '',
        location: e.location || '',
        available: !!e.available,
        country: e.country || '',
        places: (placesOf(e) || []).map(({ name, lat, lng, tz, level }) => ({ name, lat, lng, tz, level })),
        added: e.added, // not shown; orders Latest
        // Cover + up to 5 more, all of their work. Until captured, where to fetch them.
        ...(needsCapture(e)
          ? { image: `/api/cover?id=${encodeURIComponent(id)}&v=${version(e)}`, galleryUrl: `/api/gallery?id=${encodeURIComponent(id)}&v=${version(e)}` }
          : { image: e.thumb || '', gallery: e.gallery || [] }),
      }))
      .sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : a.title.localeCompare(b.title))); // newest first; same time → A–Z
    // Each country once; a member with no Country counts where their city was found.
    const countries = countCountries(live.map(([, e]) => {
      const named = countryList(e.country);
      return named.length ? named : (placesOf(e) || []).map((p) => p.country).filter(Boolean);
    }));
    waitUntil(Promise.all([freshen(), place()])); // after the response, so the page never waits
    return Response.json(
      { count: sites.length, countries, sites },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }
}
