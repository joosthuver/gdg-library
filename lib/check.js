// Sheet → site.
//
// runCheck (monthly): the sheet controls the site.
//   Row in the sheet, not on the site       → added to the site
//   On the site, its row deleted            → removed from the site
//   On the site, never made it to the sheet → appended to the sheet
//   Row for a site un-approved in Slack     → row deleted
//   Every row gets Status + Last checked; the Checks tab gets a one-line summary.
//
// runSync (daily): copies Title, Practice, Location, Country, Image and Gallery edits onto sites already live.
//   Never adds, removes or writes to the sheet, so edits show up the next day
//   while the monthly check stays the only thing that changes what's listed.

import * as store from './store.js';
import * as sheet from './sheet.js';
import { normalize, tidy, host, fetchMeta } from './meta.js';
import { isLive } from './library.js';
import { recaptureIfChanged } from './images.js';

const httpsOrEmpty = (u) => (/^https:\/\//i.test(u || '') ? u : '');
const rowId = (r) => { try { return /^https?:\/\//i.test(r.url) ? normalize(r.url) : null; } catch { return null; } };

/** Apply a row's editable fields to a live entry. Returns the new entry, or null if nothing changed. */
function edits(e, r) {
  const next = { ...e };
  let changed = false;
  if (r.title && r.title !== e.title) { next.title = r.title; changed = true; }
  if ((r.practice || '') !== (e.practice || '')) { next.practice = r.practice || ''; changed = true; }
  if ((r.location || '') !== (e.location || '')) { next.location = r.location || ''; changed = true; }
  if ((r.country || '') !== (e.country || '')) { next.country = r.country || ''; changed = true; }
  const image = httpsOrEmpty(r.image);
  const picks = r.gallery || [];
  if (image !== (e.image || '') || picks.join(' ') !== (e.picks || []).join(' ')) {
    next.image = image;
    next.picks = picks;
    changed = true;
    recaptureIfChanged(e, next);
  }
  return changed ? next : null;
}

export async function runSync() {
  if (!sheet.enabled()) throw new Error('Google Sheet not configured');
  const rows = await sheet.readRows();
  const entries = new Map(await store.all());
  const updates = {};
  const seen = new Set();
  for (const r of rows) {
    const id = rowId(r);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const e = entries.get(id);
    if (!isLive(e)) continue;
    const next = edits(e, r);
    if (next) updates[id] = next;
  }
  await store.put(updates);
  return { ok: true, updated: Object.keys(updates).length };
}

export async function runCheck(now = new Date()) {
  if (!sheet.enabled()) throw new Error('Google Sheet not configured');
  const today = sheet.day(now.toISOString());
  const rows = await sheet.readRows();
  const entries = new Map(await store.all());

  // Safety: an empty sheet would wipe the site. Refuse instead.
  const filled = rows.filter((r) => r.url);
  const tracked = [...entries.values()].filter((e) => isLive(e) && e.inSheet).length;
  if (!filled.length && tracked) {
    const note = `Sheet has no links but ${tracked} sites are live. Nothing changed.`;
    await sheet.log([today, 0, 0, 0, note]);
    return { ok: false, note };
  }

  const seen = new Map(); // id -> row
  const status = [];
  const delRows = [];
  const toAdd = [];
  const updates = {};
  const notes = [];

  for (const r of rows) {
    if (!r.url) { status.push([r.status, r.checked]); continue; }
    const id = rowId(r);
    if (!id) { status.push(['Not a valid link', today]); continue; }
    if (seen.has(id)) { status.push([`Duplicate of row ${seen.get(id)}`, today]); continue; }
    seen.set(id, r.row);

    const e = entries.get(id);
    if (isLive(e)) {
      status.push(['Live', today]);
      const next = edits(e, r) || (e.inSheet ? null : { ...e });
      if (next) updates[id] = { ...next, inSheet: true };
    } else if (e?.removedBy === 'slack') {
      delRows.push(r.row); // un-approved in Slack: Slack wins, row goes
      status.push([r.status, r.checked]);
    } else {
      toAdd.push({ id, r });
      status.push(['Added to site', today]);
    }
  }

  // Rows that aren't on the site yet.
  await Promise.all(toAdd.map(async ({ id, r }) => {
    const d = new Date(r.added);
    const meta = await fetchMeta(r.url, 4000);
    const image = httpsOrEmpty(r.image);
    updates[id] = {
      url: tidy(r.url),
      host: host(r.url),
      title: r.title || meta.title || host(r.url),
      practice: r.practice || '',
      location: r.location || '',
      country: r.country || '',
      og: meta.image || '',
      ...(image ? { image } : {}),
      ...(r.gallery?.length ? { picks: r.gallery } : {}),
      added: (isNaN(d) ? now : d).toISOString(),
      srcs: ['sheet'],
      inSheet: true,
    };
  }));

  // Live sites with no row.
  const removed = [];
  const append = [];
  for (const [id, e] of entries) {
    if (!isLive(e) || seen.has(id)) continue;
    if (e.inSheet) {
      updates[id] = { ...e, srcs: [], removedAt: now.toISOString(), removedBy: 'sheet' };
      removed.push(e.url);
    } else {
      append.push({ ...e, status: 'Added to sheet', checked: today });
      updates[id] = { ...e, inSheet: true };
    }
  }

  await store.put(updates);
  await sheet.writeStatus(status);
  await sheet.appendRows(append);
  await sheet.deleteRows(delRows);

  if (removed.length) notes.push(`Removed: ${removed.join(', ')}`);
  if (delRows.length) notes.push(`Deleted ${delRows.length} row(s) for sites un-approved in Slack`);
  const summary = { ok: true, addedToSite: toAdd.length, removedFromSite: removed.length, addedToSheet: append.length, rowsDeleted: delRows.length };
  await sheet.log([today, summary.addedToSite, summary.removedFromSite, summary.addedToSheet, notes.join('. ') || 'In sync']);
  return summary;
}
