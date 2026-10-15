// Where each member is, for the Map view.
//
// Location can hold several places ("Toronto and Copenhagen", "Berlin / London"). Each one is:
//   a country on its own ("USA")    → the middle of that country
//   a city ("Amsterdam")            → looked up by name, in their country when Country is filled in,
//                                     with its time zone for the local time on the map
//   "City, Region" or "Area, City"  → the first part that's found; the others pick between places
//                                     with the same name ("Portland, Maine")
// A city that can't be found shows in the middle of its country; with no country either, it's left
// off the map (the status page lists it) and looked for again a week later.
// Found once, kept on the listing, and found again only when Location or Country changes.

import * as store from './store.js';
import { canonicalCountry, countryCenter, countryList, isCountry } from './countries.js';

const LOOKUP = 'https://geocoding-api.open-meteo.com/v1/search';
const RETRY_MS = 7 * 864e5;
const PER_RUN = 8; // lookups per background run; the rest wait for the next visit

const round = (n) => Math.round(n * 1000) / 1000;
const tidy = (s) => String(s || '').trim().replace(/\s+/g, ' ');

/** What the places were found from; a change means looking again. */
export const placeKey = (e) => `${tidy(e.location).toLowerCase()}|${tidy(e.country).toLowerCase()}`;

/** The places as of the current Location and Country, or null while they haven't been looked up. */
export const placesOf = (e) => (e.geo && e.geo.key === placeKey(e) ? e.geo.places : null);

export const needsPlaces = (e) => !e.geo || e.geo.key !== placeKey(e)
  || (!e.geo.places.length && e.geo.missing.length > 0 && Date.now() - Date.parse(e.geo.at) > RETRY_MS);

const splitPlaces = (s) => (isCountry(s) ? [tidy(s)]
  : tidy(s).split(/\s*(?:;|\/|&|\+|\||\band\b)\s*/i).map(tidy).filter(Boolean));

function countryPlace(name) {
  const c = canonicalCountry(name), at = countryCenter(c);
  return at ? { name: c, lat: at[0], lng: at[1], tz: '', country: c, level: 'country' } : null;
}

async function search(name) {
  const url = `${LOOKUP}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`place lookup ${res.status}`);
  return (await res.json()).results || [];
}

/** The likeliest match: in one of their countries (when given), helped by the other parts of what they wrote. */
function pick(results, countries, hints) {
  let top = null, best = -Infinity;
  results.forEach((r, i) => {
    if (countries.length && !countries.includes(canonicalCountry(r.country))) return;
    let score = -i; // the lookup lists bigger, better-known places first
    for (const h of hints) {
      const hl = h.toLowerCase();
      if ([r.admin1, r.admin2, r.admin3, r.admin4].some((a) => a && a.toLowerCase() === hl)) score += 50;
    }
    if (score > best) { best = score; top = r; }
  });
  return top;
}

async function findOne(text, countries) {
  if (isCountry(text)) return countryPlace(text);
  const parts = text.split(',').map(tidy).filter(Boolean);
  const named = parts.filter(isCountry).map(canonicalCountry); // "Paris, France": the country narrows it down
  const within = named.length ? named : countries;
  for (let i = 0; i < parts.length; i++) {
    if (isCountry(parts[i])) continue;
    const r = pick(await search(parts[i]), within, parts.filter((_, j) => j !== i));
    if (r) {
      return { name: r.name, lat: round(r.latitude), lng: round(r.longitude), tz: r.timezone || '', country: canonicalCountry(r.country), level: 'city' };
    }
  }
  return named.length ? countryPlace(named[0]) : null;
}

/** Look up a listing's places. Throws if the lookup service can't be reached, so it's tried again soon. */
export async function findPlaces(e) {
  const countries = countryList(e.country).filter(isCountry);
  const places = [], missing = [];
  for (const text of splitPlaces(e.location)) {
    const p = await findOne(text, countries);
    p ? places.push(p) : missing.push(text);
  }
  // Nothing found (or no Location): the middle of each of their countries.
  if (!places.length) for (const c of countries) { const p = countryPlace(c); if (p) places.push(p); }
  const seen = new Set();
  return {
    key: placeKey(e),
    places: places.filter((p) => { const k = `${p.name}|${p.lat}|${p.lng}`; return !seen.has(k) && seen.add(k); }),
    missing,
    at: new Date().toISOString(),
  };
}

/** Find places for listings that need them, a few per run. Never throws. */
export async function placeMembers() {
  try {
    const todo = (await store.all()).filter(([, e]) => !e.removedAt && needsPlaces(e)).slice(0, PER_RUN);
    for (const [id, e] of todo) {
      let geo;
      try { geo = await findPlaces(e); } catch (err) { console.error('place lookup failed', err); return; }
      const [fresh] = await store.get([id]);
      if (fresh && !fresh.removedAt && placeKey(fresh) === geo.key) await store.put({ [id]: { ...fresh, geo } });
    }
  } catch (err) { console.error('placing members failed', err); }
}
