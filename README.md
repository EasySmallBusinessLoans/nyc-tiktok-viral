# TikTok Viral Watch

Runs once daily at 7:00 AM Mountain Time, polling a curated list of NYC
hashtags on TikTok, and posts to Slack every video that crosses **250k+
views** or **50k+ likes**.

## How it works

- `config/hashtags.json` — the 15 hashtags being watched, picked for being
  genuinely NYC-specific (not diluted by unrelated global usage) and high
  activity/viral potential.
- `scripts/check-viral.js` — for each hashtag, calls an
  [Apify](https://apify.com) TikTok scraper actor
  (`apidojo/tiktok-scraper`, $0.30/1,000 results) for the top
  `RESULTS_PER_HASHTAG` videos on that hashtag's page (this actor has a
  floor of ~10 regardless of a lower setting - confirmed by testing, not
  just the docs), checks each against the thresholds, dedupes videos that
  show up under more than one hashtag, ranks qualifying videos by view
  count, and posts each to Slack (no cap by default - see `MAX_ALERTS_PER_RUN`
  below). Tries each token in `APIFY_TOKENS` in order and falls through to
  the next one if a call fails (e.g. a token ran out of credits). A single
  hashtag's fetch failing, or a single Slack post failing, doesn't abort the
  rest of the run - it's logged and skipped, and only successfully-sent
  videos get marked as seen.
- `state/seen.json` — video IDs already alerted on, so the same video isn't
  posted twice. Pruned after 30 days. Committed back to the repo by the
  workflow after every run.
- `.github/workflows/watch.yml` — GitHub Actions job. Cron fires twice daily
  in UTC (`13:00` and `14:00`) to cover both Mountain Time offsets across
  daylight saving (MDT is UTC-6, MST is UTC-7) - the script itself checks
  the real current Mountain time and only does actual work on whichever
  trigger is genuinely 7am there. The other is a near-free no-op. Manual
  `workflow_dispatch` runs always execute regardless of the clock, for
  testing.

This is **polling, not push** — TikTok has no public API for real-time
hashtag-wide view/like alerts, so with a once-daily schedule, "alert" here
means "found on the next 7am check," not instant.

## Cost

15 hashtags × 10 results/hashtag (the actor's real floor) × $0.0003/result
= **$0.045 per run**, once daily = **~$1.35/month**. A single Apify
free-tier account only covers ~$5/month, so `APIFY_TOKENS` supports
multiple comma-separated tokens with automatic fallover once one runs low.
`APIFY_TOKEN` (the original token) is currently out of credits and excluded
from the workflow - only `APIFY_TOKEN_2` is in use. Add it back (or a fresh
token) once it has balance again by editing the `APIFY_TOKENS:` line in
`.github/workflows/watch.yml`.

Alert volume (how many videos get posted to Slack) doesn't affect this cost
at all - the Apify fetch is a fixed cost regardless of how many candidates
qualify or get alerted on, and Slack's Incoming Webhooks are free per
message. That's why alerts are uncapped by default.

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

The schedule is already enabled - no further setup needed once secrets are
in place.

## Tuning

All in `.github/workflows/watch.yml`:

- `VIEW_THRESHOLD` / `LIKE_THRESHOLD` — alert thresholds (default 250000 /
  50000).
- `RESULTS_PER_HASHTAG` — how many top videos to pull per hashtag per run.
  This actor has a real floor of ~10 regardless of a lower setting - verify
  with a test run before assuming a lower number actually reduces cost.
- `MAX_ALERTS_PER_RUN` — currently unset (uncapped). Set to a number to cap
  how many videos get posted to Slack per run, ranked by view count
  descending. Doesn't affect cost either way.
- Cron schedule — currently once daily at 7am MT. Changing frequency
  multiplies cost directly with `RESULTS_PER_HASHTAG` and hashtag count.

## Local test run

```bash
export APIFY_TOKENS=token1,token2
export SLACK_WEBHOOK_URL=...
npm run check
```
