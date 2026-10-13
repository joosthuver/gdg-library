// /api/cover?id=<site id>&v=<version>
// Redirects to a card's cover image, capturing the card's images on first request.
import * as store from '../lib/store.js';
import { captureImages } from '../lib/images.js';

const cached = (maxAge) => `public, s-maxage=${maxAge}, max-age=${Math.min(maxAge, 3600)}`;

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  try {
    const [e] = id ? await store.get([id]) : [];
    if (!e || e.removedAt) return new Response('not found', { status: 404 });
    const done = await captureImages(id, e);
    if (!done) return new Response('try later', { status: 404, headers: { 'Cache-Control': cached(600) } });
    if (!done.thumb) return new Response('no image', { status: 404, headers: { 'Cache-Control': cached(3600) } });
    return new Response(null, { status: 302, headers: { Location: done.thumb, 'Cache-Control': cached(86400) } });
  } catch (err) {
    console.error(err);
    return new Response('error', { status: 500 });
  }
}
