// Slack endpoint: events, the /directory command and its form all arrive here.
// An approver reacts ✅ to a message in the channel → every link in it is published
//   (or, for a /directory submission, the listing with everything the member filled in).
// The last approver ✅ removed → that message's links come off the site.
// /directory opens a form to join or update your listing (see lib/directory.js).
// Work is idempotent, so Slack's automatic retries are harmless.
// Each ✅, form and anything that goes wrong is noted in plain words for the status page.

import { verify, explainSlackError } from '../lib/slack.js';
import { publish, unpublish } from '../lib/library.js';
import { logEvent } from '../lib/store.js';
import * as directory from '../lib/directory.js';

const list = (v, d = '') => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);

const cfg = () => ({
  secret: process.env.SLACK_SIGNING_SECRET,
  approvers: list(process.env.APPROVERS),
  emojis: list(process.env.APPROVE_EMOJI, 'white_check_mark'),
  channel: process.env.SLACK_CHANNEL_ID || '',
});

export async function GET() {
  return new Response('GDG Library: Slack endpoint is up.', { status: 200 });
}

export async function POST(request) {
  const raw = await request.text();
  const c = cfg();
  // The /directory command and its form arrive form-encoded; events arrive as JSON.
  if ((request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) {
    if (!verify(c.secret, request.headers, raw)) {
      await logEvent({ ok: false, text: 'Rejected a message from Slack: SLACK_SIGNING_SECRET doesn’t match the Slack app’s Signing Secret.' });
      return new Response('bad signature', { status: 401 });
    }
    return form(new URLSearchParams(raw), c);
  }
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  // Before the signing secret exists (first app setup), still answer Slack's URL check.
  if (body.type === 'url_verification' && !c.secret) return Response.json({ challenge: body.challenge });
  if (!verify(c.secret, request.headers, raw)) {
    await logEvent({ ok: false, text: 'Rejected a message from Slack: SLACK_SIGNING_SECRET doesn’t match the Slack app’s Signing Secret.' });
    return new Response('bad signature', { status: 401 });
  }
  if (body.type === 'url_verification') return Response.json({ challenge: body.challenge });
  if (body.type !== 'event_callback') return ok();

  const ev = body.event || {};
  if (ev.type !== 'reaction_added' && ev.type !== 'reaction_removed') return ok();
  if (!c.emojis.includes(ev.reaction)) return ok(); // any other emoji: not ours, not noted
  if (ev.item?.type !== 'message') return ok();
  const verb = ev.type === 'reaction_added' ? 'added' : 'removed';
  if (c.channel && ev.item.channel !== c.channel) {
    await logEvent({ ok: false, text: `Ignored a ✅ ${verb} in another channel (${ev.item.channel}). Only ${c.channel} counts.` });
    return ok();
  }
  if (!c.approvers.includes(ev.user)) {
    await logEvent({ ok: false, text: `Ignored a ✅ ${verb} by ${ev.user}, who isn’t in APPROVERS.` });
    return ok();
  }

  const { channel, ts } = ev.item;
  try {
    if (ev.type === 'reaction_added') {
      const added = await publish(channel, ts, ev.event_ts);
      await logEvent(added.length
        ? { ok: true, text: `✅ by ${ev.user}: added ${added.map(([, e]) => e.host).join(', ')}.` }
        : { ok: false, text: `✅ by ${ev.user}, but that message has no links.` });
    } else {
      const removed = await unpublish(channel, ts, c.approvers, c.emojis);
      await logEvent({ ok: true, text: removed.length ? `✅ removed by ${ev.user}: took off ${removed.join(', ')}.` : `✅ removed by ${ev.user}; another approver’s ✅ keeps it live.` });
    }
    return ok();
  } catch (err) {
    console.error(err);
    await logEvent({ ok: false, text: explainSlackError(err) });
    return new Response('error', { status: 500 }); // Slack retries
  }
}

async function form(params, c) {
  // /directory → open the form
  if (params.get('command')) {
    const user = params.get('user_id');
    try {
      await directory.open(params.get('trigger_id'), user);
      return ok();
    } catch (err) {
      console.error(err);
      await logEvent({ ok: false, text: `/directory by ${user} couldn’t open the form. ${explainSlackError(err)}` });
      return Response.json({ response_type: 'ephemeral', text: 'Sorry, the directory form couldn’t open. Please try again in a minute.' });
    }
  }
  // The form was submitted
  let payload;
  try { payload = JSON.parse(params.get('payload') || '{}'); } catch { return ok(); }
  if (payload.type !== 'view_submission' || payload.view?.callback_id !== 'gdg_directory') return ok();
  const user = payload.user?.id;
  if (!c.channel) {
    await logEvent({ ok: false, text: `A /directory form from ${user} couldn’t be posted: SLACK_CHANNEL_ID isn’t set.` });
    return Response.json({ response_action: 'errors', errors: { url: 'The directory isn’t fully set up yet. Please let an admin know.' } });
  }
  try {
    const { response, note } = await directory.submit(payload.view, user, c.channel);
    if (note) await logEvent(note);
    return Response.json(response);
  } catch (err) {
    console.error(err);
    await logEvent({ ok: false, text: `A /directory form from ${user} failed. ${explainSlackError(err)}` });
    return Response.json({ response_action: 'errors', errors: { url: 'Something went wrong saving this. Please try again in a minute.' } });
  }
}

function ok() {
  return new Response('', { status: 200 });
}
