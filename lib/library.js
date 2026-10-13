// Publish / unpublish sites, keeping the Google Sheet in step.
//
// Entry: { url, host, title, practice?, location?, country?, added, srcs[], og?, image?, picks?, thumb?, inSheet?, removedAt?, removedBy? }
//   practice = what the creative does (from the sheet; never inferred)
//   location = where they're based, shown as typed (from the sheet)
//   country  = country or countries, comma-separated (from the sheet; counted on the homepage, not shown)
//   thumb, gallery = the cover and up to 5 more (Blob URLs), all of their work; galleryAt when captured
//   added    = never shown; orders "Latest"
//   og    = the page's share image (last resort)
//   image = admin cover from the sheet's Image column
//   picks = admin gallery from the sheet's Gallery column (replaces the images taken from the site)
// Removed entries stay as tombstones (removedAt set) so the monthly check
// knows a missing row means "removed", not "never added".

import { getMessage, reactors, extractLinks } from './slack.js';
import { normalize, tidy, host, fetchMeta } from './meta.js';
import * as store from './store.js';
import * as sheet from './sheet.js';
import { recaptureIfChanged } from './images.js';

export const isLive = (e) => e && !e.removedAt;

/** Add to the sheet; mark entries inSheet on success. Never throws: the monthly check catches up. */
async function toSheet(entries) {
  if (!sheet.enabled() || !entries.length) return;
  try {
    await sheet.appendRows(entries.map(([, e]) => e));
    await store.put(Object.fromEntries(entries.map(([id, e]) => [id, { ...e, inSheet: true }])));
  } catch (err) { console.error('sheet append failed', err); }
}

async function dropFromSheet(ids) {
  if (!sheet.enabled() || !ids.length) return;
  try {
    const set = new Set(ids);
    const rows = (await sheet.readRows()).filter((r) => { try { return set.has(normalize(r.url)); } catch { return false; } });
    await sheet.deleteRows(rows.map((r) => r.row));
  } catch (err) { console.error('sheet delete failed', err); }
}

/** Add or update sites and append any new ones to the sheet. Returns [id, entry] pairs. */
export async function addSites(items, src) {
  const ids = items.map((l) => normalize(l.url));
  const existing = await store.get(ids);
  const entries = await Promise.all(items.map(async (l, i) => {
    const prev = isLive(existing[i]) ? existing[i] : null;
    const need = !(l.title || prev?.title) || !(l.og || prev?.og);
    const meta = need ? await fetchMeta(l.url, l.timeout) : {};
    const e = {
      ...(prev || {}),
      url: tidy(l.url),
      host: host(l.url),
      title: l.title || prev?.title || meta.title || host(l.url),
      og: l.og || prev?.og || meta.image || '',
      ...(l.image ? { image: l.image } : {}),
      ...(l.picks?.length ? { picks: l.picks } : {}),
      ...(l.practice ? { practice: l.practice } : {}),
      ...(l.location ? { location: l.location } : {}),
      ...(l.country ? { country: l.country } : {}),
      added: prev?.added || l.added,
      srcs: [...new Set([...(prev?.srcs || []), src])], // every source keeping it live
    };
    if (prev) recaptureIfChanged(prev, e); // new admin images → capture again
    return [ids[i], e];
  }));
  await store.put(Object.fromEntries(entries));
  await toSheet(entries.filter(([, e]) => !e.inSheet));
  return entries;
}

export async function removeSites(ids, by) {
  if (!ids.length) return;
  const removedAt = new Date().toISOString();
  const current = await store.get(ids);
  const tomb = {};
  ids.forEach((id, i) => { if (current[i]) tomb[id] = { ...current[i], srcs: [], removedAt, removedBy: by }; });
  await store.put(tomb);
  if (by !== 'sheet') await dropFromSheet(ids);
}

// ——— Slack ———

export async function publish(channel, ts, eventTs) {
  const msg = await getMessage(channel, ts);
  if (!msg) return [];
  const links = extractLinks(msg);
  if (!links.length) return [];
  const added = new Date((Number(eventTs) || Date.now() / 1000) * 1000).toISOString();
  return addSites(links.map((l) => ({ ...l, added })), `${channel}:${ts}`);
}

export async function unpublish(channel, ts, approvers, emojis) {
  // Another approver's ✅ still on the message keeps it live.
  const still = await reactors(channel, ts, emojis);
  if (approvers.some((u) => still.has(u))) return [];
  // Drop this message from each entry; an entry goes only when nothing else keeps it live.
  const src = `${channel}:${ts}`;
  const drop = [];
  const keep = {};
  for (const [id, e] of await store.all()) {
    if (!isLive(e) || !e.srcs?.includes(src)) continue;
    const srcs = e.srcs.filter((x) => x !== src);
    if (srcs.length) keep[id] = { ...e, srcs };
    else drop.push(id);
  }
  await store.put(keep);
  await removeSites(drop, 'slack');
  return drop;
}
