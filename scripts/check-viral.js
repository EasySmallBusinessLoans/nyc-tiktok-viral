#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const ACTOR_ID = process.env.APIFY_ACTOR_ID || "clockworks~tiktok-scraper";

const VIEW_THRESHOLD = Number(process.env.VIEW_THRESHOLD || 500000);
const LIKE_THRESHOLD = Number(process.env.LIKE_THRESHOLD || 100000);
const RESULTS_PER_HASHTAG = Number(process.env.RESULTS_PER_HASHTAG || 25);
const SEEN_TTL_DAYS = 30;

if (!APIFY_TOKEN) throw new Error("Missing APIFY_TOKEN env var");
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

async function fetchCandidateVideos() {
  // NOTE: verify this input/output shape against the actor's current docs
  // on the Apify Store before first run - actor schemas change over time.
  const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const input = {
    hashtags: hashtags.map((h) => h.replace(/^#/, "")),
    resultsPerPage: RESULTS_PER_HASHTAG,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    throw new Error(`Apify actor run failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function notifySlack(video, reason) {
  const views = video.playCount ?? 0;
  const likes = video.diggCount ?? 0;
  const author = video.authorMeta?.name ?? video.author?.uniqueId ?? "unknown";
  const caption = video.text ? video.text.slice(0, 200) : null;

  const text = [
    `*Viral NYC video detected* (${reason})`,
    video.webVideoUrl,
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

  const items = await fetchCandidateVideos();
  console.log(`Fetched ${items.length} videos across ${hashtags.length} hashtags`);

  let alerted = 0;
  for (const video of items) {
    const id = video.id ?? video.webVideoUrl;
    if (!id || seen[id]) continue;

    const views = video.playCount ?? 0;
    const likes = video.diggCount ?? 0;

    const hitViews = views >= VIEW_THRESHOLD;
    const hitLikes = likes >= LIKE_THRESHOLD;

    if (hitViews || hitLikes) {
      const reason = hitViews && hitLikes
        ? "500k+ views & 100k+ likes"
        : hitViews
        ? "500k+ views"
        : "100k+ likes";

      await notifySlack(video, reason);
      seen[id] = Date.now();
      alerted++;
    }
  }

  writeFileSync(statePath, JSON.stringify(seen, null, 2));
  console.log(`Alerted on ${alerted} video(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
