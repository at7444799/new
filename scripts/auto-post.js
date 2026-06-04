import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const GRAPH_VERSION = "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ROOT = process.cwd();
const MEDIA_DIR = path.join(ROOT, "media");
const INCOMING_DIR = path.join(MEDIA_DIR, "incoming");
const MUSIC_DIR = path.join(MEDIA_DIR, "music");
const DATA_DIR = path.join(ROOT, "data");
const GENERATED_DIR = path.join(DATA_DIR, "generated");

const HISTORY_FILE = path.join(DATA_DIR, "posted_history.json");
const PENDING_FILE = path.join(DATA_DIR, "pending_post.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav"];

const REEL_WIDTH = 1080;
const REEL_HEIGHT = 1920;
const PHOTO_WIDTH = 1080;
const PHOTO_HEIGHT = 1350;
const FPS = 30;

function log(msg) {
  console.log(`[BOT] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureFolders() {
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GENERATED_DIR, { recursive: true });

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ posted: [], used_music: [] }, null, 2));
  }

  if (!fs.existsSync(PENDING_FILE)) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify({}, null, 2));
  }
}

function getEnv(name, required = true, fallback = "") {
  const value = process.env[name] || fallback;

  if (required && !value) {
    throw new Error(`Missing environment variable / secret: ${name}`);
  }

  return value;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadHistory() {
  return readJson(HISTORY_FILE, { posted: [], used_music: [] });
}

function saveHistory(history) {
  writeJson(HISTORY_FILE, history);
}

function loadPending() {
  return readJson(PENDING_FILE, {});
}

function savePending(data) {
  writeJson(PENDING_FILE, data);
}

function clearPending() {
  writeJson(PENDING_FILE, {});
}

function relativePosix(file) {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

function rawGithubUrl(file) {
  const repo = getEnv("GITHUB_REPOSITORY");
  const branch = getEnv("GITHUB_REF_NAME", false, "main");
  const relative = relativePosix(file);
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`;
}

function findFiles(folder, extensions) {
  if (!fs.existsSync(folder)) return [];

  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => path.join(folder, item.name))
    .filter((file) => extensions.includes(path.extname(file).toLowerCase()))
    .filter((file) => !path.basename(file).startsWith("."))
    .sort();
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function indiaTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);

  return {
    hour,
    minute,
    total: hour * 60 + minute
  };
}

function detectMode() {
  const manualMode = (process.env.MANUAL_MODE || "").toLowerCase().trim();

  if (manualMode === "photo" || manualMode === "reel") {
    return manualMode;
  }

  const { total } = indiaTime();

  const photoTimes = [7 * 60, 19 * 60 + 30];

  for (const t of photoTimes) {
    if (Math.abs(total - t) <= 90) return "photo";
  }

  return "reel";
}

function shouldAllowPost(mode) {
  const force = (process.env.FORCE_POST || "false").toLowerCase() === "true";

  if (force) {
    log("FORCE_POST=true, time guard skipped.");
    return true;
  }

  const { hour, minute, total } = indiaTime();

  log(`India time: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  log(`Mode: ${mode}`);

  const photoTimes = [7 * 60, 19 * 60 + 30];
  const reelTimes = [10 * 60 + 30, 13 * 60 + 30, 17 * 60];

  const targetTimes = mode === "photo" ? photoTimes : reelTimes;

  return targetTimes.some((t) => Math.abs(total - t) <= 90);
}

async function imageQuality(file) {
  const meta = await sharp(file).metadata();

  let score = 100;

  if ((meta.width || 0) < 720 || (meta.height || 0) < 720) score -= 35;

  const stats = await sharp(file)
    .resize(300, 300, { fit: "inside" })
    .greyscale()
    .stats();

  const mean = stats.channels[0].mean;
  const stdev = stats.channels[0].stdev;

  if (mean < 35) score -= 30;
  if (mean > 235) score -= 20;
  if (stdev < 14) score -= 25;

  return score;
}

async function getGoodImages() {
  const images = findFiles(INCOMING_DIR, IMAGE_EXTENSIONS);

  if (images.length < 1) {
    throw new Error("No photos found in media/incoming");
  }

  const checked = [];

  for (const img of images) {
    try {
      const score = await imageQuality(img);
      checked.push({ img, score });
      log(`Image quality: ${path.basename(img)} score=${score}`);
    } catch {
      checked.push({ img, score: 50 });
    }
  }

  const good = checked
    .filter((x) => x.score >= 50)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.img);

  if (good.length < 1) {
    throw new Error("No good quality photos found in media/incoming");
  }

  return good;
}

function pickMusic() {
  const music = findFiles(MUSIC_DIR, MUSIC_EXTENSIONS);

  if (music.length < 1) {
    throw new Error("No song found in media/music");
  }

  const history = loadHistory();
  const last = history.used_music?.[history.used_music.length - 1];

  let candidates = music;

  if (music.length > 1 && last) {
    candidates = music.filter((m) => relativePosix(m) !== last);
  }

  const selected = pickRandom(candidates);
  log(`Selected music: ${selected}`);
  return selected;
}

async function aiPickRelatedImages(images) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    log("NVIDIA_API_KEY missing. Picking first 5 good photos.");
    return images.slice(0, Math.min(5, images.length));
  }

  const limited = images.slice(0, 12);

  const content = [
    {
      type: "text",
      text: `
You are selecting photos for one Instagram Reel.

Task:
Pick 2 to 5 photos that are most related to each other.

They should match by:
- same place
- same outfit
- same time
- same activity
- same vibe

Return only valid JSON:
{
  "selected_files": ["filename1.jpg", "filename2.jpg"],
  "reason": "short reason"
}

Use exact filenames only.
`
    }
  ];

  for (const img of limited) {
    content.push({
      type: "text",
      text: `Filename: ${path.basename(img)}`
    });

    content.push({
      type: "image_url",
      image_url: {
        url: rawGithubUrl(img)
      }
    });
  }

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct",
        messages: [{ role: "user", content }],
        temperature: 0.1,
        max_tokens: 300
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      log(`AI classification failed: ${JSON.stringify(data)}`);
      return images.slice(0, Math.min(5, images.length));
    }

    const raw = data.choices[0].message.content.trim();
    log(`AI selected related photos: ${raw}`);

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return images.slice(0, Math.min(5, images.length));

    const parsed = JSON.parse(match[0]);
    const selectedNames = parsed.selected_files || [];

    const selected = limited.filter((img) => selectedNames.includes(path.basename(img)));

    if (selected.length >= 2) {
      return selected.slice(0, 5);
    }

    return images.slice(0, Math.min(5, images.length));
  } catch (error) {
    log(`AI classification error: ${error.message}`);
    return images.slice(0, Math.min(5, images.length));
  }
}

async function graphPost(endpoint, params = {}) {
  const token = getEnv("FB_PAGE_ACCESS_TOKEN");
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    body.append(key, String(value));
  }

  body.append("access_token", token);

  const response = await fetch(`${GRAPH_URL}/${endpoint.replace(/^\/+/, "")}`, {
    method: "POST",
    body
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(`Graph POST error at ${endpoint}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function graphGet(endpoint, params = {}) {
  const token = getEnv("FB_PAGE_ACCESS_TOKEN");
  const url = new URL(`${GRAPH_URL}/${endpoint.replace(/^\/+/, "")}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, String(value));
  }

  url.searchParams.append("access_token", token);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error) {
    throw new Error(`Graph GET error at ${endpoint}: ${JSON.stringify(data)}`);
  }

  return data;
}

function normalizeHashtag(tag) {
  return tag
    .replace(/[^a-zA-Z0-9_#]/g, "")
    .replace(/^#+/, "#")
    .trim();
}

function cleanCaptionOutput(text) {
  return String(text || "")
    .replace(/```/g, "")
    .replace(/^caption:/i, "")
    .trim();
}

function enforceRequiredHashtags(caption) {
  const required = ["#tarasuri", "#tarasuritrend"];

  let clean = cleanCaptionOutput(caption);

  const words = clean.split(/\s+/);
  const existingTags = words.filter((word) => word.startsWith("#")).map(normalizeHashtag);
  const nonTagText = words.filter((word) => !word.startsWith("#")).join(" ").trim();

  const hashtagSet = new Set();

  for (const tag of existingTags) {
    const normalized = normalizeHashtag(tag).toLowerCase();

    if (normalized.length > 1) {
      hashtagSet.add(normalized);
    }
  }

  for (const tag of required) {
    hashtagSet.add(tag);
  }

  const finalTags = Array.from(hashtagSet).slice(0, 14);

  return `${nonTagText}\n\n${finalTags.join(" ")}`.trim();
}

function fallbackCaption(mode) {
  if (mode === "photo") {
    return enforceRequiredHashtags(
      `"Soft moments become memories when the light feels right." ✨\n\n#lifestylecreator #instagood #photooftheday #aestheticvibes #dailyvibes #softgirlstyle #tarasuri #tarasuritrend`
    );
  }

  return enforceRequiredHashtags(
    `"Some days are just little stories stitched together." ✨\n\n#reelsinstagram #trendingreels #reelitfeelit #creatorlife #aestheticreels #lifestylevlog #tarasuri #tarasuritrend`
  );
}

async function generateCaption(mode, images) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    return fallbackCaption(mode);
  }

  const content = [
    {
      type: "text",
      text: `
Create one SEO-friendly Instagram/Facebook caption for Tara Suri.

Post type: ${mode}

Caption format:
Line 1: One short quote-style caption related to the actual photo/reel.
Line 2: Blank line.
Line 3: SEO-friendly hashtags.

Rules:
- Caption must be related to the actual image mood, place, outfit, background, and vibe.
- Caption should feel like a quote, emotional, stylish, natural, and human.
- Use simple English or soft Hinglish.
- Do not make it long.
- No fake brand deal.
- No adult wording.
- No "AI generated".
- Hashtags must be SEO-friendly and discoverable.
- Use trending-style hashtags related to the image: lifestyle, reels, fashion, travel, cafe, office, daily vlog, aesthetic, creator, India, etc.
- Must include these two hashtags exactly:
#tarasuri
#tarasuritrend
- Total hashtags: 8 to 14.
- Return only final caption. No explanation.
`
    }
  ];

  for (const img of images.slice(0, 5)) {
    content.push({
      type: "image_url",
      image_url: {
        url: rawGithubUrl(img)
      }
    });
  }

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct",
        messages: [{ role: "user", content }],
        temperature: 0.75,
        max_tokens: 300
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      return fallbackCaption(mode);
    }

    const caption = data.choices[0].message.content.trim();

    return enforceRequiredHashtags(caption || fallbackCaption(mode));
  } catch {
    return fallbackCaption(mode);
  }
}

async function createPhotoImage(input, output) {
  await sharp(input)
    .rotate()
    .resize(PHOTO_WIDTH, PHOTO_HEIGHT, {
      fit: "cover",
      position: "attention"
    })
    .jpeg({ quality: 95 })
    .toFile(output);
}

async function createReelFrame(input, output) {
  await sharp(input)
    .rotate()
    .resize(REEL_WIDTH, REEL_HEIGHT, {
      fit: "cover",
      position: "attention"
    })
    .jpeg({ quality: 95 })
    .toFile(output);
}

async function createReel(images, music, output) {
  const frames = [];

  for (let i = 0; i < images.length; i++) {
    const frame = path.join(GENERATED_DIR, `frame_${Date.now()}_${i}.jpg`);
    await createReelFrame(images[i], frame);
    frames.push(frame);
  }

  const perImageDuration = 2.2;
  const transitionDuration = 0.35;
  const totalDuration = Math.max(8, images.length * perImageDuration);

  const args = ["-y"];

  for (const frame of frames) {
    args.push("-loop", "1", "-t", String(perImageDuration + 0.5), "-i", frame);
  }

  args.push("-stream_loop", "-1", "-i", music);

  let filter = "";

  for (let i = 0; i < frames.length; i++) {
    filter += `[${i}:v]scale=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1,fps=${FPS},format=yuv420p,trim=duration=${perImageDuration + 0.5},setpts=PTS-STARTPTS[v${i}];`;
  }

  if (frames.length === 1) {
    filter += `[v0]trim=duration=${totalDuration},setpts=PTS-STARTPTS[v]`;
  } else {
    filter += `[v0][v1]xfade=transition=fade:duration=${transitionDuration}:offset=${perImageDuration}[x1];`;

    for (let i = 2; i < frames.length; i++) {
      const previous = i === 2 ? "[x1]" : `[x${i - 1}]`;
      const current = `[v${i}]`;
      const outputLabel = i === frames.length - 1 ? "[v]" : `[x${i}]`;
      const offset = perImageDuration * i;

      filter += `${previous}${current}xfade=transition=fade:duration=${transitionDuration}:offset=${offset}${outputLabel};`;
    }

    if (frames.length === 2) {
      filter = filter.replace("[x1];", "[v];");
    }
  }

  const audioIndex = frames.length;

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    `${audioIndex}:a`,
    "-t",
    String(totalDuration),
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output
  );

  log("Creating simple reel: related photos + fade transition + song.");
  log("No zoom. No blur. No text.");

  await execFileAsync("ffmpeg", args, {
    maxBuffer: 1024 * 1024 * 50
  });

  for (const frame of frames) {
    safeDelete(frame);
  }
}

async function preparePhoto() {
  const images = await getGoodImages();
  const selected = images[0];

  const caption = await generateCaption("photo", [selected]);
  const output = path.join(GENERATED_DIR, `photo_${Date.now()}.jpg`);

  await createPhotoImage(selected, output);

  savePending({
    type: "photo",
    post_file: relativePosix(output),
    original_images: [relativePosix(selected)],
    caption
  });

  log("Prepared photo post.");
}

async function prepareReel() {
  const images = await getGoodImages();

  if (images.length < 2) {
    throw new Error("Need at least 2 photos in media/incoming to make reel.");
  }

  const selected = await aiPickRelatedImages(images);
  const music = pickMusic();
  const caption = await generateCaption("reel", selected);

  const output = path.join(GENERATED_DIR, `reel_${Date.now()}.mp4`);

  await createReel(selected, music, output);

  savePending({
    type: "reel",
    post_file: relativePosix(output),
    original_images: selected.map(relativePosix),
    music_used: relativePosix(music),
    caption
  });

  log("Prepared reel post.");
}

async function testAccounts() {
  const fbPageId = getEnv("FB_PAGE_ID");
  const igUserId = getEnv("IG_USER_ID");

  const fb = await graphGet(fbPageId, { fields: "id,name" });
  log(`Facebook Page OK: ${JSON.stringify(fb)}`);

  const ig = await graphGet(igUserId, { fields: "id,username" });
  log(`Instagram OK: ${JSON.stringify(ig)}`);
}

async function waitForInstagramMedia(containerId) {
  for (let i = 1; i <= 40; i++) {
    const status = await graphGet(containerId, { fields: "status_code,status" });

    log(`Instagram status ${i}: ${JSON.stringify(status)}`);

    if (status.status_code === "FINISHED") return;

    if (status.status_code === "ERROR") {
      throw new Error(`Instagram media error: ${JSON.stringify(status)}`);
    }

    await sleep(15000);
  }

  throw new Error("Instagram media not ready.");
}

async function publishInstagramPhoto(url, caption) {
  const igUserId = getEnv("IG_USER_ID");

  const container = await graphPost(`${igUserId}/media`, {
    image_url: url,
    caption
  });

  await waitForInstagramMedia(container.id);

  return graphPost(`${igUserId}/media_publish`, {
    creation_id: container.id
  });
}

async function publishInstagramReel(url, caption) {
  const igUserId = getEnv("IG_USER_ID");

  const container = await graphPost(`${igUserId}/media`, {
    media_type: "REELS",
    video_url: url,
    caption,
    share_to_feed: "true"
  });

  await waitForInstagramMedia(container.id);

  return graphPost(`${igUserId}/media_publish`, {
    creation_id: container.id
  });
}

async function publishFacebookPhoto(url, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");

  return graphPost(`${fbPageId}/photos`, {
    url,
    caption
  });
}

async function publishFacebookVideo(url, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");

  return graphPost(`${fbPageId}/videos`, {
    file_url: url,
    description: caption
  });
}

function updateHistory(entry) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) history.posted = [];
  if (!Array.isArray(history.used_music)) history.used_music = [];

  history.posted.push(entry);

  if (entry.music_used) {
    history.used_music.push(entry.music_used);
    history.used_music = history.used_music.slice(-20);
  }

  saveHistory(history);
}

function safeDelete(file) {
  try {
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file);
      log(`Deleted: ${file}`);
    }
  } catch (error) {
    log(`Delete failed: ${file} ${error.message}`);
  }
}

async function publishPending() {
  const pending = loadPending();

  if (!pending || !pending.type || !pending.post_file) {
    throw new Error("No pending post found.");
  }

  if (!shouldAllowPost(pending.type)) {
    log("Blocked by IST time guard. Prevented wrong-time posting.");
    return;
  }

  await testAccounts();

  const localFile = path.join(ROOT, pending.post_file);
  const url = rawGithubUrl(localFile);
  const caption = pending.caption;
  const results = {};

  if (pending.type === "photo") {
    results.facebook = await publishFacebookPhoto(url, caption);
    results.instagram = await publishInstagramPhoto(url, caption);
  }

  if (pending.type === "reel") {
    results.facebook = await publishFacebookVideo(url, caption);
    results.instagram = await publishInstagramReel(url, caption);
  }

  updateHistory({
    type: pending.type,
    posted_at: new Date().toISOString(),
    post_file: pending.post_file,
    original_images: pending.original_images || [],
    music_used: pending.music_used || "",
    caption,
    results
  });

  for (const img of pending.original_images || []) {
    safeDelete(path.join(ROOT, img));
  }

  safeDelete(localFile);
  clearPending();

  log("Post complete.");
}

async function main() {
  ensureFolders();

  const args = process.argv.slice(2);

  if (args.includes("--prepare-only")) {
    const mode = detectMode();

    log(`Mode: ${mode}`);

    if (mode === "photo") {
      await preparePhoto();
      return;
    }

    if (mode === "reel") {
      await prepareReel();
      return;
    }
  }

  if (args.includes("--publish-only")) {
    await publishPending();
    return;
  }

  throw new Error("Use --prepare-only or --publish-only");
}

main().catch((error) => {
  console.error("[BOT] ERROR:", error.message);
  process.exit(1);
});
