// Slack Events API endpoint.
// An approver reacts ✅ to a message in the channel → every link in it is published.
// The last approver ✅ removed → that message's links come off the site.
// Work is idempotent, so Slack's automatic retries are harmless.

import { verify } from '../lib/slack.js';
import { publish, unpublish } from '../lib/library.js';

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
  let body;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  // Before the signing secret exists (first app setup), still answer Slack's URL check.
  if (body.type === 'url_verification' && !c.secret) return Response.json({ challenge: body.challenge });
  if (!verify(c.secret, request.headers, raw)) return new Response('bad signature', { status: 401 });
  if (body.type === 'url_verification') return Response.json({ challenge: body.challenge });
  if (body.type !== 'event_callback') return ok();

  const ev = body.event || {};
  if (ev.type !== 'reaction_added' && ev.type !== 'reaction_removed') return ok();
  if (!c.emojis.includes(ev.reaction)) return ok();
  if (ev.item?.type !== 'message') return ok();
  if (c.channel && ev.item.channel !== c.channel) return ok();
  if (!c.approvers.includes(ev.user)) return ok();

  const { channel, ts } = ev.item;
  try {
    if (ev.type === 'reaction_added') await publish(channel, ts, ev.event_ts);
    else await unpublish(channel, ts, c.approvers, c.emojis);
    return ok();
  } catch (err) {
    console.error(err);
    return new Response('error', { status: 500 }); // Slack retries
  }
}

function ok() {
  return new Response('', { status: 200 });
}
