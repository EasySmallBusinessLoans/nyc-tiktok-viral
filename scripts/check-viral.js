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

const VIEW_THRESHOLD = Number(process.env.VIEW_THRESHOLD || 500000);
const LIKE_THRESHOLD = Number(process.env.LIKE_THRESHOLD || 100000);
const RESULTS_PER_HASHTAG = Number(process.env.RESULTS_PER_HASHTAG || 3);
const SEEN_TTL_DAYS = 30;

if (!APIFY_TOKENS.length) {
  throw new Error("Missing APIFY_TOKENS env var (comma-separated list of one or more Apify tokens)");
}
if (!SLACK_WEBHOOK_URL) throw new Error("Missing SLACK_WEBHOOK_URL env var");

const hashtagsPath = path.join(ROOT, "config/hashtags.json");
const statePath = path.join(ROOT, "state/seen.json");

const hashtags = JSON.parse(readFileSync(hashtagsPath, "utf8"));
const seen = JSON.parse(readFileSync(statePath, "utf8"));

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
  const author = video.author?.uniqueId ?? video.authorMeta?.name ?? "unknown";
  const videoUrl = video.webVideoUrl ?? video.url ?? "";
  const caption = video.text ? video.text.slice(0, 200) : null;

  const text = [
    `*Viral NYC video detected* (${reason}) — #${hashtag}`,
    videoUrl,
    `by @${author} — ${views.toLocaleString()} views, ${likes.toLocaleString()} likes`,
    caption ? `> ${caption}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  pruneSeen();

  let fetched = 0;
  let alerted = 0;

  for (const hashtag of hashtags) {
    const items = await fetchHashtagVideos(hashtag);
    fetched += items.length;

    for (const video of items) {
      const id = video.id ?? video.webVideoUrl ?? video.url;
      if (!id || seen[id]) continue;

      const views = video.views ?? video.playCount ?? 0;
      const likes = video.likes ?? video.diggCount ?? 0;

      const hitViews = views >= VIEW_THRESHOLD;
      const hitLikes = likes >= LIKE_THRESHOLD;

      if (hitViews || hitLikes) {
        const reason = hitViews && hitLikes
          ? "500k+ views & 100k+ likes"
          : hitViews
          ? "500k+ views"
          : "100k+ likes";

        await notifySlack(video, hashtag, reason);
        seen[id] = Date.now();
        alerted++;
      }
    }
  }

  writeFileSync(statePath, JSON.stringify(seen, null, 2));
  console.log(`Fetched ${fetched} videos across ${hashtags.length} hashtags`);
  console.log(`Alerted on ${alerted} video(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
