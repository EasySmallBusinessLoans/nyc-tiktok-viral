#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const APIFY_TOKENS = (process.env.APIFY_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const ACTOR_ID = process.env.APIFY_ACTOR_ID || "apidojo~tiktok-scraper";

const VIEW_THRESHOLD = Number(process.env.VIEW_THRESHOLD || 250000);
const LIKE_THRESHOLD = Number(process.env.LIKE_THRESHOLD || 50000);
const RESULTS_PER_HASHTAG = Number(process.env.RESULTS_PER_HASHTAG || 10);
const SEEN_TTL_DAYS = 30;
const GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || "";

function formatThreshold(n) {
  return n % 1000 === 0 ? `${n / 1000}k` : n.toLocaleString();
}

function mtHourNow() {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      hour: "numeric",
      hour12: false,
    }).format(new Date())
  );
}

function mtDateStringNow() {
  // en-CA gives YYYY-MM-DD, which sorts/compares as a plain string.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// GitHub Actions cron runs in UTC and shifts between MST/MDT offsets across
// daylight saving, so the workflow fires two cron triggers a day (one per
// possible offset). GitHub also doesn't guarantee scheduled triggers fire
// exactly on time - on lower-traffic repos they can be delayed by hours -
// so this can't just check "is it exactly 7am right now" (that missed
// every single run for two days straight once delay pushed triggers past
// the exact hour). Instead: only run once per Mountain-time calendar day,
// no earlier than 7am, and track the last completed date in state so
// whichever trigger fires first after 7am does the real work and any
// later trigger that day (delayed or not) sees it already ran and skips.
// Manual dispatches always run regardless of time/date.
function shouldRunNow(lastRunDate) {
  if (GITHUB_EVENT_NAME && GITHUB_EVENT_NAME !== "schedule") return true;
  if (mtHourNow() < 7) return false;
  return mtDateStringNow() !== lastRunDate;
}

if (!APIFY_TOKENS.length) {
  throw new Error("Missing APIFY_TOKENS env var (comma-separated list of one or more Apify tokens)");
}
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL env var");

const hashtagsPath = path.join(ROOT, "config/hashtags.json");
const statePath = path.join(ROOT, "state/seen.json");

const hashtags = JSON.parse(readFileSync(hashtagsPath, "utf8"));
const rawState = JSON.parse(readFileSync(statePath, "utf8"));
// Back-compat: older state files were a flat { videoId: timestamp } map
// with no lastRunDate. Treat that shape as { lastRunDate: null, seen: <that> }.
const state = "seen" in rawState
  ? { lastRunDate: rawState.lastRunDate ?? null, seen: rawState.seen }
  : { lastRunDate: null, seen: rawState };
const seen = state.seen;

function pruneSeen() {
  const cutoff = Date.now() - SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(seen)) {
    if (ts < cutoff) delete seen[id];
  }
}

async function callActorWithToken(token, hashtag) {
  // NOTE: verify this input/output shape against apidojo/tiktok-scraper's
  // current docs on the Apify Store before relying on it long-term - actor
  // schemas change over time and this was last confirmed 2026-07-01.
  const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`;
  const input = {
    startUrls: [`https://www.tiktok.com/tag/${hashtag.toLowerCase()}`],
    maxItems: RESULTS_PER_HASHTAG,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

async function fetchHashtagVideos(hashtag) {
  let lastError;
  for (let i = 0; i < APIFY_TOKENS.length; i++) {
    try {
      return await callActorWithToken(APIFY_TOKENS[i], hashtag);
    } catch (err) {
      lastError = err;
      console.warn(`Apify token #${i + 1}/${APIFY_TOKENS.length} failed for #${hashtag}: ${err.message}`);
    }
  }
  throw new Error(`All ${APIFY_TOKENS.length} Apify token(s) failed for #${hashtag}. Last error: ${lastError?.message}`);
}

async function notifySlack(video, hashtag, reason) {
  const views = video.views ?? video.playCount ?? 0;
  const likes = video.likes ?? video.diggCount ?? 0;
  const comments = video.comments ?? video.commentCount ?? 0;
  const shares = video.shares ?? video.shareCount ?? 0;
  const videoUrl = video.webVideoUrl ?? video.url ?? "";
  const caption = video.text ? video.text.slice(0, 200) : "";

  const text = [
    `*Viral NYC video detected* (${reason}) — #${hashtag}`,
    `URL: ${videoUrl}`,
    `Views: ${views.toLocaleString()}`,
    `Likes: ${likes.toLocaleString()}`,
    `Comments: ${comments.toLocaleString()}`,
    `Shares: ${shares.toLocaleString()}`,
    "",
    `Caption: ${caption}`,
  ].join("\n");

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

// Unset (or non-numeric) means uncapped - alert on every qualifying video.
const MAX_ALERTS_PER_RUN = Number(process.env.MAX_ALERTS_PER_RUN || Infinity);

async function main() {
  if (!shouldRunNow(state.lastRunDate)) {
    console.log(
      `Skipping - either before 7am Mountain Time (hour=${mtHourNow()}) or already ran today ` +
      `(lastRunDate=${state.lastRunDate}, today=${mtDateStringNow()}). No Apify calls made.`
    );
    return;
  }

  pruneSeen();

  let fetched = 0;
  const candidatesById = new Map();

  for (const hashtag of hashtags) {
    let items;
    try {
      items = await fetchHashtagVideos(hashtag);
    } catch (err) {
      // One hashtag failing shouldn't blank out the whole day's alerts -
      // skip it and keep going with the rest.
      console.warn(`Skipping #${hashtag} this run - all tokens failed: ${err.message}`);
      continue;
    }
    fetched += items.length;

    // TEMPORARY: dump one raw video object to find the actual field names -
    // views/likes are reading as 0 for everything, so the assumed field
    // names are wrong. Remove this once the real keys are confirmed.
    if (items[0] && !global.__dumpedSample) {
      global.__dumpedSample = true;
      console.log(`RAW SAMPLE from #${hashtag}:`, JSON.stringify(items[0], null, 2));
    }

    // Diagnostic: show what this hashtag actually returned, so a run of
    // "0 qualified" can be told apart from "the fetch itself is returning
    // low-performing/stale content" (e.g. recent posts instead of top posts).
    const maxViews = items.reduce((m, v) => Math.max(m, v.views ?? v.playCount ?? 0), 0);
    const maxLikes = items.reduce((m, v) => Math.max(m, v.likes ?? v.diggCount ?? 0), 0);
    console.log(`#${hashtag}: ${items.length} videos, max views=${maxViews.toLocaleString()}, max likes=${maxLikes.toLocaleString()}`);

    for (const video of items) {
      const id = video.id ?? video.webVideoUrl ?? video.url;
      if (!id || seen[id] || candidatesById.has(id)) continue;

      const views = video.views ?? video.playCount ?? 0;
      const likes = video.likes ?? video.diggCount ?? 0;

      const hitViews = views >= VIEW_THRESHOLD;
      const hitLikes = likes >= LIKE_THRESHOLD;

      if (hitViews || hitLikes) {
        const reason = hitViews && hitLikes
          ? `${formatThreshold(VIEW_THRESHOLD)}+ views & ${formatThreshold(LIKE_THRESHOLD)}+ likes`
          : hitViews
          ? `${formatThreshold(VIEW_THRESHOLD)}+ views`
          : `${formatThreshold(LIKE_THRESHOLD)}+ likes`;

        candidatesById.set(id, { video, hashtag, reason, views, id });
      }
    }
  }

  // Rank by views descending and only alert on the top N (uncapped by
  // default - see MAX_ALERTS_PER_RUN above). Videos that qualify but don't
  // make the cut are NOT marked as seen, so they can still surface on a
  // future run if they're still trending relative to that run's candidates.
  const candidates = [...candidatesById.values()];
  candidates.sort((a, b) => b.views - a.views);
  const toAlert = candidates.slice(0, MAX_ALERTS_PER_RUN);

  let alerted = 0;
  for (const { video, hashtag, reason, id } of toAlert) {
    try {
      await notifySlack(video, hashtag, reason);
      seen[id] = Date.now();
      alerted++;
    } catch (err) {
      // Don't let one failed Slack post abort the loop or lose the seen-state
      // of everything already sent - just skip this one and retry it next run.
      console.warn(`Failed to alert on ${id}, will retry next run: ${err.message}`);
    }
  }

  state.lastRunDate = mtDateStringNow();
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`Fetched ${fetched} videos across ${hashtags.length} hashtags`);
  console.log(`${candidates.length} qualified, alerted on ${alerted}/${toAlert.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
