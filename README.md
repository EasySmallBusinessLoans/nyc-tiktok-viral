# TikTok Viral Watch

Polls a list of NYC hashtags on TikTok on a schedule and posts to Slack the
moment a video crosses **500k+ views** or **100k+ likes**.

## How it works

- `config/hashtags.json` — the hashtag list being watched.
- `scripts/check-viral.js` — calls an [Apify](https://apify.com) TikTok
  scraper actor for fresh results per hashtag, checks each video against the
  thresholds, and posts a Slack message for any that qualify.
- `state/seen.json` — video IDs already alerted on, so the same video isn't
  posted twice. Pruned after 30 days. Committed back to the repo by the
  workflow after every run.
- `.github/workflows/watch.yml` — GitHub Actions cron job that runs the
  script every 10 minutes, 24/7, for free (within GitHub's free Actions
  minutes for public repos, or your plan's included minutes for private).

This is **polling, not push** — TikTok has no public API for real-time
hashtag-wide view/like alerts, so "instant" here means "within one polling
interval," not a live stream. There's no free lunch on the "instant + covers
all of TikTok" combination; a paid data provider polled frequently is the
practical ceiling.

## One-time setup

1. **Apify account + API token**
   - Sign up at [apify.com](https://apify.com).
   - Open the [TikTok Scraper actor by clockworks](https://apify.com/clockworks/tiktok-scraper)
     in the Apify Store and note its actor ID (defaults to
     `clockworks~tiktok-scraper` in the workflow — confirm this is still
     correct, and check the actor's current input/output schema on its Store
     page, since third-party actors change their fields over time).
   - Get your API token from Apify Console → Settings → Integrations.

2. **Slack Incoming Webhook**
   - In Slack, create an Incoming Webhook for the channel you want alerts in
     (Slack App directory → "Incoming Webhooks", or via a Slack app you
     manage). Copy the webhook URL.

3. **Push this repo to GitHub**
   - Create a new GitHub repo and push this folder to it.

4. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `APIFY_TOKEN`
   - `SLACK_WEBHOOK_URL`

5. **Enable Actions** on the repo (first push usually does this
   automatically). The workflow will start running on its cron schedule; you
   can also trigger it manually from the Actions tab (`workflow_dispatch`).

## Tuning

All in `.github/workflows/watch.yml`:

- `VIEW_THRESHOLD` / `LIKE_THRESHOLD` — alert thresholds (default 500000 /
  100000).
- `RESULTS_PER_HASHTAG` — how many recent videos to pull per hashtag per run.
  Higher = better coverage, more Apify compute cost.
- Cron interval — 10 minutes by default. Apify usage scales linearly with
  frequency × hashtag count × results-per-hashtag, so this is the main cost
  lever. With ~90 hashtags this can add up quickly on Apify's paid tiers;
  start with a longer interval or fewer results-per-hashtag and tighten once
  you've seen actual usage/cost.

## Local test run

```bash
export APIFY_TOKEN=...
export SLACK_WEBHOOK_URL=...
npm run check
```
