// POST /api/import (admin only, Authorization: Bearer ADMIN_TOKEN)
// Bulk add or remove sites, e.g. the launch preload or links older than Slack's history.
// Body: { sites: [{ url, title?, practice?, company?, location?, country?, available?, image?, gallery?: [url], added? }], remove: [url] }
// title = the person's name, practice = what they do (the sheet's Name and Title columns).
// Changes are written to the sheet too.

import crypto from 'node:crypto';
import { normalize } from '../lib/meta.js';
import { addSites, removeSites } from '../lib/library.js';
import { parseGallery } from '../lib/sheet.js';

function authorized(request) {
  const want = process.env.ADMIN_TOKEN;
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const valid = (u) => { try { normalize(u); return /^https?:\/\//i.test(u); } catch { return false; } };

export async function POST(request) {
  if (!authorized(request)) return new Response('unauthorized', { status: 401 });
  let body;
  try { body = await request.json(); } catch { return new Response('bad json', { status: 400 }); }

  const items = (body.sites || []).filter((s) => valid(s?.url)).map((s) => {
    const d = s.added ? new Date(s.added) : new Date();
    return { url: s.url, title: s.title, practice: typeof s.practice === 'string' ? s.practice.trim() : undefined, company: typeof s.company === 'string' ? s.company.trim() : undefined, location: typeof s.location === 'string' ? s.location.trim() : undefined, available: typeof s.available === 'boolean' ? s.available : undefined, country: typeof s.country === 'string' ? s.country.trim() : undefined, image: /^https:\/\//.test(s.image || '') ? s.image : undefined, picks: s.gallery ? parseGallery(s.gallery) : undefined, added: (isNaN(d) ? new Date() : d).toISOString(), timeout: 4000 };
  });
  if (items.length) await addSites(items, 'import');

  const removeIds = (body.remove || []).filter(valid).map(normalize);
  await removeSites(removeIds, 'admin');

  return Response.json({ added: items.length, removed: removeIds.length });
}
