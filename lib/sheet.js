// Google Sheets, via a service account. Plain fetch + node:crypto, no deps.
//
// Sites tab, created in this order (read and written by header name, so columns can be reordered):
//   Name | URL | Title | Company | Location | Country | Availability | Image | Gallery | Added | Status | Last checked
// Title: what they do (dropdown of suggestions, free text allowed).
// Company: shown in the card's + panel.
// Location: where they're based, shown as typed ("Toronto and Copenhagen").
// Country: the country or countries for the count at the top, comma-separated ("Canada, Denmark"). Not shown.
// Availability: "Available" shows an "Available for work" pill on the card; anything else shows nothing.
// Image: optional image URL for the card cover.
// Gallery: optional, up to 6 image URLs (one per line, or separated by spaces) shown instead of the images
//   found on the site. Without an Image, the first one is the cover.
// Added is never shown on the site; it orders "Latest".
// A second tab, "Checks", gets one row per monthly check.
// Older sheets (Title | URL | Practice | …) are upgraded in place: headers renamed, new columns inserted.

import crypto from 'node:crypto';

const COLUMNS = [
  ['title', 'Name'], ['url', 'URL'], ['practice', 'Title'], ['company', 'Company'], ['location', 'Location'],
  ['country', 'Country'], ['availability', 'Availability'], ['image', 'Image'], ['gallery', 'Gallery'],
  ['added', 'Added'], ['status', 'Status'], ['checked', 'Last checked'],
];
const PRACTICES = [
  'Designer', 'Product Designer', 'Creative Technologist', 'Art Director', 'Creative Director',
  'Director', 'Photographer', 'Illustrator', 'Motion Designer', 'Type Designer', '3D Artist',
  'Developer', 'Writer', 'Studio',
];
const AVAILABILITY = ['Available', 'Not available'];
const LOG_HEADERS = ['Date', 'Added to site', 'Removed from site', 'Added to sheet', 'Notes'];

const env = () => ({
  id: process.env.GOOGLE_SHEET_ID,
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  tab: 'Sites',
  logTab: 'Checks',
});

export const enabled = () => { const e = env(); return Boolean(e.id && e.email && e.key); };

// ——— Auth ———
let cached = { token: null, exp: 0 };
async function token() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const { email, key } = env();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google auth: ${data.error_description || data.error || res.status}`);
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env().id}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${data.error?.message || 'error'}`);
  return data;
}

const range = (tab, a1) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${a1}`);

// ——— Tabs ———
const letter = (i) => (i >= 26 ? letter(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));
const norm = (h) => String(h ?? '').trim().toLowerCase();

async function tabIds() {
  const d = await api('?fields=sheets.properties(sheetId,title)');
  return Object.fromEntries(d.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
}

async function ensureSheet(title) {
  let ids = await tabIds();
  if (!(title in ids)) {
    await api(':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] } });
    ids = await tabIds();
  }
  return ids[title];
}

const dropdown = (sheetId, col, values) => ({ setDataValidation: {
  range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
  // strict:false, so anything else can still be typed in.
  rule: { condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true },
} });

/**
 * The Sites tab's layout: creates the tab and headers if needed, upgrades older layouts, and
 * returns { sheetId, cols: { key: columnIndex }, width }.
 */
async function layout() {
  const { tab } = env();
  const sheetId = await ensureSheet(tab);
  let head = ((await api(`/values/${range(tab, 'A1:Z1')}`)).values?.[0] || []).map(String);

  if (!head.some((h) => h.trim())) {
    head = COLUMNS.map(([, h]) => h);
    await api(`/values/${range(tab, `A1:${letter(head.length - 1)}1`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [head] } });
    await api(':batchUpdate', { method: 'POST', body: { requests: [
      dropdown(sheetId, head.indexOf('Title'), PRACTICES), dropdown(sheetId, head.indexOf('Availability'), AVAILABILITY),
    ] } });
  } else {
    // Older layout: Title held the name and Practice the role.
    if (head.some((h) => norm(h) === 'practice')) {
      head = head.map((h) => (norm(h) === 'title' ? 'Name' : norm(h) === 'practice' ? 'Title' : h));
      await api(`/values/${range(tab, `A1:${letter(head.length - 1)}1`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [head] } });
    }
    // Missing columns go in after the column they follow in COLUMNS, so existing data stays put.
    for (let i = 0; i < COLUMNS.length; i++) {
      const header = COLUMNS[i][1];
      if (head.some((h) => norm(h) === norm(header))) continue;
      let at = head.length;
      for (let j = i - 1; j >= 0; j--) {
        const k = head.findIndex((h) => norm(h) === norm(COLUMNS[j][1]));
        if (k >= 0) { at = k + 1; break; }
      }
      const requests = [{ insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: at, endIndex: at + 1 }, inheritFromBefore: false } }];
      if (header === 'Availability') requests.push(dropdown(sheetId, at, AVAILABILITY));
      await api(':batchUpdate', { method: 'POST', body: { requests } });
      await api(`/values/${range(tab, `${letter(at)}1`)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[header]] } });
      head.splice(at, 0, header);
    }
  }
  const cols = Object.fromEntries(COLUMNS.map(([key, header]) => [key, head.findIndex((h) => norm(h) === norm(header))]));
  return { sheetId, cols, width: head.length };
}

// ——— Rows ———
export const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

// A date typed into the sheet arrives as a serial day number (days since 1899-12-30).
const toIso = (v) => (typeof v === 'number' && v > 0 ? new Date(Math.round((v - 25569) * 864e5)).toISOString() : String(v ?? '').trim());
const str = (v) => String(v ?? '');

/** Gallery cell → image URLs. Split on spaces, new lines, or a comma before the next link (commas inside a URL stay). */
export const parseGallery = (v) => [...new Set((Array.isArray(v) ? v : str(v).split(/,?\s+|,(?=https?:\/\/)/))
  .map((u) => String(u).trim()).filter((u) => /^https:\/\//i.test(u)))].slice(0, 6);

/** "Available" (any case) → true; blank, "Not available" or anything else → false. */
export const isAvailable = (v) => /^\s*available\b/i.test(str(v));

/** An entry's sheet cells, by key. */
const cells = (s) => ({
  title: s.title, url: s.url, practice: s.practice || '', company: s.company || '', location: s.location || '',
  country: s.country || '', availability: s.available ? 'Available' : '', image: s.image || '',
  gallery: (s.picks || []).join('\n'), added: day(s.added), status: s.status || 'Live', checked: s.checked || '',
});

/** All data rows of the Sites tab: [{ row, title, url, practice, company, location, country, available, image, gallery[], added, status, checked }] */
export async function readRows() {
  const { tab } = env();
  const { cols, width } = await layout();
  // Raw values, so dates come back as serial numbers instead of locale-formatted text.
  const d = await api(`/values/${range(tab, `A2:${letter(width - 1)}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  const at = (v, key) => (cols[key] >= 0 ? v[cols[key]] : '');
  return (d.values || []).map((v, i) => ({
    row: i + 2,
    title: str(at(v, 'title')).trim(), url: str(at(v, 'url')).trim(), practice: str(at(v, 'practice')).trim(),
    company: str(at(v, 'company')).trim(), location: str(at(v, 'location')).trim(), country: str(at(v, 'country')).trim(),
    available: isAvailable(at(v, 'availability')), image: str(at(v, 'image')).trim(), gallery: parseGallery(at(v, 'gallery')),
    added: toIso(at(v, 'added')), status: at(v, 'status') || '', checked: at(v, 'checked') || '',
  }));
}

/** Append sites (entries). RAW input, so a name can never run as a formula. */
export async function appendRows(sites) {
  if (!sites.length) return;
  const { tab } = env();
  const { sheetId, cols, width } = await layout();
  const values = sites.map((s) => {
    const row = Array(width).fill('');
    for (const [key, v] of Object.entries(cells(s))) if (cols[key] >= 0) row[cols[key]] = v;
    return row;
  });
  // Written into exact cells, starting in column A under the last filled row. (Google's own "append"
  // guesses where the table starts and can shift a whole row into the wrong columns.)
  const filled = (await api(`/values/${range(tab, `A1:${letter(width - 1)}`)}`)).values?.length || 1;
  const first = filled + 1, last = filled + values.length;
  await api(':batchUpdate', { method: 'POST', body: { requests: [{ insertDimension: {
    range: { sheetId, dimension: 'ROWS', startIndex: first - 1, endIndex: last }, inheritFromBefore: true,
  } }] } });
  await api(`/values/${range(tab, `A${first}:${letter(width - 1)}${last}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values } });
}

/** Write Status + Last checked for rows 2..n. `values` is [[status, checked]] in row order. */
export async function writeStatus(values) {
  if (!values.length) return;
  const { tab } = env();
  const { cols } = await layout();
  const end = values.length + 1;
  await api('/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: [
    { range: `'${tab}'!${letter(cols.status)}2:${letter(cols.status)}${end}`, values: values.map((v) => [v[0]]) },
    { range: `'${tab}'!${letter(cols.checked)}2:${letter(cols.checked)}${end}`, values: values.map((v) => [v[1]]) },
  ] } });
}

/** Overwrite some cells of one row: `fields` is a partial entry (title, practice, company, location, country, available, picks). */
/** Write the header's first cell back as it is: proves the site can edit the sheet without changing anything. */
export async function canWrite() {
  const { tab } = env();
  const a1 = (await api(`/values/${range(tab, 'A1')}`)).values?.[0]?.[0] ?? '';
  await api(`/values/${range(tab, 'A1')}?valueInputOption=RAW`, { method: 'PUT', body: { values: [[a1]] } });
}

/** A sheet error in plain words, with what to do. */
export function explainSheetError(err) {
  const msg = err?.message || String(err);
  if (/403|permission/i.test(msg)) return `The site can read the Google Sheet but not edit it. Share the sheet with ${(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim()} as Editor (not Viewer).`;
  if (/protected/i.test(msg)) return 'Part of the Sites tab is protected. Remove the protection (Data → Protect sheets and ranges) or add the site’s account as an editor of it.';
  return `Google Sheets said: ${msg}`;
}

export async function updateRow(row, fields) {
  const { tab } = env();
  const { cols } = await layout();
  const all = cells({ ...fields, status: undefined });
  const keys = Object.keys(fields).map((k) => (k === 'available' ? 'availability' : k === 'picks' ? 'gallery' : k)).filter((k) => cols[k] >= 0);
  if (!keys.length) return;
  await api('/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: keys.map((k) => ({
    range: `'${tab}'!${letter(cols[k])}${row}`, values: [[all[k]]],
  })) } });
}

/** Delete rows by row number. */
export async function deleteRows(rows) {
  if (!rows.length) return;
  const { sheetId } = await layout();
  const requests = [...new Set(rows)].sort((a, b) => b - a) // bottom up, so indexes stay valid
    .map((r) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } } }));
  await api(':batchUpdate', { method: 'POST', body: { requests } });
}

export async function log(values) {
  const { logTab } = env();
  await ensureSheet(logTab);
  const head = await api(`/values/${range(logTab, 'A1:E1')}`);
  if (!head.values?.[0]?.[0]) await api(`/values/${range(logTab, 'A1:E1')}?valueInputOption=RAW`, { method: 'PUT', body: { values: [LOG_HEADERS] } });
  await api(`/values/${range(logTab, 'A:E')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: { values: [values] } });
}
