// /api/status — a plain-words setup check for the admin. Open it in a browser.
// One line per piece (database, image storage, sheet, Slack, schedule), each ✓ or ✗ with what to do,
// then the last few things Slack sent and what happened to them.
// Shows only whether settings are present and working, never their values.

import * as store from '../lib/store.js';
import * as sheet from '../lib/sheet.js';
import { call, scopes, explainSlackError } from '../lib/slack.js';

const env = (k) => (process.env[k] || '').trim();
const ids = (k) => env(k).split(',').map((s) => s.trim()).filter(Boolean);
const withTimeout = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('took too long to answer')), ms))]);

const missing = (names) => names.filter((n) => !env(n));
const need = (names, fix) => {
  const m = missing(names);
  return m.length ? { ok: false, text: `Missing in Vercel: ${m.join(', ')}.`, fix } : null;
};

async function database() {
  const m = need(['KV_REST_API_URL', 'KV_REST_API_TOKEN'].filter(() => !env('UPSTASH_REDIS_REST_URL')),
    'Vercel → Storage → connect the Upstash for Redis store to this project (no custom prefix), then redeploy.');
  if (m) return m;
  try {
    const live = (await withTimeout(store.all())).filter(([, e]) => !e.removedAt).length;
    return { ok: true, text: `Connected. ${live} site${live === 1 ? '' : 's'} live.` };
  } catch (err) {
    return { ok: false, text: `Can’t reach the database (${err.message}).`, fix: 'Vercel → Storage → check the Upstash store is connected, then redeploy.' };
  }
}

function images() {
  // Vercel connects new Blob stores without a token (BLOB_STORE_ID, signed in automatically); older ones use BLOB_READ_WRITE_TOKEN.
  if (env('BLOB_READ_WRITE_TOKEN') || env('BLOB_STORE_ID')) return { ok: true, text: 'Connected.' };
  return { ok: false, text: 'No Blob store is connected to this project.', fix: 'Vercel → Storage → open the Blob store → Projects → connect this project with Production ticked, then redeploy. Images already stored keep showing; new ones can’t be saved until then.' };
}

async function googleSheet() {
  const m = need(['GOOGLE_SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY'], 'Add them from the JSON key file and the sheet’s address (README step 5–6), then redeploy.');
  if (m) return m;
  try {
    const rows = (await withTimeout(sheet.readRows(), 12000)).filter((r) => r.url).length;
    try { await withTimeout(sheet.canWrite()); } catch (err) {
      return { ok: false, text: `Can read ${rows} row${rows === 1 ? '' : 's'} but can’t edit the sheet, so new sites and /directory updates don’t reach it.`, fix: sheet.explainSheetError(err) };
    }
    return { ok: true, text: `Connected and can edit. ${rows} row${rows === 1 ? '' : 's'} in the Sites tab.` };
  } catch (err) {
    const msg = err.message || '';
    if (/invalid_grant|private key|PEM|DECODER|asn1/i.test(msg)) return { ok: false, text: 'Google won’t accept the key.', fix: 'Paste GOOGLE_PRIVATE_KEY again: everything between the quotes after "private_key", from -----BEGIN to END PRIVATE KEY-----\\n. Then redeploy.' };
    if (/403|permission/i.test(msg)) return { ok: false, text: 'The sheet isn’t shared with the site.', fix: `Share the Google Sheet with ${env('GOOGLE_SERVICE_ACCOUNT_EMAIL')} as Editor.` };
    if (/404|not found/i.test(msg)) return { ok: false, text: 'Google can’t find that sheet.', fix: 'Check GOOGLE_SHEET_ID: the long part of the sheet’s address between /d/ and /edit. Then redeploy.' };
    if (/has not been used|disabled|SERVICE_DISABLED/i.test(msg)) return { ok: false, text: 'The Google Sheets API isn’t switched on.', fix: 'Google Cloud Console → APIs & Services → Library → Google Sheets API → Enable.' };
    return { ok: false, text: `Can’t read the sheet (${msg}).` };
  }
}

async function slackApp() {
  const m = need(['SLACK_BOT_TOKEN'], 'Slack app → Install App → copy the Bot User OAuth Token (xoxb-…) into Vercel, then redeploy.');
  if (m) return m;
  if (!env('SLACK_BOT_TOKEN').startsWith('xoxb-')) return { ok: false, text: 'SLACK_BOT_TOKEN is the wrong kind of token: it should start with xoxb-.', fix: 'Slack app → OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…) into SLACK_BOT_TOKEN in Vercel, then redeploy. Not the App-Level Token (xapp-…) or the Signing Secret.' };
  try {
    const a = await withTimeout(call('auth.test', {}));
    return { ok: true, text: `Connected to the ${a.team} workspace as ${a.user}.` };
  } catch (err) {
    return { ok: false, text: explainSlackError(err) };
  }
}

async function slackForm() {
  if (!env('SLACK_BOT_TOKEN')) return { ok: false, text: 'Waiting for SLACK_BOT_TOKEN.' };
  try {
    const have = await withTimeout(scopes());
    const lacking = ['chat:write', 'commands', 'channels:read'].filter((s) => !have.includes(s));
    return lacking.length
      ? { ok: false, text: `/directory and the welcome button aren’t fully set up: the Slack app is missing ${lacking.join(', ')}.`, fix: 'Slack app → App Manifest → paste slack-manifest.json → Save, then Install App → Reinstall. If Slack shows a new Bot token, update SLACK_BOT_TOKEN in Vercel and redeploy.' }
      : { ok: true, text: '/directory and the welcome button for new members are ready.' };
  } catch (err) {
    return { ok: false, text: explainSlackError(err) };
  }
}

function signingSecret() {
  return need(['SLACK_SIGNING_SECRET'], 'Slack app → Basic Information → Signing Secret → Show → copy into Vercel, then redeploy.')
    || { ok: true, text: 'Set. If the activity below says a message was rejected, it doesn’t match the Slack app’s.' };
}

async function slackChannel() {
  const m = need(['SLACK_CHANNEL_ID'], 'In Slack: click the channel name → About → copy the ID at the bottom (starts with C) into Vercel, then redeploy.');
  if (m) return m;
  if (!env('SLACK_BOT_TOKEN')) return { ok: false, text: 'Waiting for SLACK_BOT_TOKEN.' };
  try {
    await withTimeout(call('conversations.history', { channel: env('SLACK_CHANNEL_ID'), limit: '1' }));
    return { ok: true, text: `The bot can read channel ${env('SLACK_CHANNEL_ID')}.` };
  } catch (err) {
    return { ok: false, text: explainSlackError(err) };
  }
}

function approvers() {
  const list = ids('APPROVERS');
  if (!list.length) return { ok: false, text: 'Missing in Vercel: APPROVERS.', fix: 'For each approver: Slack profile → ⋮ → Copy member ID. Join with commas, no spaces. Then redeploy.' };
  const bad = list.filter((id) => !/^[UW][A-Z0-9]{6,}$/.test(id));
  if (bad.length) return { ok: false, text: `These don’t look like Slack member IDs: ${bad.join(', ')}.`, fix: 'Member IDs start with U and look like U012AB3CD. Copy them from Slack profile → ⋮ → Copy member ID.' };
  return { ok: true, text: `${list.length} approver${list.length === 1 ? '' : 's'}: ${list.join(', ')}.` };
}

function schedule() {
  return need(['CRON_SECRET', 'ADMIN_TOKEN'], 'Make up two different long random strings (README step 6), add them, then redeploy.')
    || { ok: true, text: 'Set. The daily sync and monthly check can run.' };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

export async function GET() {
  const [db, sh, app, ch, fm] = await Promise.all([database(), googleSheet(), slackApp(), slackChannel(), slackForm()]);
  const checks = [
    ['Database', db],
    ['Image storage', images()],
    ['Google Sheet', sh],
    ['Slack app', app],
    ['Slack signing secret', signingSecret()],
    ['Slack channel', ch],
    ['Approvers', approvers()],
    ['/directory form', fm],
    ['Schedule', schedule()],
  ];
  let events = [];
  try { if (db.ok) events = await withTimeout(store.recentEvents()); } catch {}
  const allOk = checks.every(([, c]) => c.ok);

  const row = ([name, c]) => `<li class="${c.ok ? 'ok' : 'no'}"><span class="mark">${c.ok ? '✓' : '✗'}</span><div><b>${esc(name)}</b><p>${esc(c.text)}</p>${c.fix ? `<p class="fix">${esc(c.fix)}</p>` : ''}</div></li>`;
  const event = (e) => `<li class="${e.ok ? 'ok' : 'no'}"><span class="mark">${e.ok ? '✓' : '✗'}</span><div><p>${esc(e.text)}</p><p class="muted">${esc(ago(e.at))}</p></div></li>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>GDG Library · Status</title>
<style>
@font-face{font-family:"ABC Areal";src:url(/fonts/ABCAreal-Medium.woff2) format("woff2");font-weight:500;font-display:swap}
:root{--ink:#000;--paper:#fff;--muted:#8a8a8a;--line:#e6e6e6;--bad:#d4380d}
@media (prefers-color-scheme:dark){:root{--ink:#fff;--paper:#0e0e0e;--muted:#8a8a8a;--line:#262626;--bad:#ff6b4a}}
*{box-sizing:border-box;margin:0}
body{font:500 16px/1.35 "ABC Areal",Helvetica,Arial,sans-serif;background:var(--paper);color:var(--ink);padding:24px 16px 48px;max-width:720px;margin:0 auto}
h1,h2{font-size:16px;font-weight:500}
h2{margin:40px 0 4px;color:var(--muted)}
.summary{margin:8px 0 24px}
ul{list-style:none;padding:0}
li{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}
.mark{width:16px;flex:none}
li.no .mark{color:var(--bad)}
li p{color:var(--muted)}
li .fix{color:var(--ink);margin-top:4px}
.muted{color:var(--muted)}
</style></head><body>
<h1>GDG Library · Status</h1>
<p class="summary ${allOk ? '' : 'muted'}">${allOk ? 'Everything is set up.' : 'Something needs attention. Each ✗ says what to do.'}</p>
<ul>${checks.map(row).join('')}</ul>
<h2>Latest from Slack</h2>
<p class="muted">Every ✅ added or removed in the channel, and every /directory form, newest first.${events.length ? '' : ' Nothing yet. React ✅ to a message with a link, then reload this page. If it stays empty, Slack isn’t sending anything here: check the Slack app’s Event Subscriptions Request URL says Verified and was saved, and that the bot is in the channel (/invite @GDG Library).'}</p>
<ul>${events.map(event).join('')}</ul>
</body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
