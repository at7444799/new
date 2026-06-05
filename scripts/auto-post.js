import fs from "fs";
import path from "path";
import os from "os";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const GRAPH_VERSION = "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ROOT = process.cwd();
const MEDIA_DIR = path.join(ROOT, "media");
const INCOMING_DIR = path.join(MEDIA_DIR, "incoming");
const MUSIC_DIR = path.join(MEDIA_DIR, "music");
const TEMP_DIR = path.join(os.tmpdir(), "tara-suri-auto-post");

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
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function getEnv(name, required = true, fallback = "") {
  const value = process.env[name] || fallback;

  if (required && !value) {
    throw new Error(`Missing environment variable / secret: ${name}`);
  }

  return value;
}

function setupCloudinary() {
  cloudinary.config({
    cloud_name: getEnv("CLOUDINARY_CLOUD_NAME"),
    api_key: getEnv("CLOUDINARY_API_KEY"),
    api_secret: getEnv("CLOUDINARY_API_SECRET"),
    secure: true
  });
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

  const selected = pickRandom(music);
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
Pick 2 to 5 photos that are most related for one Instagram Reel.

Match by:
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
`
    }
  ];

  for (const img of limited) {
    content.push({ type: "text", text: `Filename: ${path.basename(img)}` });
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
      return images.slice(0, Math.min(5, images.length));
    }

    const raw = data.choices[0].message.content.trim();
    const match = raw.match(/\{[\s\S]*\}/);

    if (!match) return images.slice(0, Math.min(5, images.length));

    const parsed = JSON.parse(match[0]);
    const selectedNames = parsed.selected_files || [];
    const selected = limited.filter((img) => selectedNames.includes(path.basename(img)));

    if (selected.length >= 2) return selected.slice(0, 5);

    return images.slice(0, Math.min(5, images.length));
  } catch {
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
  return tag.replace(/[^a-zA-Z0-9_#]/g, "").replace(/^#+/, "#").trim();
}

function enforceRequiredHashtags(caption) {
  const required = ["#tarasuri", "#tarasuritrend"];
  const clean = String(caption || "").replace(/```/g, "").replace(/^caption:/i, "").trim();

  const words = clean.split(/\s+/);
  const existingTags = words.filter((word) => word.startsWith("#")).map(normalizeHashtag);
  const nonTagText = words.filter((word) => !word.startsWith("#")).join(" ").trim();

  const hashtagSet = new Set();

  for (const tag of existingTags) {
    const normalized = normalizeHashtag(tag).toLowerCase();
    if (normalized.length > 1) hashtagSet.add(normalized);
  }

  for (const tag of required) hashtagSet.add(tag);

  return `${nonTagText}\n\n${Array.from(hashtagSet).slice(0, 14).join(" ")}`.trim();
}

function fallbackCaption(mode) {
  if (mode === "photo") {
    return enforceRequiredHashtags(
      `"Soft moments become memories when the light feels right." ✨\n\n#lifestylecreator #instagood #photooftheday #aestheticvibes #dailyvibes #tarasuri #tarasuritrend`
    );
  }

  return enforceRequiredHashtags(
    `"Some days are just little stories stitched together." ✨\n\n#reelsinstagram #trendingreels #reelitfeelit #creatorlife #aestheticreels #tarasuri #tarasuritrend`
  );
}

async function generateCaption(mode, images) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) return fallbackCaption(mode);

  const content = [
    {
      type: "text",
      text: `
Create one SEO-friendly Instagram/Facebook caption for Tara Suri.

Format:
Line 1: One short quote-style caption related to the actual photo/reel.
Line 2: Blank line.
Line 3: SEO-friendly hashtags.

Rules:
- Must match image mood, outfit, background, and vibe.
- Caption should feel quote-style, stylish, natural, and human.
- No fake brand deal.
- No adult wording.
- Must include #tarasuri and #tarasuritrend.
- Total hashtags: 8 to 14.
- Return only final caption.
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

    if (!response.ok || !data.choices) return fallbackCaption(mode);

    return enforceRequiredHashtags(data.choices[0].message.content.trim() || fallbackCaption(mode));
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
    const frame = path.join(TEMP_DIR, `frame_${Date.now()}_${i}.jpg`);
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

  if (frames.length === 2) {
    filter += `[v0][v1]xfade=transition=fade:duration=${transitionDuration}:offset=${perImageDuration}[v]`;
  } else {
    filter += `[v0][v1]xfade=transition=fade:duration=${transitionDuration}:offset=${perImageDuration}[x1];`;

    for (let i = 2; i < frames.length; i++) {
      const previous = i === 2 ? "[x1]" : `[x${i - 1}]`;
      const current = `[v${i}]`;
      const outputLabel = i === frames.length - 1 ? "[v]" : `[x${i}]`;
      const offset = perImageDuration * i;
      filter += `${previous}${current}xfade=transition=fade:duration=${transitionDuration}:offset=${offset}${outputLabel};`;
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

  log("Creating temporary reel only in runner.");
  log("No data/generated. No zoom. No blur. No text.");

  await execFileAsync("ffmpeg", args, {
    maxBuffer: 1024 * 1024 * 50
  });

  for (const frame of frames) safeDelete(frame);
}

async function uploadToCloudinary(filePath, resourceType) {
  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: resourceType,
    folder: "tara-suri-temp",
    overwrite: true
  });

  log(`Uploaded temporary file: ${result.secure_url}`);

  return {
    url: result.secure_url,
    publicId: result.public_id,
    resourceType
  };
}

async function deleteFromCloudinary(uploaded) {
  if (!uploaded?.publicId) return;

  try {
    await cloudinary.uploader.destroy(uploaded.publicId, {
      resource_type: uploaded.resourceType
    });

    log(`Deleted temporary cloud file: ${uploaded.publicId}`);
  } catch (error) {
    log(`Cloud delete failed: ${error.message}`);
  }
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

async function testAccounts() {
  const fbPageId = getEnv("FB_PAGE_ID");
  const igUserId = getEnv("IG_USER_ID");

  const fb = await graphGet(fbPageId, { fields: "id,name" });
  log(`Facebook Page OK: ${JSON.stringify(fb)}`);

  const ig = await graphGet(igUserId, { fields: "id,username" });
  log(`Instagram OK: ${JSON.stringify(ig)}`);
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

async function runPhoto() {
  const images = await getGoodImages();
  const selected = images[0];
  const caption = await generateCaption("photo", [selected]);
  const tempPhoto = path.join(TEMP_DIR, `photo_${Date.now()}.jpg`);

  let uploaded = null;

  try {
    await createPhotoImage(selected, tempPhoto);
    uploaded = await uploadToCloudinary(tempPhoto, "image");

    await testAccounts();

    await publishFacebookPhoto(uploaded.url, caption);
    await publishInstagramPhoto(uploaded.url, caption);

    safeDelete(selected);
    log("Used photo deleted from media/incoming.");
  } finally {
    safeDelete(tempPhoto);
    if (uploaded) await deleteFromCloudinary(uploaded);
  }
}

async function runReel() {
  const images = await getGoodImages();

  if (images.length < 2) {
    throw new Error("Need at least 2 photos in media/incoming to make reel.");
  }

  const selected = await aiPickRelatedImages(images);
  const music = pickMusic();
  const caption = await generateCaption("reel", selected);
  const tempReel = path.join(TEMP_DIR, `reel_${Date.now()}.mp4`);

  let uploaded = null;

  try {
    await createReel(selected, music, tempReel);
    uploaded = await uploadToCloudinary(tempReel, "video");

    await testAccounts();

    await publishFacebookVideo(uploaded.url, caption);
    await publishInstagramReel(uploaded.url, caption);

    for (const img of selected) {
      safeDelete(img);
    }

    log("Used reel photos deleted from media/incoming.");
  } finally {
    safeDelete(tempReel);
    if (uploaded) await deleteFromCloudinary(uploaded);
  }
}

async function main() {
  ensureFolders();
  setupCloudinary();

  const mode = detectMode();

  if (!shouldAllowPost(mode)) {
    log("Blocked by IST time guard. Prevented wrong-time posting.");
    return;
  }

  log(`Final mode: ${mode}`);

  if (mode === "photo") {
    await runPhoto();
    return;
  }

  if (mode === "reel") {
    await runReel();
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

main().catch((error) => {
  console.error("[BOT] ERROR:", error.message);
  process.exit(1);
});
