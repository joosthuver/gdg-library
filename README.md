# GDG Library

The globaldesign.group homepage: a visual index of the members' sites, fed by the GDG Slack channel.

This guide is for the admin. **Part 1** explains how it works. **Part 2** is the one-time setup,
in order, across GitHub, Vercel, Slack and Google (about an hour). **Part 3** covers day-to-day
running. Nothing needs installing on your computer.

---

## 1. How it works

```
A member posts their site in the channel
        ↓
An approver reacts ✅
        ↓
The site appears on the homepage as a card   →   and as a row in the Google Sheet
        ↓
Once a month the site is checked against the sheet. The sheet wins.
```

- **Join with a form:** anyone joining the Slack channel gets a message only they can see, with a
  **Join the directory** button. Tapping it (or typing `/directory` anywhere) opens a short form that asks for their site, name,
  title, company, location, availability and (optionally) images of their work. It's posted in the
  channel, and an approver's ✅ publishes it with everything filled in. Running `/directory` again
  lets them update their own listing, e.g. their availability, without needing approval.
- **Or approve a link:** an approver reacts ✅ to any message with a link. Every link in it goes live within 30 seconds.
- **Un-approve:** remove the ✅. Those links come off the site and out of the sheet.
- **Cards show work, never a screenshot of the site** (nor the site's share image, which often is one). Each card holds up to 6 images. The first
  is the cover, and the rest play as a slideshow. They're found on the member's homepage
  automatically, or chosen in the form or the sheet's Gallery column. Each card shows the name and
  title, plus an "Available for work" pill when they are. The + panel adds company and location.
- **The sheet is the admin's control panel.** Anything a member didn't fill in can be added there. Edits
  to live sites reach the site within about 10 minutes. Rows added or deleted in the sheet are applied
  on the 1st of each month, or straight away by running the check by hand.
- **Nothing private is shown:** no Slack names, message text or dates. The Apply email address is
  never shown on the page.
- **On the page:**
  - **Header:** the logo, live counts of sites and countries, the visitor's time with its UTC
    offset, Info and Apply.
  - **Dock:** Light/Dark, Grid/Index, A–Z/Latest, and search (which also matches company,
    and "available").

### What runs where

| Piece | Service | Cost |
|---|---|---|
| Code | GitHub | free |
| Website, endpoints, scheduled checks | Vercel | free (Hobby) |
| The list of live sites | Upstash Redis, added inside Vercel | free tier |
| Card images | Vercel Blob | free tier |
| Approvals | Slack app "GDG Library" | works on Slack's free plan |
| Admin sheet | Google Sheets, through a service account | free |
| Finding images on sites built in JavaScript | Microlink | free up to 50 a day; an optional key removes the limit |

### Schedule

| When | What happens |
|---|---|
| When someone visits, at most every 10 minutes | Sheet edits to live sites (Name, Title, Company, Location, Country, Availability, Image, Gallery) reach the site. Runs after the page has loaded, so visitors never wait. Never adds or removes. |
| Every day, around 9am New York | The same sync, in case nobody visited. |
| 1st of the month, around 10am New York | Full check: rows added in the sheet go live, deleted rows come off, every row gets a Status. |

---

## 2. Setup

Do the steps in order. The domain switch is last, so the current homepage stays up until
everything works.

You'll collect these values along the way. Keep them somewhere private.

```
SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_ID, APPROVERS
GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
CRON_SECRET, ADMIN_TOKEN
```

### Step 1 · GitHub: put the code in a repository

1. Create a new **private** repository, e.g. `gdg-library`, under your account or the GDG organization.
2. **Add file → Upload files**, drag in everything *inside* this folder (not the folder itself),
   and commit.
3. Check that the repository's top level shows `index.html`, `api/`, `lib/`, `fonts/`, `vendor/`
   and `vercel.json`.

The `fonts/` folder holds ABC Areal Medium, the site's only typeface. Without it the site falls
back to Helvetica. Areal needs a Dinamo web license for a public site.

### Step 2 · Vercel: deploy

1. In Vercel, **Add New → Project** and import the GitHub repository.
2. Leave every setting as it is (Framework Preset **Other**, no build command) and click **Deploy**.
3. Note the project's address (`something.vercel.app`). This guide calls it your **Vercel address**.

The page says "The index is unavailable right now" until steps 3–6 are done. That's expected.

### Step 3 · Vercel: add storage

In the project, open **Storage**:

1. **Create → Upstash for Redis** (free plan) and connect it to this project.
2. **Create → Blob**, choose **Public** access, and connect it to this project.

Both add their own environment variables automatically.

### Step 4 · Slack: create the app

You need to be a workspace admin, or have one approve the install.

1. In Slack's app dashboard (**Your Apps**): **Create New App → From a manifest** → pick the GDG
   workspace → JSON → paste the contents of `slack-manifest.json` → **Create**. If Slack says the
   request URL isn't verified yet, that's fine; step 7 fixes it.
2. **Install App → Install to Workspace → Allow.** Copy the **Bot User OAuth Token**
   (starts with `xoxb-`). That's `SLACK_BOT_TOKEN`.
3. **Basic Information → App Credentials → Signing Secret → Show.** That's `SLACK_SIGNING_SECRET`.
4. In the channel where members post their sites, type `/invite @GDG Library`.
5. **Channel ID:** click the channel name → **About**; it's at the bottom and starts with `C`.
   That's `SLACK_CHANNEL_ID`.
6. **Approvers:** for each person allowed to approve, open their profile → **⋮ → Copy member ID**
   (starts with `U`). Join them with commas and no spaces, e.g. `U012AB3CD,U045EF6GH`. That's `APPROVERS`.

If the channel is private, add `groups:history` next to `channels:history` under **App Manifest**
in the app dashboard, save, and reinstall the app.

### Step 5 · Google: connect the sheet

1. In the Google Cloud Console, create a project (e.g. "GDG Library").
2. **APIs & Services → Library →** search **Google Sheets API → Enable**.
3. **IAM & Admin → Service Accounts → Create service account.** Name it "gdg-library", skip the
   optional steps, **Done**.
4. Open the service account → **Keys → Add key → Create new key → JSON**. A file downloads. From it:
   - `client_email` is `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` is `GOOGLE_PRIVATE_KEY` (the whole value, from `-----BEGIN` to `END PRIVATE KEY-----\n`)
5. Create a new, empty Google Sheet (e.g. "GDG Library") and **Share** it with the `client_email`
   address as **Editor**.
6. The sheet ID is the long string in the sheet's address, between `/d/` and `/edit`. That's `GOOGLE_SHEET_ID`.

The app creates the `Sites` and `Checks` tabs, their headers and the Title and Availability dropdowns itself.
If Google blocks key creation (some company accounts do), use a personal Google account.

### Step 6 · Vercel: environment variables

Project → **Settings → Environment Variables**. Add each one for all environments:

| Name | Value |
|---|---|
| `SLACK_BOT_TOKEN` | from step 4.2 |
| `SLACK_SIGNING_SECRET` | from step 4.3 |
| `SLACK_CHANNEL_ID` | from step 4.5. Only this channel counts |
| `APPROVERS` | from step 4.6 |
| `GOOGLE_SHEET_ID` | from step 5.6 |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | from step 5.4 |
| `GOOGLE_PRIVATE_KEY` | from step 5.4, pasted exactly as it appears in the file |
| `CRON_SECRET` | a long random string (30+ characters). Lets only Vercel run the scheduled checks |
| `ADMIN_TOKEN` | a different long random string. Lets the admin import sites by hand |

Optional:

| Name | Value |
|---|---|
| `MICROLINK_API_KEY` | removes the 50-a-day limit on finding images on sites built in JavaScript |
| `APPROVE_EMOJI` | a different approval emoji's name; the default is `white_check_mark` (✅) |

Then **Deployments →** the latest one **→ ⋯ → Redeploy**, so the values take effect.

### Step 7 · Slack: point the app at Vercel

In the Slack app dashboard → **Event Subscriptions → Request URL**, enter your Vercel address
followed by `/api/slack`. Wait for **Verified ✓**, then **Save Changes**.

Test it: post any portfolio link in the channel, react ✅ as an approver, and reload your Vercel
address after 30 seconds. Your Vercel address followed by `/api/status` shows whether each piece is set up
and what happened to that ✅. A card appears, and a row appears in the sheet. Remove the ✅ and both
go away. If anything fails, see Troubleshooting below.

### Step 8 · Add the launch sites

`preload/` holds the launch sites. Each comes with title, location, country and a Gallery of images of their work.
They're timed one minute apart, so Latest shows them in this order.

1. Vercel → **Settings → Cron Jobs** → **Run** the `/api/check?mode=sync` job. This creates the
   `Sites` tab in the sheet.
2. In the sheet: **File → Import → Upload** `preload/sites.csv` → **Insert new sheet(s)**. Copy
   rows 2–10 of the new tab (everything below the header), paste them into cell **A2** of the
   `Sites` tab, then delete the imported tab.
3. **Run** the `/api/check` job. Each row goes live with the Status "Added to site".

Open your Vercel address. Each card's images are captured and stored the first time it's viewed,
so the first visit takes a few seconds per card.

### Step 9 · Switch the domain

Once the index looks right on the Vercel address:

1. Vercel → **Settings → Domains → Add** `globaldesign.group`, and `www.globaldesign.group` set to
   redirect to it.
2. Vercel shows the DNS records to set. Add them where the domain is registered, and remove the
   old records that point to the current site builder. The switch usually takes minutes, sometimes
   a few hours.
3. In the Slack app → **Event Subscriptions**, change the Request URL to the domain followed by
   `/api/slack`, and save. Once it's verified, setup is done.

---

## 3. Running it

### Approving

- Only people in `APPROVERS` count, and only in `SLACK_CHANNEL_ID`.
- A message with several links publishes all of them.
- The same site posted twice becomes one card. It stays live while any approved message still links to it.
- For a plain link, the name comes from Slack's link preview, then the site's own title, then its
  address. Correct it in the sheet's Name column.
- A `/directory` form posts as a message from the GDG Library app. Approving it works the same way: ✅
  to publish, remove the ✅ to take it off.
- Removing the ✅ always wins. To bring a site back, approve it again in Slack.
- Slack's free plan only keeps 90 days of messages, so a ✅ on an older post does nothing. Add
  those sites in the sheet instead.

### The sheet

`Sites` tab: **Name | URL | Title | Company | Location | Country | Availability | Image | Gallery | Added | Status | Last checked**

The app finds columns by their header, so you can reorder them or add your own columns. Just keep
the header names as they are.

| Column | What goes there | Shown on the site? |
|---|---|---|
| Name | The person's or studio's name | Yes |
| URL | Their site | Yes, as the link |
| Title | What they do: Designer, Creative Director, Photographer… Pick from the dropdown or type anything | Yes. Left empty, nothing shows in its place |
| Company | Where they work, if anywhere | Yes, in the + panel |
| Location | Where they're based, as it should read: "Toronto and Copenhagen" | Yes, in the + panel |
| Country | Feeds the country count. Several are fine: "Canada, Denmark". Keep spellings consistent ("United Kingdom", never sometimes "UK") | No |
| Availability | "Available" shows an "Available for work" pill on their card. Blank or "Not available" shows nothing | Yes, as the pill |
| Image | Optional, and usually left empty: one image address to put first, as the cover | Yes, as the cover |
| Gallery | The card's images: up to 6 image addresses of their work, one per line. They replace the images found on the site; the first is the cover (unless Image is filled in) | Yes, in the card's slideshow |
| Added | Filled in automatically. Only orders Latest | No |
| Status, Last checked | Written by the app. Don't edit | No |

- **Edit a live site** (any column from Name to Gallery) → on the site within about 10 minutes.
- **Change a card's images:** paste the new image addresses in its Gallery cell. The old ones are
  replaced and the new ones stored, within about 10 minutes.
- **Members' own edits** with `/directory` are written to their row too, so the sheet always matches the site.
- **Add a row** → goes live on the 1st of the month.
- **Delete a row** → comes off on the 1st of the month.
- **Apply changes now:** Vercel → **Settings → Cron Jobs → Run** `/api/check`.
- **Clear the Gallery cell** → the card goes back to images found on the site.
- **Getting image addresses:** on the member's site, right-click an image → **Copy Image Address**.
  The address has to open the image itself, publicly. Members can also add their picks themselves
  with `/directory`.
- A row that isn't a link, or repeats another row, is flagged in Status and skipped.
- If the sheet ever comes back empty, the check changes nothing and logs why, so the site can't be
  wiped by accident.
- The `Checks` tab gets one line per monthly run: what was added and what was removed.

### /directory

What members see: a form only they can see. It opens three ways:

- **Joining the channel:** the bot sends them a message only they can see, with a **Join the directory**
  button (or **Update your listing**, if they already own one). Once per person; nobody else sees it.
- **Typing `/directory`** in any channel or DM.
- **A button in the channel:** an approver types `/directory post` to post the button for everyone
  already in the channel. Anyone else typing that just gets their form.

| Who submits | What happens |
|---|---|
| Someone new | Their listing is posted in the channel. An approver's ✅ publishes it, and they become its owner |
| The owner of a live listing | Their changes are saved straight away, to the site and the sheet. No approval needed |
| Anyone else, for a site already listed (e.g. a launch site) | Posted in the channel as an update. An approver's ✅ replaces the details and makes them the owner |

Owners can't be changed by hand. To hand a listing to someone, they submit `/directory` and an
approver ✅s it.

### Changing things

| To change | Where |
|---|---|
| Who can approve | `APPROVERS` in Vercel, then redeploy |
| The Apply email | `APPLY_EMAIL` near the top of the script in `index.html` |
| The Info panel text | the `#info` section in `index.html` |

Any change committed to GitHub redeploys the site within a minute.

### Troubleshooting

**Start with the status page:** your site's address followed by `/api/status`, e.g. `gdg-library.vercel.app/api/status`.
It shows a ✓ or ✗ for each piece (database, image storage, sheet, Slack, approvers, the /directory form and welcome button, schedule),
says what to do about each ✗, and lists the last few ✅ and forms from Slack and what happened to each. It never
shows the settings' values.
For anything it doesn't explain, Vercel → project → **Logs** has the full errors.

| Problem | Check |
|---|---|
| ✅ does nothing | The reactor's ID is in `APPROVERS`; the bot is in the channel (`/invite @GDG Library`); `SLACK_CHANNEL_ID` is that channel; the message is under 90 days old; the Request URL shows Verified |
| Slack says `/directory` "is not a valid command", or "dispatch_failed" | The Slack app needs the updated manifest (see "Updating the Slack app" below); the status page shows this as ✗ /directory form |
| New members don't get the button | The Slack app needs the updated manifest (it adds `channels:read` and the "someone joined" event); the bot is in the channel. Latest from Slack notes each welcome |
| A card appears but the sheet doesn't update | The status page says why, in Google's words, under Google Sheet and Latest from Slack. If the sheet can't be edited, share it with the service account as **Editor**. The site stays live either way; the missing row is added on the next monthly check, or run `/api/check` by hand |
| A card shows just the name | No images of work were found on the site (it's looked at again after a week; share images are never used, since they're often a picture of the page), or the 50-a-day limit for sites built in JavaScript was reached (it fills in on a later visit). Paste image addresses in the Gallery column to fix it for good |
| A card shows the wrong images | Paste the right ones in the Gallery column |
| The page says "unavailable" | Redis is connected to the project (step 3) and the project was redeployed afterwards |
| A new site takes a while to appear | The list is cached for 30 seconds |
| The wrong font | The `fonts/` folder is missing from the repository |

### Updating the Slack app

Whenever `slack-manifest.json` changes (it last added the welcome button for new members), a Slack
admin does this once:

1. Slack's app dashboard → **GDG Library → App Manifest** → switch to JSON, replace everything with
   the contents of `slack-manifest.json` → **Save Changes**. If Slack asks to verify the URL, it's
   `https://globaldesign.group/api/slack`.
2. **Install App → Reinstall to Workspace → Allow.**
3. If the **Bot User OAuth Token** shown there changed, paste the new one into `SLACK_BOT_TOKEN` in
   Vercel and redeploy.
4. Open the status page. **/directory form** should show ✓. Then type `/directory` in Slack, or
   `/directory post` to put the button in the channel for members already there.

---

## For developers

```
index.html            the homepage: markup, styles and script in one file
share-image.png       the preview shown when the site's link is shared (1200×630)
apple-touch-icon.png  the icon when the site is added to an iPhone home screen
favicon.svg           favicon
fonts/                ABC Areal Medium (the .woff2 is what the site loads; the .ttf and Medium Italic are spares)
vendor/gsap/          GSAP 3.13 + ScrollTrigger for the motion; the page works without them
api/slack.js          Slack events: ✅ added / removed
api/sites.js          public list for the homepage, cached 30 s
api/cover.js          a card's cover    } a card's images are captured together on
api/gallery.js        a card's gallery  } first view and stored in Blob
api/check.js          monthly check and daily sync (Vercel Cron)
api/import.js         bulk add / remove (Authorization: Bearer ADMIN_TOKEN)
api/status.js         the setup check page: each piece ✓ / ✗ and recent Slack activity
lib/directory.js      the /directory form and its button: welcome new members, open, check, post for ✅ or save the owner's changes
lib/                  Slack, Redis, Sheets, card images, page metadata, country count
preload/              the launch sites, as CSV (for the sheet) and JSON (for /api/import)
slack-manifest.json   the Slack app definition
vercel.json           cron schedule, function timeouts, image settings, font caching
test/                 tests and their fixture images
```

The launch sites can also be added with one request instead of step 8:

```sh
curl -X POST "<your Vercel address>/api/import" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  --data @preload/sites.json
```

Tests need Node 20 or newer; run `npm install` first.

- `npm test`: 90 backend tests covering Slack events, the /directory form, the sheet sync and monthly check, card
  images and the preload, with all outside services mocked.
- `npm run test:browser`: 401 checks in Chromium across phones, tablet and desktop up to 2560,
  light and dark, reduced motion, GSAP missing, an empty index and the API being down.
  Screenshots go to `test/shots/`. It needs Playwright's Chromium (`npx playwright install chromium`)
  or `CHROMIUM_PATH`. Check on a real iPhone in Safari before launch.
