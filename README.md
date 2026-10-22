# 5HP Alliance Stats

A free website that tracks the FiveHitPoint [5HP] roster on KG 1737: power, daily PvP, season leaderboard, last season's final standings, and a history chart for every player.

It runs entirely on GitHub for free. Every 15 minutes GitHub reads the alliance from [KG Companion](https://kg.dbapp.ru/alliance/65e1dce66cf56451), works out who did how much damage, saves it, and republishes the site. You never need to leave a computer running.

---

## One-time setup (about 10 minutes)

### 1. Make a GitHub account
Go to <https://github.com/signup> and create a free account. Your username becomes part of the site address, so pick something you're happy with (for example `fivehitpoint`).

### 2. Create the repository
1. Click the **+** at the top right of GitHub, then **New repository**.
2. Repository name: `5hp-stats` (any name works; it becomes the end of the web address).
3. Choose **Public**. (Free accounts need a public repository for a free website. Everything in it is already public game data.)
4. Tick **Add a README file**, then click **Create repository**.

### 3. Upload the files
1. Unzip `kg-alliance-stats.zip` on your computer.
2. In your new repository click **Add file → Upload files**.
3. Open the unzipped folder, select **everything inside it**, and drag it onto the page. You should see `index.html`, `config.json`, `README.md`, the `scripts` folder and the `.github` folder. (A `data` folder appears by itself after the first run.)
4. Click **Commit changes**.

**Check the `.github` folder made it.** Folders that start with a dot are hidden on Mac and sometimes skipped. In the repository you should now see a `.github` folder. If it is missing:
- Click **Add file → Create new file**.
- In the name box type exactly `.github/workflows/update.yml` (typing the `/` creates the folders).
- Open `update.yml` from the unzipped folder in Notepad or TextEdit, copy all of it, paste it into the big box, and click **Commit changes**.

### 4. Turn on the website
1. In the repository, click **Settings** (top bar), then **Pages** (left side).
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

### 5. Run it the first time
1. Click the **Actions** tab. If GitHub asks, click the green button to enable workflows.
2. Click **Update alliance data** on the left, then **Run workflow → Run workflow**.
3. Wait about a minute until it shows a green tick.

Your site is now live at:

```
https://YOUR-USERNAME.github.io/5hp-stats/
```

(The exact link also appears under **Settings → Pages**, and next to the green tick in Actions.)

From here it updates itself every 15 minutes. Nothing else to do.

---

## What to expect in the first days

- **Roster, power, last online:** filled immediately.
- **Daily PvP:** counts from the first run. The first "full" day is the one after the next daily reset.
- **Season leaderboard:** counts from the day you started tracking, and says so on the page. From next season on it covers the whole season.
- **Previous season:** fills in automatically when the new season starts (00:00 UTC on its first day).
- **Player history charts:** one point per day, so they become useful after a few days.

The activity score is the one the game and KG Companion use: **PvP damage ÷ max power**. Dividing by a player's highest power lets big and small accounts be compared fairly.

---

## Settings you can change

Open `config.json` in the repository, click the pencil icon, edit, and **Commit changes**.

| Setting | What it does |
|---|---|
| `allianceId` | The ID from the end of the KG Companion alliance link. Change it to track a different alliance. |
| `resetHourUTC` | The hour (in UTC) of the in-game daily reset, so "today" starts at the right time. Default `0` (midnight UTC). |
| `seasonAnchorDate` | Any date a season started on (seasons start on the same day for every server). Default `"2026-09-28"`. The site counts forward from it to know the current season, week and day. |
| `seasonLengthDays` | Days per season, including the rest week. Default `28`. |
| `historyDays` | How many days of history to keep for the charts. Default `180`. |

The site's title, alliance tag and name come from the live data, so you don't have to edit the page itself.

---

## Optional: your own web address

To use an address like `5hpstats.com`, buy a domain from any registrar (Cloudflare, Namecheap, Porkbun; around $10–15 a year), then enter it under **Settings → Pages → Custom domain** and follow GitHub's instructions for the DNS records.

## Adding another alliance later

Make a second repository the same way and change `allianceId` in its `config.json`. (If you'd rather have them under one site, like `yoursite.com/other-alliance`, that's a small change to the scripts and can be added later.)

---

## If something looks wrong

- **"Updated 3 h ago" and climbing:** open the **Actions** tab. A red ✗ means a run failed; click it to see why. If KG Companion is down, the script keeps the old data and catches up once it's back.
- **Updates stopped after a long quiet spell:** GitHub pauses scheduled jobs in repositories with no activity for 60 days. The data commits normally count as activity, but if it happens, go to **Actions → Update alliance data** and click **Enable workflow**.
- **A run says "Member count fell … looks like a bad response":** a safety check. If KG Companion briefly returns a half-empty list, the run is skipped so nobody is wrongly marked as having left.

## Files

| File | Purpose |
|---|---|
| `index.html` | The website. |
| `scripts/update.mjs` | Fetches the roster and updates the files in `data/`. |
| `.github/workflows/update.yml` | Runs the script every 15 minutes and publishes the site. |
| `config.json` | Your settings. |
| `data/` | Created automatically. Don't edit by hand. |

Data courtesy of KG Companion (kg.dbapp.ru). The tracker reads one page every 15 minutes, which is lighter than a person browsing the site.
