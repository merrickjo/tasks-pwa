# Notch — tasks, calendar, bullet journal, CONCURSUS

No subscriptions, no Notion. The pieces:

```
Web app (GitHub Pages) ─┐
Android APK (android/) ─┼─→ Cloudflare Worker (worker/) ─→ D1: tasks, journal, ink, CONCURSUS history
                        │                                    ↑
Obsidian vault  ←── Mac sync (every 5 min, mac/) ─────────────┘
  Notch/Tasks    two-way, the vault is the source of truth for tasks
  Notch/Journal  one-way mirror of the journal (Markdown + SVG handwriting)
```

- **Web app** — `index.html` + `app.js` (Tasks), `calendar.js`, `journal.js`,
  `concursus.js`. Live at `https://merrickjo.github.io/tasks-pwa/`.
- **Worker** — `worker/worker.js`, the only thing holding credentials (app
  key, Google OAuth). Schema in `worker/schema.sql`.
- **Mac** — `notch-tasks-sync.py` (launchd, every 5 min) reconciles
  `Notch/Tasks` with D1, then runs `mac/notch_journal_mirror.py`.
  Both live in `~/Library/Application Support/Notch/`.
- **APK** — `android/`, a native WebView shell around the live web app.
  Web deploys reach it on next launch; rebuild only when the shell changes.

## Deploy

Web app: push to `main`; GitHub Pages serves it. Bump `CACHE_NAME` in `sw.js`
whenever a shell file changes, or installed copies keep the old one.

Worker, from `worker/`:
```bash
wrangler d1 execute tasks-db --remote --file=schema.sql
```
```bash
wrangler deploy
```
(`schema.sql` is all `CREATE … IF NOT EXISTS`, so re-running it is safe.)

## Journal (4.6 · Worker v11)

JOURNAL tab: Month / Week / Day spreads, each with a Type face (template
sections) and an Ink face (3:4 paper, stylus). Pages sync through D1 with a
revision number; two devices editing the same page merge (text per section,
ink by stroke). Offline edits stay on the device and upload on reconnect.
`• ` lines can be sent to Notch as tasks; they become `> ` (migrated).
CONCURSUS history is pushed to D1 by every device, so the week/month rows
match everywhere and history is no longer limited to 35 days on one phone.

Ink input: pen and mouse draw; a finger scrolls unless **Finger draws** is on
(use that if a stylus registers as a finger).

## Android APK

```bash
ANDROID_HOME=… KEYSTORE=…/notch.jks KEYPASS_FILE=…/notch.pass android/build.sh 2 "1.1"
```
Needs only the Android SDK (platform 35, build-tools 35) and a JDK. Bump the
version code every build. **Always sign with the same key** (kept on the Mac in
`~/Library/Application Support/Notch/android/`, never in git) — a different
key means Android refuses to install the update over the old app.

**Fast ink on Bigme (1.1):** on a Bigme device the APK hands the stylus to the
firmware's handwriting service (`android/src/.../BigmeInk.java`), the same
path Bigme's own notes app uses, so ink appears as the pen moves instead of
waiting for an e-ink page refresh. The ink toolbar says **Fast ink** when it's
on. If the service is missing or doesn't answer, the journal falls back to its
web-canvas ink by itself ("Standard ink · fast ink off").

First launch needs internet (the app saves itself for offline after that),
and asks for the Worker URL + app key once, like any new browser.

## Google Calendar (4.4 · Worker v10)

The CALENDAR tab shows Outlook (the Mac mirror, next 7 days) plus your own
Google calendar (primary), and adds events to Google. The Worker holds the
Google refresh token in D1 `meta`; the PWA never sees a Google credential.

One-time setup at console.cloud.google.com:
1. Create a project ("Notch").
2. APIs & Services → Library → **Google Calendar API** → Enable.
3. Google Auth Platform → Branding: app name Notch, your email. Audience:
   External, then **Publish app** (In production). Left in Testing, Google
   expires the refresh token every 7 days.
4. Data access → add scope `https://www.googleapis.com/auth/calendar.events`.
5. Clients → Create client → Web application. Authorized redirect URI:
   `https://tasks-proxy.merrickjo.workers.dev/oauth/google/callback`
6. From `worker/`, paste the client ID and secret when prompted:
```bash
wrangler secret put GOOGLE_CLIENT_ID
```
```bash
wrangler secret put GOOGLE_CLIENT_SECRET
```
Then CALENDAR tab → **Connect**. Google shows an "unverified app" screen
once (Advanced → Go to Notch); that's expected for a personal app.
