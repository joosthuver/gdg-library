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

- **Approve:** an approver reacts ✅ to a message. Every link in it goes live within 30 seconds.
- **Un-approve:** remove the ✅. Those links come off the site and out of the sheet.
- **Cards show work, never a screenshot of the site.** Each card holds up to 6 images. The first
  is the cover, and the rest play as a slideshow. They're found on the member's homepage
  automatically, or chosen in the sheet's Gallery column. Each card shows the name, practice
  and location.
- **The sheet is the admin's control panel.** Fill in Practice, Location and Country there. Edits
  to live sites reach the site the next morning. Rows added or deleted in the sheet are applied
  on the 1st of each month, or straight away by running the check by hand.
- **Nothing private is shown:** no Slack names, message text or dates. The Apply email address is
  never shown on the page.
- **On the page:**
  - **Header:** the logo, live counts of sites and countries, the visitor's time with its UTC
    offset, Light/Dark, and Apply.
  - **Dock:** Info, Grid/Index, A–Z/Latest, and search.

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
| Every day, around 9am New York | Sheet edits to live sites (Title, Practice, Location, Country, Image, Gallery) reach the site. Never adds or removes. |
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

The app creates the `Sites` and `Checks` tabs, their headers and the Practice dropdown itself.
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
address after 30 seconds. A card appears, and a row appears in the sheet. Remove the ✅ and both
go away. If anything fails, see Troubleshooting below.

### Step 8 · Add the launch sites

`preload/` holds the nine launch sites (9 sites from 5 countries): Jonas Emmertsen, Camille Mormal,
Roy van Dijk, Joost Huver, Doug Alves, Anders Svensson, Mike Sullivan, Jordi van der Oord and
Jacob Grubbe. Each comes with practice, location, country and a Gallery of images of their work.
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
- Names come from Slack's link preview, then the site's own title, then its address. Correct a
  name in the sheet's Title column.
- Removing the ✅ always wins. To bring a site back, approve it again in Slack.
- Slack's free plan only keeps 90 days of messages, so a ✅ on an older post does nothing. Add
  those sites in the sheet instead.

### The sheet

`Sites` tab: **Title | URL | Practice | Location | Country | Image | Gallery | Added | Status | Last checked**

| Column | What goes there | Shown on the site? |
|---|---|---|
| Title | The person's or studio's name | Yes |
| URL | Their site | Yes, as the link |
| Practice | What they do: Designer, Creative Director, Photographer… Pick from the dropdown or type anything | Yes. Until it's filled in, the card shows the address |
| Location | Where they're based, as it should read: "Toronto and Copenhagen" | Yes |
| Country | Feeds the country count. Several are fine: "Canada, Denmark". Keep spellings consistent ("United Kingdom", never sometimes "UK") | No |
| Image | Optional: one image address to use as the cover | Yes, as the cover |
| Gallery | Optional: up to 6 image addresses of their work, one per line. They replace the images found on the site. If Image is empty, the first one is the cover | Yes, in the card's slideshow |
| Added | Filled in automatically. Only orders Latest | No |
| Status, Last checked | Written by the app. Don't edit | No |

- **Edit a live site** (any of the first seven columns) → on the site the next morning.
- **Add a row** → goes live on the 1st of the month.
- **Delete a row** → comes off on the 1st of the month.
- **Apply changes now:** Vercel → **Settings → Cron Jobs → Run** `/api/check`.
- **Clear the Gallery cell** → the card goes back to images found on the site.
- **Getting image addresses:** on the member's site, right-click an image → **Copy Image Address**.
  The address has to open the image itself, publicly. Members can also post their picks with their
  link in Slack for the admin to paste in.
- A row that isn't a link, or repeats another row, is flagged in Status and skipped.
- If the sheet ever comes back empty, the check changes nothing and logs why, so the site can't be
  wiped by accident.
- The `Checks` tab gets one line per monthly run: what was added and what was removed.

### Changing things

| To change | Where |
|---|---|
| Who can approve | `APPROVERS` in Vercel, then redeploy |
| The Apply email | `APPLY_EMAIL` near the top of the script in `index.html` |
| The Info panel text | the `#info` section in `index.html` |

Any change committed to GitHub redeploys the site within a minute.

### Troubleshooting

Vercel → project → **Logs** shows every Slack, Sheets and storage error.

| Problem | Check |
|---|---|
| ✅ does nothing | The reactor's ID is in `APPROVERS`; the bot is in the channel (`/invite @GDG Library`); `SLACK_CHANNEL_ID` is that channel; the message is under 90 days old; the Request URL shows Verified |
| A card appears but the sheet doesn't update | The sheet is shared with the service account as **Editor**; `GOOGLE_PRIVATE_KEY` was pasted whole; the Sheets API is enabled |
| A card shows just the name | No usable images were found on the site (it's looked at again after a week), or the 50-a-day limit for sites built in JavaScript was reached (it fills in on a later visit). Paste image addresses in the Gallery column to fix it for good |
| A card shows the wrong images | Paste the right ones in the Gallery column |
| The page says "unavailable" | Redis is connected to the project (step 3) and the project was redeployed afterwards |
| A new site takes a while to appear | The list is cached for 30 seconds |
| The wrong font | The `fonts/` folder is missing from the repository |

---

## For developers

```
index.html            the homepage: markup, styles and script in one file
favicon.svg           favicon
fonts/                ABC Areal Medium (the .woff2 is what the site loads; the .ttf and Medium Italic are spares)
vendor/gsap/          GSAP 3.13 + ScrollTrigger for the motion; the page works without them
api/slack.js          Slack events: ✅ added / removed
api/sites.js          public list for the homepage, cached 30 s
api/cover.js          a card's cover    } a card's images are captured together on
api/gallery.js        a card's gallery  } first view and stored in Blob
api/check.js          monthly check and daily sync (Vercel Cron)
api/import.js         bulk add / remove (Authorization: Bearer ADMIN_TOKEN)
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

- `npm test`: 58 backend tests covering Slack events, the sheet sync and monthly check, card
  images and the preload, with all outside services mocked.
- `npm run test:browser`: 346 checks in Chromium across phones, tablet and desktop up to 2560,
  light and dark, reduced motion, GSAP missing, an empty index and the API being down.
  Screenshots go to `test/shots/`. It needs Playwright's Chromium (`npx playwright install chromium`)
  or `CHROMIUM_PATH`. Check on a real iPhone in Safari before launch.
