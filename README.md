# Daily Pulse — personal briefing app

An installable web app (PWA) for your phone: markets + stock watchlist, swipeable news,
daily GK flash cards, deeper reads, a Skills Academy (SQL · Python · Power BI · Tableau · Agile,
beginner → advanced with quizzes and solutions), and a Scorecard tracking your XP, streak,
time spent, reads, swipes and quiz accuracy.

Data refreshes **server-side via GitHub Actions** — your laptop can stay off.

---

## Deploy (one-time, ~10 minutes)

### 1. Create the repo
1. Go to https://github.com/new
2. Name: `daily-pulse` · visibility: **Public** (required for free Pages + unlimited Actions)
3. Create repository.

### 2. Upload this folder
Easiest (no git needed):
1. On the empty repo page click **"uploading an existing file"**.
2. Drag **everything inside** `daily-pulse-app` (not the folder itself):
   `index.html`, `manifest.webmanifest`, `sw.js`, `README.md`, and the `data/`, `scripts/`, `icons/` folders.
3. Commit.
4. **Important:** the browser upload sometimes skips dot-folders. Check that
   `.github/workflows/refresh.yml` exists in the repo. If not: **Add file → Create new file**,
   type `.github/workflows/refresh.yml` as the name, paste the file's contents, commit.

### 3. Enable Pages
1. Repo → **Settings → Pages**
2. Source: **Deploy from a branch** · Branch: `main` · Folder: `/ (root)` → Save.
3. After ~1 minute your app is live at `https://<your-username>.github.io/daily-pulse/`

### 4. Allow the Action to commit
1. Repo → **Settings → Actions → General → Workflow permissions**
2. Select **Read and write permissions** → Save.

### 5. First refresh (proves it works)
1. Repo → **Actions** tab → enable workflows if prompted
2. Open **"Refresh data"** → **Run workflow** → Run.
3. Green check ≈ 1 min later; `data/data.json` now has live markets + today's news.
   Pages redeploys automatically (~1 more minute).

### 6. Install on your phone
- **Android/Chrome:** open the URL → ⋮ menu → **Add to Home screen** → Install.
- **iPhone/Safari:** open the URL → Share → **Add to Home Screen**.

It opens full-screen like a native app and works offline with the last synced data.

---

## How auto-refresh works (no laptop needed)

`.github/workflows/refresh.yml` runs `scripts/refresh.mjs` **on GitHub's servers**:

| IST time | What |
|---|---|
| 08:00 daily | Morning refresh (news, markets, new GK/Learn rotation) |
| every 30 min, 09:30–15:30 weekdays | Market-hours pulse (trending stocks, indices, headlines) |
| 16:15 weekdays | Post market close wrap |

The app itself also re-fetches every 5 minutes while open, and on the ⟳ button.
Why not every 5 minutes server-side? GitHub schedules drift 5–15 min under load and each run
commits to the repo — 30-minute market-hours cadence is the practical sweet spot on the free tier.

## Phone notifications for new top news (free, 2 minutes)

1. Install the **ntfy** app (Play Store / App Store).
2. In ntfy: Subscribe to topic → `arpit-daily-pulse-x7k93q`
   (change this string in `.github/workflows/refresh.yml` to your own secret value first — anyone
   who knows the topic name can read it, so make it unguessable).
3. Done. Whenever a refresh finds a *new* top headline, your phone gets a push — laptop off, app closed.

Slack/Gmail pushes are deliberately **not** replicated here: your corporate Slack and Gmail apps
already notify you natively, and a personal app can't access them without Cars24 admin approval.

The script pulls Yahoo Finance quotes and Google News RSS (India edition), rotates
10 GK + 8 Learn cards from `data/banks.json`, and commits `data/data.json`.
The app fetches that file on open and via the ⟳ button.

Note: GitHub schedules can drift 5–15 minutes under load — normal, free-tier behaviour.

## Opening the file directly (before deploying)

Double-clicking `index.html` opens it as `file:///…` — browsers block data fetching there, so you
get the built-in offline copy (seed markets/news, limited Skills). That's expected. The full live
app needs hosting (steps above). Don't judge the app from the file:// preview.

## Customising

| Change | Where |
|---|---|
| Fallback stock watchlist | `WATCHLIST` array in `scripts/refresh.mjs` (live list auto-switches to India's trending stocks) |
| Notification topic | `NTFY_TOPIC` in `.github/workflows/refresh.yml` |
| News buckets/order | `BUCKETS` array in `scripts/refresh.mjs` |
| Refresh times | cron lines in `.github/workflows/refresh.yml` (UTC = IST − 5:30) |
| GK / Learn card banks | `data/banks.json` (rotation is automatic) |
| Skills curriculum | `data/skills-bank.json` — add lessons/quizzes any time |
| Colours/theme | CSS variables at the top of `index.html` |

Edit any file directly on github.com (pencil icon) — commit, and Pages redeploys.

## Privacy

All progress (XP, streak, swipes, quiz results) lives in your phone's localStorage.
Nothing is sent anywhere; the repo only serves content. Clearing browser data resets progress
(the Scorecard's Reset button does it deliberately).

## Troubleshooting

- **App shows "seed" label forever** → the Action hasn't run: check steps 4–5.
- **Action fails on push** → Workflow permissions not set to read/write (step 4).
- **Markets show "awaiting refresh"** → Yahoo occasionally rejects a symbol; it self-heals next run.
- **Old version after an update** → the service worker caches hard; close the app fully and reopen, or bump `VER` in `sw.js` when you edit files.
