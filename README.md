# TikTok Viral Watch

Runs once daily at 7:00 AM Mountain Time, polling a curated list of NYC
hashtags on TikTok, and posts to Slack every video that qualifies via
either: **500k+ views AND 50k+ likes**, OR **100k+ likes alone**. A video
with modest likes only counts if it's also paired with big view count; a
video with genuinely huge likes always counts, regardless of views.

## How it works

- `config/hashtags.json` — the 15 hashtags being watched, picked for being
  genuinely NYC-specific (not diluted by unrelated global usage) and high
  activity/viral potential.
- `scripts/check-viral.js` — for each hashtag, calls an
  [Apify](https://apify.com) TikTok scraper actor
  (`clockworks/tiktok-scraper`, $3.70/1,000 results) for the top
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
- `.github/workflows/watch.yml` — GitHub Actions job. Cron fires 6 times
  spread across the morning (13:07, 13:37, 14:07, 14:37, 15:07, 16:07 UTC),
  covering both Mountain Time DST offsets with off-the-hour minutes and
  redundant triggers. This is deliberate overkill: GitHub's `schedule:`
  trigger is best-effort and was observed firing 1.5-3+ hours late every
  day for a week, and outright not firing at all on one day (2026-07-09) -
  a single daily trigger is a single point of failure. `check-viral.js`
  only does real work once per Mountain-time calendar day, no earlier than
  7am - whichever trigger fires first after that does the work (~$0.555),
  every other trigger that day sees it already ran and no-ops (~15s, $0).
  Manual `workflow_dispatch` runs always execute regardless of the clock,
  for testing.

This is **polling, not push** — TikTok has no public API for real-time
hashtag-wide view/like alerts, so with a once-daily schedule, "alert" here
means "found on the next 7am check," not instant.

## Cost

15 hashtags × 10 results/hashtag (the actor's real floor) × $0.0037/result
= **$0.555 per run**, once daily = **~$16.65/month**. Still comfortably
under a $1/day ceiling, just higher than the ~$0.045/run we'd hoped for
with `apidojo/tiktok-scraper` before discovering (2026-07-08, after a week
of silent failures) that actor's developer blocks API access entirely on
Apify's free plan - it only works from the Console UI. `clockworks/tiktok-scraper`
costs more per result but is confirmed to actually work via API, which is
all that matters for an unattended script. A single Apify free-tier account
only covers ~$5/month at this rate (about 9 days), so `APIFY_TOKENS`
supports multiple comma-separated tokens with automatic fallover once one
runs low. `APIFY_TOKEN` (the original token) is currently out of credits
and excluded from the workflow - only `APIFY_TOKEN_2` is in use. Add it
back (or a fresh token) once it has balance again by editing the
`APIFY_TOKENS:` line in `.github/workflows/watch.yml`.

Alert volume (how many videos get posted to Slack) doesn't affect this cost
at all - the Apify fetch is a fixed cost regardless of how many candidates
qualify or get alerted on, and Slack's Incoming Webhooks are free per
message. That's why alerts are uncapped by default.

## One-time setup

1. **Apify account + API token(s)**
   - Sign up at [apify.com](https://apify.com).
   - This uses the [TikTok Scraper actor by Clockworks](https://apify.com/clockworks/tiktok-scraper)
     (actor ID `clockworks~tiktok-scraper`) - confirm this is still correct
     and check the actor's current input/output schema on its Store page
     before relying on it long-term, since third-party actors change their
     fields over time (last verified 2026-07-08). Before switching to any
     other actor to save cost, confirm on its Store page (or with a manual
     Console test) that it actually permits API access on your plan -
     `apidojo/tiktok-scraper` looked cheaper but silently blocked all API
     calls on the free plan for a full week before we caught it.
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

- `VIEW_THRESHOLD` (default 500000) + `COMBO_LIKE_THRESHOLD` (default 50000)
  — together form the "views AND likes" branch: both must be met.
- `LIKE_THRESHOLD` (default 100000) — the "likes alone" branch: qualifies
  regardless of views.
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
