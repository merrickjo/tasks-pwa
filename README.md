# Tasks — your own Todoist, backed by Notion

No subscriptions. Three pieces:
1. **This PWA** (index.html + friends) — the UI, installs to your phone
2. **A Cloudflare Worker** — the only thing holding your Notion token, free tier
3. **Your existing Notion Tasks database** — unchanged, still the source of truth

```
Phone → PWA (GitHub Pages) → Cloudflare Worker → Notion API
```

Total setup time: ~15 minutes, all one-time.

## 1. Create a Notion integration

1. Go to `notion.so/my-integrations` → **New integration**
2. Name it "Tasks PWA", associate it with your workspace, submit
3. Copy the **Internal Integration Token** — this is `NOTION_TOKEN`, treat it like a password
4. Open your **✅ Tasks** database in Notion → `···` menu → **Connections** → add the integration
   (without this step the token can't see the database, even though it's valid)

## 2. Deploy the Worker

First, unzip and go into the project folder if you haven't already:
```bash
cd ~/Downloads
unzip tasks-pwa.zip -d tasks-pwa
cd tasks-pwa/worker
```

Then run these one line at a time. (If you're on zsh — the macOS default —
don't add trailing `#` comments to commands: zsh only treats `#` as a
comment in scripts, not when typed directly at the prompt, so anything
after it gets passed as a literal argument.)
```bash
npm install -g wrangler
```
```bash
wrangler login
```
```bash
wrangler deploy
```

Then set your two secrets — run each on its own, it'll prompt you to paste
the value after:
```bash
wrangler secret put NOTION_TOKEN
```
```bash
wrangler secret put APP_KEY
```
`APP_KEY` is any password you invent — the PWA and Worker just need to agree on it.

`wrangler deploy` prints your Worker URL, something like:
`https://tasks-proxy.<your-subdomain>.workers.dev`
— save it, you'll paste it into the PWA in step 4.

The `DATA_SOURCE_ID` in `worker.js` already points at your real ✅ Tasks database.
Only change it if you rebuild the database from scratch later.

## 3. Deploy the PWA to GitHub Pages

```bash
# from the tasks-pwa/ folder (not worker/)
git init
git add index.html manifest.json sw.js app.js styles.css icons
git commit -m "tasks pwa"
git remote add origin https://github.com/<you>/tasks-pwa.git
git push -u origin main
```
Then in the repo: **Settings → Pages → Deploy from branch → main → / (root)**.
Your app will be live at `https://<you>.github.io/tasks-pwa/`.

Once you know that URL, lock the Worker down to it — edit `worker/wrangler.toml`,
uncomment the `[vars]` block, set `ALLOWED_ORIGIN` to your Pages URL, then
`wrangler deploy` again. Until you do this, anyone with your Worker URL and
app key could call it — low risk since both are effectively private, but
worth closing.

## 4. Install it on your phone

1. Open your GitHub Pages URL in Chrome (Android) or Safari (iPhone)
2. It'll show a **Connect** screen — paste the Worker URL from step 2 and the
   `APP_KEY` you invented in step 2
3. Add to home screen: Safari → share icon → **Add to Home Screen**;
   Chrome → menu → **Install app**
4. Opens full-screen from your home screen from now on, no browser chrome

## What v1 does and doesn't do

**Does:** shows open tasks grouped Overdue / Today / Upcoming, checkbox to
mark done, quick-add with priority, offline viewing of the last synced list.

**Doesn't yet:** offline *writes* (adding/checking off while offline just
fails with a message — queueing those for later sync is the natural v2),
label multi-select on create, a This Week view, recurring tasks. All
straightforward additions once this is running — say the word.

## Property mapping (matches your live Tasks database)

| PWA field | Notion property |
|---|---|
| title | Task Name |
| status | Status |
| priority | Priority |
| due | Due |
| label (read-only in v1) | Labels (first value shown) |
| notes | Notes |
| — | Completed at (auto-set when you check a task done) |
