// /api/check            monthly sheet check (adds, removes, statuses, log)
// /api/check?mode=sync  daily copy of Title / Practice / Location / Country / Image edits to live sites
// Vercel Cron calls both (see vercel.json) with "Authorization: Bearer $CRON_SECRET".
// ADMIN_TOKEN also works, to run either by hand.

import crypto from 'node:crypto';
import { runCheck, runSync } from '../lib/check.js';

function authorized(request) {
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!got) return false;
  return [process.env.CRON_SECRET, process.env.ADMIN_TOKEN].some((want) => {
    if (!want) return false;
    const a = Buffer.from(want), b = Buffer.from(got);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

export async function GET(request) {
  if (!authorized(request)) return new Response('unauthorized', { status: 401 });
  try {
    const sync = new URL(request.url).searchParams.get('mode') === 'sync';
    return Response.json(sync ? await runSync() : await runCheck());
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
