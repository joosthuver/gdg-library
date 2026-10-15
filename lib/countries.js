// Country names, so "UK", "U.K." and "United Kingdom" are one country.
// Used for the "from N countries" count and the Map view.
import { CENTERS } from './country-centers.js';

const ALIASES = {
  'uk': 'United Kingdom', 'u.k': 'United Kingdom', 'great britain': 'United Kingdom', 'britain': 'United Kingdom',
  'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom', 'northern ireland': 'United Kingdom',
  'usa': 'United States', 'us': 'United States', 'u.s': 'United States', 'u.s.a': 'United States',
  'united states of america': 'United States', 'america': 'United States',
  'holland': 'Netherlands', 'nl': 'Netherlands',
  'uae': 'United Arab Emirates', 'korea': 'South Korea', 'republic of korea': 'South Korea',
  'czech republic': 'Czechia', 'deutschland': 'Germany', 'españa': 'Spain', 'italia': 'Italy',
  'brasil': 'Brazil', 'méxico': 'Mexico', 'schweiz': 'Switzerland', 'suisse': 'Switzerland',
  "côte d'ivoire": 'Ivory Coast', 'türkiye': 'Turkey',
};
const BY_LOWER = Object.fromEntries(Object.keys(CENTERS).map((k) => [k.toLowerCase(), k]));

/** "the netherlands" → "Netherlands", "USA" → "United States". Unknown names come back tidied, as written. */
export function canonicalCountry(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (!t) return '';
  const l = t.toLowerCase().replace(/^the /, '');
  return ALIASES[l] || BY_LOWER[l] || t.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/** A country we know the middle of. */
export const isCountry = (s) => canonicalCountry(s) in CENTERS;
export const countryCenter = (s) => CENTERS[canonicalCountry(s)] || null;

/** "Canada, Denmark" / "Canada and Denmark" / "canada" → ['Canada', 'Denmark']. */
export const countryList = (s) => (isCountry(s) ? [canonicalCountry(s)] // "Trinidad and Tobago" is one
  : String(s || '').split(/\s*(?:,|;|\/|&|\band\b|\+)\s*/i).map(canonicalCountry).filter(Boolean));

/** How many countries: each entry is a Country cell, or a list of names already split. */
export const countCountries = (values) =>
  new Set(values.flatMap((v) => (Array.isArray(v) ? v.map(canonicalCountry) : countryList(v))).filter(Boolean)).size;
