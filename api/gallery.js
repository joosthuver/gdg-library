// /api/gallery?id=<site id>&v=<version>
// A card's images after the cover (up to 5), capturing the card's images on first request.
import * as store from '../lib/store.js';
import { captureImages } from '../lib/images.js';

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('id') || '';
  try {
    const [e] = id ? await store.get([id]) : [];
    if (!e || e.removedAt) return Response.json({ images: [] }, { status: 404 });
    const done = await captureImages(id, e);
    if (!done) return Response.json({ images: [] }, { headers: { 'Cache-Control': 'public, s-maxage=600' } });
    return Response.json({ images: done.gallery || [] }, { headers: { 'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800' } });
  } catch (err) {
    console.error(err);
    return Response.json({ images: [] }, { status: 500 });
  }
}
