// Publish / unpublish sites, keeping the Google Sheet in step.
//
// Entry: { url, host, title, practice?, company?, location?, country?, available?, added, srcs[], og?, image?, picks?, thumb?, owner?, inSheet?, removedAt?, removedBy? }
//   title    = the person's or studio's name (the sheet's Name column)
//   practice = what they do (the sheet's Title column; never inferred)
//   company  = where they work (shown in the card's + panel)
//   available = true shows an "Available for work" pill
//   owner    = the Slack member who submitted it with /directory (can update it themselves)
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
      ...(Array.isArray(l.picks) && (l.picks.length || l.exact) ? { picks: l.picks } : {}),
      ...(l.practice ? { practice: l.practice } : {}),
      ...(l.company ? { company: l.company } : {}),
      ...(typeof l.available === 'boolean' ? { available: l.available } : {}),
      ...(l.owner ? { owner: l.owner } : {}),
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

/**
 * Set a live listing's details exactly as given (empty values clear them), and write the same to its
 * sheet row, so the daily sync keeps them. `fields`: title, practice, company, location, country, available, picks.
 */
export async function updateListing(id, fields) {
  const [prev] = await store.get([id]);
  if (!isLive(prev)) return null;
  const next = { ...prev, ...fields };
  recaptureIfChanged(prev, next);
  await store.put({ [id]: next });
  if (sheet.enabled() && prev.inSheet) {
    try {
      const row = (await sheet.readRows()).find((r) => { try { return normalize(r.url) === id; } catch { return false; } });
      if (row) await sheet.updateRow(row.row, fields);
    } catch (err) { console.error('sheet update failed', err); }
  }
  return next;
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
  const src = `${channel}:${ts}`;
  const added = new Date((Number(eventTs) || Date.now() / 1000) * 1000).toISOString();
  // A /directory submission: publish it with everything the member filled in.
  const form = await store.getSubmission(src);
  if (form) {
    const id = normalize(form.fields.url);
    const [before] = await store.get([id]);
    const entries = await addSites([{ ...form.fields, added, exact: true }], src);
    if (isLive(before)) entries[0][1] = await updateListing(id, listingFields(form.fields)); // an existing listing, claimed or corrected
    return entries;
  }
  const msg = await getMessage(channel, ts);
  if (!msg) return [];
  const links = extractLinks(msg);
  if (!links.length) return [];
  return addSites(links.map((l) => ({ ...l, added })), src);
}

/** The details a member controls, from a /directory form (empty ones clear). */
export const listingFields = (f) => ({
  title: f.title, practice: f.practice || '', company: f.company || '', location: f.location || '',
  country: f.country || '', available: !!f.available, picks: f.picks || [], owner: f.owner,
});

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
