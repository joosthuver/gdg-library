// /directory: a Slack form for joining the index or updating your own listing.
//
//   /directory → a form opens (filled in with your current listing if you have one)
//   Joining the channel → a message only you can see, with a button that opens the same form
//   /directory post (approvers) → the button posted in the channel, for members already there
//   New site, or a listing you don't own yet → posted in the channel; an approver's ✅ publishes it
//   Your own live listing → saved straight away (site and sheet), no approval needed
//
// Ownership comes from the first approved form for a site. Listings added by link, sheet or import
// have no owner until their member submits the form once and it's approved.

import { call } from './slack.js';
import { normalize, tidy } from './meta.js';
import { parseGallery } from './sheet.js';
import * as store from './store.js';
import { isLive, updateListing, listingFields } from './library.js';

const CALLBACK = 'gdg_directory';
export const OPEN_ACTION = 'gdg_directory_open';
const plain = (text) => ({ type: 'plain_text', text, emoji: true });
const input = (id, label, element, { optional = false, hint } = {}) => ({
  type: 'input', block_id: id, optional, label: plain(label),
  element: { ...element, action_id: 'v' }, ...(hint ? { hint: plain(hint) } : {}),
});
const text = (value, extra = {}) => ({ type: 'plain_text_input', ...(value ? { initial_value: String(value) } : {}), ...extra });
const AVAILABLE = { text: plain('Available for work'), value: 'yes' };

/** The member's own live listing, if any. */
async function ownListing(user) {
  return (await store.all()).find(([, e]) => isLive(e) && e.owner === user) || null;
}

/** The form, filled in with `e` when updating. */
export function modal(e) {
  return {
    type: 'modal',
    callback_id: CALLBACK,
    title: plain(e ? 'Update your listing' : 'Join the directory'),
    submit: plain(e ? 'Save' : 'Submit'),
    close: plain('Cancel'),
    blocks: [
      ...(e ? [] : [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Your listing on globaldesign.group. An approver reviews it in the channel before it goes live.' }] }]),
      input('url', 'Your website', { type: 'url_text_input', ...(e?.url ? { initial_value: e.url } : {}) }),
      input('title', 'Name', text(e?.title, { placeholder: plain('Your name, or your studio’s') })),
      input('practice', 'Title', text(e?.practice, { placeholder: plain('Designer, Creative Director, Photographer…') })),
      input('company', 'Company', text(e?.company), { optional: true }),
      input('location', 'Based in', text(e?.location, { placeholder: plain('Amsterdam') }), { optional: true, hint: 'Shown as you write it, e.g. “Toronto and Copenhagen”.' }),
      input('country', 'Country', text(e?.country, { placeholder: plain('Netherlands') }), { optional: true, hint: 'For the country count. Several are fine: “Canada, Denmark”.' }),
      input('available', 'Availability', { type: 'checkboxes', options: [AVAILABLE], ...(e?.available ? { initial_options: [AVAILABLE] } : {}) }, { optional: true }),
      input('picks', 'Images of your work', text((e?.picks || []).join('\n'), { multiline: true, placeholder: plain('https://…/project.jpg') }), {
        optional: true, hint: 'Up to 6 image links, one per line. Leave empty to use images from your site.',
      }),
    ],
  };
}

/** Read and check a submitted form. Returns { fields } or { errors } (block_id → message). */
export function read(view) {
  const v = view.state.values;
  const val = (id) => String(v[id]?.v?.value ?? '').trim();
  const errors = {};
  let url = val('url');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  try { if (!/\./.test(new URL(url).hostname)) throw 0; } catch { errors.url = 'Enter your site’s address, e.g. https://yourname.com'; }
  const lines = val('picks').split(/\s+/).filter(Boolean);
  const picks = parseGallery(lines);
  if (lines.length > picks.length) errors.picks = 'Use full image links starting with https://, one per line (up to 6).';
  if (Object.keys(errors).length) return { errors };
  return { fields: {
    url: tidy(url), title: val('title'), practice: val('practice'), company: val('company'),
    location: val('location'), country: val('country'), available: (v.available?.v?.selected_options || []).length > 0, picks,
  } };
}

const done = (title, message) => ({ response_action: 'update', view: {
  type: 'modal', title: plain(title), close: plain('Done'),
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }],
} });

const button = (label) => ({ type: 'actions', elements: [{ type: 'button', action_id: OPEN_ACTION, value: 'open', style: 'primary', text: plain(label) }] });
const note = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const say = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });

/** Someone joined the channel: a message only they can see, with the button. */
export async function welcome(user, channel) {
  const own = await ownListing(user);
  const blocks = own
    ? [say('*Welcome back.* Your listing on globaldesign.group can be updated any time.'), button('Update your listing')]
    : [say('*Welcome!* Add your site to the directory on globaldesign.group. It takes a minute, and an approver reviews it here before it goes live.'), button('Join the directory')];
  await call('chat.postEphemeral', {
    channel, user, text: 'Add your site to globaldesign.group: tap Join the directory, or type /directory.',
    blocks: JSON.stringify([...blocks, note('Only you can see this. You can also type /directory any time.')]),
  });
}

/** /directory post: the button in the channel, for everyone already there. */
export async function announce(channel) {
  await call('chat.postMessage', {
    channel, text: 'Add your site to globaldesign.group, or update your listing.', unfurl_links: 'false',
    blocks: JSON.stringify([say('*The directory on globaldesign.group.* Add your site, or update your listing.'), button('Join or update'), note('Or type /directory any time.')]),
  });
}

/** /directory: open the form. */
export async function open(triggerId, user) {
  const own = await ownListing(user);
  await call('views.open', { trigger_id: triggerId, view: JSON.stringify(modal(own?.[1])) });
}

/** The form was submitted. Returns the response for Slack (errors, or a confirmation view) and a note for the status page. */
export async function submit(view, user, channel) {
  const { fields, errors } = read(view);
  if (errors) return { response: { response_action: 'errors', errors } };
  fields.owner = user;
  const id = normalize(fields.url);
  const [current] = await store.get([id]);

  // Their own live listing: save it now.
  if (isLive(current) && current.owner === user) {
    await updateListing(id, listingFields(fields));
    return {
      response: done('Saved', '*Your listing is updated.* Changes show on globaldesign.group within a minute.'),
      note: { ok: true, text: `${user} updated their listing (${current.host}) with /directory.` },
    };
  }

  // Anything else goes to the channel for an approver's ✅.
  const updating = isLive(current);
  const line = (label, value) => (value ? `\n*${label}:* ${value}` : '');
  const summary = `${updating ? 'Update to a listing' : 'New for the directory'} from <@${user}>: <${fields.url}>`
    + line('Name', fields.title) + line('Title', fields.practice) + line('Company', fields.company)
    + line('Based in', [fields.location, fields.country].filter(Boolean).join(', '))
    + line('Availability', fields.available ? 'Available for work' : '')
    + line('Images', fields.picks.length ? `${fields.picks.length} chosen` : '')
    + '\n_Approvers: react ✅ to publish._';
  const posted = await call('chat.postMessage', { channel, text: summary, unfurl_links: 'false', unfurl_media: 'false' });
  await store.putSubmission(`${posted.channel}:${posted.ts}`, { fields, user, at: new Date().toISOString() });
  return {
    response: done('Thanks', `*Got it.* Your ${updating ? 'update' : 'listing'} is in <#${channel}> for an approver to ✅. You can run /directory again later to update it yourself.`),
    note: { ok: true, text: `${user} submitted ${new URL(fields.url).hostname} with /directory; waiting for ✅.` },
  };
}
