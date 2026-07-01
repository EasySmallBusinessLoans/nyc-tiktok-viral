# TikTok Viral Watch

Polls a curated list of NYC hashtags on TikTok on a schedule and posts to
Slack the moment a video crosses **500k+ views** or **100k+ likes**.

## How it works

- `config/hashtags.json` — the 15 hashtags being watched, picked for being
  genuinely NYC-specific (not diluted by unrelated global usage) and high
  activity/viral potential.
- `scripts/check-viral.js` — for each hashtag, calls an
  [Apify](https://apify.com) TikTok scraper actor
  (`apidojo/tiktok-scraper`, $0.30/1,000 results) for the top
  `RESULTS_PER_HASHTAG` videos on that hashtag's page, checks each against
  the thresholds, and posts a Slack message for any that qualify. Tries each
  token in `APIFY_TOKENS` in order and falls through to the next one if a
  call fails (e.g. a token ran out of credits).
- `state/seen.json` — video IDs already alerted on, so the same video isn't
  posted twice. Pruned after 30 days. Committed back to the repo by the
  workflow after every run.
- `.github/workflows/watch.yml` — GitHub Actions job that runs the script on
  a schedule. **Cron is currently disabled** (`workflow_dispatch` only)
  pending a final call on check frequency - see conversation history for the
  cost-vs-frequency tradeoff table.

This is **polling, not push** — TikTok has no public API for real-time
hashtag-wide view/like alerts, so "instant" here means "within one polling
interval," not a live stream.

## Cost

At 15 hashtags × 3 results/hashtag × $0.0003/result = **$0.0135 per run**.
Daily cost scales with how often it runs - see the frequency table worked
out in conversation (roughly 13¢/day hourly up to 76¢/day every 15 minutes).
A single Apify free-tier account only covers ~$5/month, so `APIFY_TOKENS`
supports multiple comma-separated tokens with automatic fallover once one
runs low.

## One-time setup

1. **Apify account + API token(s)**
   - Sign up at [apify.com](https://apify.com).
   - This uses the [TikTok Scraper actor by Api Dojo](https://apify.com/apidojo/tiktok-scraper)
     (actor ID `apidojo~tiktok-scraper`) - confirm this is still correct and
     check the actor's current input/output schema on its Store page before
     relying on it long-term, since third-party actors change their fields
     over time (last verified 2026-07-01).
   - Get your API token(s) from Apify Console → Settings → Integrations. If
     using more than one account/token for fallover, gather all of them.

2. **Slack Incoming Webhook**
   - In Slack, create an Incoming Webhook for the channel you want alerts in
     (Slack App directory → "Incoming Webhooks", or via a Slack app you
     manage). Copy the webhook URL.

3. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `APIFY_TOKEN` — your first Apify token
   - `APIFY_TOKEN_2` (optional) — a second token for fallover once the first
     runs low on credits. The workflow joins these into the comma-separated
     list the script expects; add more (`APIFY_TOKEN_3`, ...) by extending
     the `APIFY_TOKENS:` line in `.github/workflows/watch.yml`.
   - `SLACK_WEBHOOK_URL`

4. **Enable the schedule** once check frequency is decided: uncomment the
   `schedule:` block in `.github/workflows/watch.yml`.

## Tuning

All in `.github/workflows/watch.yml`:

- `VIEW_THRESHOLD` / `LIKE_THRESHOLD` — alert thresholds (default 500000 /
  100000).
- `RESULTS_PER_HASHTAG` — how many top videos to pull per hashtag per run.
  Higher = less chance of missing a video that isn't in the very top few
  right now, but more Apify cost.
- Cron interval — the other cost lever, multiplies directly with
  `RESULTS_PER_HASHTAG` and hashtag count.

## Local test run

```bash
export APIFY_TOKENS=token1,token2
export SLACK_WEBHOOK_URL=...
npm run check
```
