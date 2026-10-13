// Google Sheets, via a service account. Plain fetch + node:crypto, no deps.
// Sheet layout (tab "Sites"):  Title | URL | Practice | Location | Country | Image | Gallery | Added | Status | Last checked
// Practice: what the creative does (dropdown of suggestions, free text allowed).
// Location: where they're based, shown on the site as typed ("Toronto and Copenhagen").
// Country: the country or countries for the count at the top, comma-separated ("Canada, Denmark"). Not shown.
// Image is optional: an image URL for the card cover.
// Gallery is optional: up to 6 image URLs (one per line, or separated by spaces) to show instead of
// the images found on the site. Without an Image, the first one becomes the cover.
// Added is never shown on the site; it orders "Latest".
// A second tab, "Checks", gets one row per monthly check.

import crypto from 'node:crypto';

const HEADERS = ['Title', 'URL', 'Practice', 'Location', 'Country', 'Image', 'Gallery', 'Added', 'Status', 'Last checked'];
const PRACTICES = [
  'Designer', 'Product Designer', 'Creative Technologist', 'Art Director', 'Creative Director',
  'Director', 'Photographer', 'Illustrator', 'Motion Designer', 'Type Designer', '3D Artist',
  'Developer', 'Writer', 'Studio',
];
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
async function tabIds() {
  const d = await api('?fields=sheets.properties(sheetId,title)');
  return Object.fromEntries(d.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
}

/** Make sure a tab exists with its header row. Returns its numeric sheetId. */
async function ensureTab(title, headers) {
  let ids = await tabIds();
  if (!(title in ids)) {
    await api(':batchUpdate', { method: 'POST', body: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] } });
    ids = await tabIds();
  }
  const span = `A1:${String.fromCharCode(64 + headers.length)}1`;
  const head = await api(`/values/${range(title, span)}`);
  if (!head.values?.[0]?.[0]) {
    await api(`/values/${range(title, span)}?valueInputOption=RAW`, { method: 'PUT', body: { values: [headers] } });
    const col = headers.indexOf('Practice');
    if (col >= 0) {
      // Practice dropdown. strict:false, so other practices can still be typed in.
      await api(':batchUpdate', { method: 'POST', body: { requests: [{ setDataValidation: {
        range: { sheetId: ids[title], startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
        rule: { condition: { type: 'ONE_OF_LIST', values: PRACTICES.map((v) => ({ userEnteredValue: v })) }, strict: false, showCustomUi: true },
      } }] } });
    }
  }
  return ids[title];
}

// ——— Rows ———
export const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

// A date typed into the sheet arrives as a serial day number (days since 1899-12-30).
const toIso = (v) => (typeof v === 'number' && v > 0 ? new Date(Math.round((v - 25569) * 864e5)).toISOString() : String(v ?? '').trim());
const str = (v) => String(v ?? '');

/** Gallery cell → image URLs. Split on spaces, new lines, or a comma before the next link (commas inside a URL stay). */
export const parseGallery = (v) => [...new Set((Array.isArray(v) ? v : str(v).split(/,?\s+|,(?=https?:\/\/)/))
  .map((u) => String(u).trim()).filter((u) => /^https:\/\//i.test(u)))].slice(0, 6);

/** All data rows of the Sites tab: [{ row, title, url, practice, location, country, image, gallery[], added, status, checked }] */
export async function readRows() {
  const { tab } = env();
  await ensureTab(tab, HEADERS);
  // Raw values, so dates come back as serial numbers instead of locale-formatted text.
  const d = await api(`/values/${range(tab, 'A2:J')}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  return (d.values || []).map((v, i) => ({
    row: i + 2, title: str(v[0]).trim(), url: str(v[1]).trim(), practice: str(v[2]).trim(), location: str(v[3]).trim(),
    country: str(v[4]).trim(), image: str(v[5]).trim(), gallery: parseGallery(v[6]), added: toIso(v[7]), status: v[8] || '', checked: v[9] || '',
  }));
}

/** Append sites: [{ title, url, practice?, location?, country?, image?, picks?, added, status? }]. RAW input, so a title can never run as a formula. */
export async function appendRows(sites) {
  if (!sites.length) return;
  const { tab } = env();
  await ensureTab(tab, HEADERS);
  await api(`/values/${range(tab, 'A:J')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: { values: sites.map((s) => [s.title, s.url, s.practice || '', s.location || '', s.country || '', s.image || '', (s.picks || []).join('\n'), day(s.added), s.status || 'Live', s.checked || '']) },
  });
}

/** Write Status + Last checked for rows 2..n in one call. `values` is in row order. */
export async function writeStatus(values) {
  if (!values.length) return;
  const { tab } = env();
  await api(`/values/${range(tab, `I2:J${values.length + 1}`)}?valueInputOption=RAW`, { method: 'PUT', body: { values } });
}

/** Delete rows by row number. */
export async function deleteRows(rows) {
  if (!rows.length) return;
  const { tab } = env();
  const sheetId = await ensureTab(tab, HEADERS);
  const requests = [...new Set(rows)].sort((a, b) => b - a) // bottom up, so indexes stay valid
    .map((r) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r - 1, endIndex: r } } }));
  await api(':batchUpdate', { method: 'POST', body: { requests } });
}

export async function log(values) {
  const { logTab } = env();
  await ensureTab(logTab, LOG_HEADERS);
  await api(`/values/${range(logTab, 'A:E')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { method: 'POST', body: { values: [values] } });
}
