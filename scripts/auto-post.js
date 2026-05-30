import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const GRAPH_VERSION = "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ROOT = process.cwd();
const MEDIA_ROOT = path.join(ROOT, "media");
const IG_READY_ROOT = path.join(MEDIA_ROOT, "_ig_ready");
const REELS_ROOT = path.join(MEDIA_ROOT, "_reels");
const DATA_ROOT = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_ROOT, "posted_history.json");
const PENDING_FILE = path.join(DATA_ROOT, "pending_post.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav"];

function log(message) {
  console.log(`[BOT] ${message}`);
}

function getEnv(name, required = true, fallback = "") {
  const value = process.env[name] || fallback;
  if (required && !value) {
    throw new Error(`Missing GitHub Secret / environment variable: ${name}`);
  }
  return value;
}

function ensureFiles() {
  for (const dir of [DATA_ROOT, IG_READY_ROOT, REELS_ROOT]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ posted: [] }, null, 2), "utf8");
  }

  if (!fs.existsSync(PENDING_FILE)) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify({}, null, 2), "utf8");
  }
}

function loadHistory() {
  ensureFiles();
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return { posted: [] };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), "utf8");
}

function loadPending() {
  ensureFiles();
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePending(data) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2), "utf8");
}

function clearPending() {
  fs.writeFileSync(PENDING_FILE, JSON.stringify({}, null, 2), "utf8");
}

function indiaNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function detectSlot() {
  const manualSlot = (process.env.MANUAL_SLOT || "").toLowerCase().trim();

  if (["morning", "evening", "weekend"].includes(manualSlot)) {
    return manualSlot;
  }

  const now = indiaNow();
  const hour = now.getUTCHours();
  const day = now.getUTCDay();

  if ((day === 0 || day === 6) && hour >= 9 && hour <= 13) {
    return "weekend";
  }

  if (hour >= 4 && hour < 14) {
    return "morning";
  }

  return "evening";
}

function slotFolder(slot) {
  return path.join(MEDIA_ROOT, slot);
}

function findFiles(folder, extensions) {
  if (!fs.existsSync(folder)) return [];

  const files = [];
  const items = fs.readdirSync(folder, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(folder, item.name);

    if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();
      if (extensions.includes(ext) && !item.name.startsWith(".")) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function pickTwoImages(slot) {
  const folder = slotFolder(slot);
  const images = findFiles(folder, IMAGE_EXTENSIONS);

  if (images.length < 2) {
    throw new Error(`Need at least 2 images in ${folder}. Found ${images.length}.`);
  }

  const shuffled = [...images].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 2);

  log(`Selected images: ${selected.join(", ")}`);
  return selected;
}

function pickMusic() {
  const musicFolder = path.join(MEDIA_ROOT, "music");
  const tracks = findFiles(musicFolder, MUSIC_EXTENSIONS);

  if (tracks.length === 0) {
    log("No music found in media/music/. Reel creation will be skipped.");
    return null;
  }

  const selected = tracks[Math.floor(Math.random() * tracks.length)];
  log(`Selected music: ${selected}`);
  return selected;
}

function relativePosix(localPath) {
  return path.relative(ROOT, localPath).split(path.sep).join("/");
}

function rawGithubUrl(localPath) {
  const repo = getEnv("GITHUB_REPOSITORY");
  const branch = getEnv("GITHUB_REF_NAME", false, "main");

  const relative = relativePosix(localPath);
  const encoded = relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`;
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

function getRecentCaptions(limit = 5) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) return [];

  return history.posted
    .filter((item) => item.caption && typeof item.caption === "string")
    .slice(-limit)
    .map((item) => item.caption);
}

function fallbackCaption(slot) {
  const captions = {
    morning:
      "Soft start, clean mood. ✨\n\n#TaraSuri #MorningVibes #CleanGirlAesthetic #LifestyleCreator #SoftGlow #CreatorLife",
    evening:
      "Evening light. Calm energy. ✨\n\n#TaraSuri #EveningVibes #SoftGlam #LifestyleCreator #NightMood #CreatorLife",
    weekend:
      "Weekend mood, simple and free. ✨\n\n#TaraSuri #WeekendVibes #TravelMood #LifestyleCreator #AestheticVibes #CreatorLife"
  };

  return captions[slot] || captions.morning;
}

async function analyzePhotoWithVision(imagePaths) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    return "No visual analysis available because NVIDIA_API_KEY is missing.";
  }

  const visionModel =
    process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";

  const imageContent = imagePaths.map((imagePath) => ({
    type: "image_url",
    image_url: {
      url: rawGithubUrl(imagePath)
    }
  }));

  const prompt = `
Look carefully at these influencer photos.

Describe:
- background/location
- outfit style
- mood/vibe
- colors
- pose/body language
- whether it feels like morning, evening, travel, party, cafe, office, home, or casual lifestyle
- best caption angle
- hashtags that match the actual photo

Safety:
- Do not identify any real person.
- Do not use adult or explicit wording.
- Do not describe private body parts.
- Keep the description useful for writing an Instagram/Facebook caption.
`;

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: visionModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              },
              ...imageContent
            ]
          }
        ],
        temperature: 0.4,
        max_tokens: 600
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      log(`NVIDIA vision error: ${JSON.stringify(data)}`);
      return "No visual analysis available.";
    }

    return data.choices[0].message.content.trim() || "No visual analysis available.";
  } catch (error) {
    log(`NVIDIA vision failed: ${error.message}`);
    return "No visual analysis available.";
  }
}

async function generateCaption(slot, imagePaths) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    log("NVIDIA_API_KEY missing. Using fallback caption.");
    return fallbackCaption(slot);
  }

  const imageNames = imagePaths.map((p) => path.basename(p)).join(", ");
  const visualAnalysis = await analyzePhotoWithVision(imagePaths);
  const recentCaptions = getRecentCaptions(5);

  log("Photo visual analysis:");
  log(visualAnalysis);

  const recentCaptionText =
    recentCaptions.length > 0
      ? recentCaptions.map((caption, index) => `${index + 1}. ${caption}`).join("\n")
      : "No previous captions yet.";

  const prompt = `
Create one short clean influencer caption for an influencer named Tara Suri.

Post type selected by schedule: ${slot}
Images: ${imageNames}

Photo analysis:
${visualAnalysis}

Recent captions:
${recentCaptionText}

Caption style:
- Short: 1 or 2 lines only
- Clean influencer vibe
- Soft, stylish, natural, confident
- Hinglish + English mix is okay, but keep it classy
- Not too professional, not too childish
- No long paragraph
- No robotic CTA
- No repeated old line
- Keep Tara Suri's personality consistent with recent captions
- Caption must match actual photo vibe, outfit, background, color, and mood
- Use only 5 to 9 hashtags
- Hashtags must relate to actual photo
- No adult explicit content
- Do not say AI-generated
- Do not claim fake brand partnership
- Do not identify any real person
- Return only final caption text
`;

  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
        messages: [
          {
            role: "system",
            content:
              "You write short, clean, natural influencer captions based on visual photo analysis and caption history."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.85,
        max_tokens: 260
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      log(`NVIDIA caption error: ${JSON.stringify(data)}`);
      return fallbackCaption(slot);
    }

    const caption = data.choices[0].message.content.trim();

    return caption || fallbackCaption(slot);
  } catch (error) {
    log(`NVIDIA caption failed: ${error.message}`);
    return fallbackCaption(slot);
  }
}

async function testAccounts() {
  const fbPageId = getEnv("FB_PAGE_ID");
  const igUserId = getEnv("IG_USER_ID");

  const fb = await graphGet(fbPageId, { fields: "id,name" });
  log(`Facebook Page OK: ${JSON.stringify(fb)}`);

  const ig = await graphGet(igUserId, { fields: "id,username" });
  log(`Instagram OK: ${JSON.stringify(ig)}`);
}

async function createInstagramSafeImage(sourcePath, outputPath) {
  const source = sharp(sourcePath).rotate();

  const backgroundBuffer = await source
    .clone()
    .resize(1080, 1350, {
      fit: "cover",
      position: "attention"
    })
    .blur(25)
    .modulate({
      brightness: 0.92,
      saturation: 1
    })
    .jpeg({ quality: 92 })
    .toBuffer();

  const foregroundBuffer = await source
    .clone()
    .resize(1080, 1350, {
      fit: "contain",
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0
      }
    })
    .png()
    .toBuffer();

  await sharp(backgroundBuffer)
    .composite([
      {
        input: foregroundBuffer,
        gravity: "center"
      }
    ])
    .jpeg({ quality: 94 })
    .toFile(outputPath);
}

async function createReelFromPhotos(imagePaths, musicPath, outputPath) {
  const reelFramePaths = [];

  for (let i = 0; i < imagePaths.length; i++) {
    const framePath = path.join(REELS_ROOT, `frame_${Date.now()}_${i + 1}.jpg`);
    await createInstagramSafeImage(imagePaths[i], framePath);
    reelFramePaths.push(framePath);
  }

  const inputArgs = [];

  for (const framePath of reelFramePaths) {
    inputArgs.push("-loop", "1", "-t", "4.5", "-i", framePath);
  }

  if (musicPath) {
    inputArgs.push("-stream_loop", "-1", "-i", musicPath);
  }

  const filterParts = [];
  const videoLabels = [];

  for (let i = 0; i < reelFramePaths.length; i++) {
    filterParts.push(
      `[${i}:v]scale=1080:1350,setsar=1,format=yuv420p,` +
        `zoompan=z='min(zoom+0.0015,1.08)':d=135:s=1080x1350:fps=30,` +
        `pad=1080:1920:0:285:color=black[v${i}]`
    );
    videoLabels.push(`[v${i}]`);
  }

  filterParts.push(`${videoLabels.join("")}concat=n=${reelFramePaths.length}:v=1:a=0[outv]`);

  const args = [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[outv]"
  ];

  if (musicPath) {
    const audioIndex = reelFramePaths.length;
    args.push("-map", `${audioIndex}:a`, "-shortest");
  }

  args.push(
    "-t",
    "9",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath
  );

  log("Creating Reel video with FFmpeg...");
  await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 10 });

  for (const framePath of reelFramePaths) {
    safeDelete(framePath);
  }

  log(`Created Reel video: ${outputPath}`);
}

async function preparePendingPost() {
  ensureFiles();

  const slot = detectSlot();
  log(`Selected slot: ${slot}`);

  const originals = pickTwoImages(slot);
  const music = pickMusic();

  const caption = await generateCaption(slot, originals);

  const stamp = Date.now();
  const instagramProcessed = [];

  for (let i = 0; i < originals.length; i++) {
    const outputPath = path.join(IG_READY_ROOT, `${slot}_${stamp}_${i + 1}.jpg`);
    await createInstagramSafeImage(originals[i], outputPath);
    instagramProcessed.push(outputPath);
    log(`Created Instagram-safe image: ${outputPath}`);
  }

  let reelPath = null;

  if (music) {
    reelPath = path.join(REELS_ROOT, `${slot}_${stamp}_reel.mp4`);
    await createReelFromPhotos(originals, music, reelPath);
  }

  const pending = {
    slot,
    created_at: new Date().toISOString(),
    caption,
    original_images: originals.map(relativePosix),
    instagram_images: instagramProcessed.map(relativePosix),
    reel_video: reelPath ? relativePosix(reelPath) : null,
    music_used: music ? relativePosix(music) : null
  };

  savePending(pending);

  log("Pending post saved.");
}

async function publishInstagramCarousel(imageUrls, caption) {
  const igUserId = getEnv("IG_USER_ID");
  const childIds = [];

  for (const imageUrl of imageUrls) {
    const child = await graphPost(`${igUserId}/media`, {
      image_url: imageUrl,
      is_carousel_item: "true"
    });

    if (!child.id) {
      throw new Error(`Instagram child container missing ID: ${JSON.stringify(child)}`);
    }

    childIds.push(child.id);
    log(`Instagram child container created: ${child.id}`);
  }

  const parent = await graphPost(`${igUserId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption
  });

  if (!parent.id) {
    throw new Error(`Instagram parent container missing ID: ${JSON.stringify(parent)}`);
  }

  log(`Instagram parent container created: ${parent.id}`);
  await new Promise((resolve) => setTimeout(resolve, 10000));

  const published = await graphPost(`${igUserId}/media_publish`, {
    creation_id: parent.id
  });

  log(`Instagram carousel published: ${JSON.stringify(published)}`);
  return published;
}

async function publishInstagramReel(videoUrl, caption) {
  const igUserId = getEnv("IG_USER_ID");

  const container = await graphPost(`${igUserId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption
  });

  if (!container.id) {
    throw new Error(`Instagram Reel container missing ID: ${JSON.stringify(container)}`);
  }

  log(`Instagram Reel container created: ${container.id}`);

  await new Promise((resolve) => setTimeout(resolve, 25000));

  const published = await graphPost(`${igUserId}/media_publish`, {
    creation_id: container.id
  });

  log(`Instagram Reel published: ${JSON.stringify(published)}`);
  return published;
}

async function publishFacebookMultiPhoto(imageUrls, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");
  const photoIds = [];

  for (const imageUrl of imageUrls) {
    const photo = await graphPost(`${fbPageId}/photos`, {
      url: imageUrl,
      published: "false"
    });

    if (!photo.id) {
      throw new Error(`Facebook photo missing ID: ${JSON.stringify(photo)}`);
    }

    photoIds.push(photo.id);
    log(`Facebook unpublished photo uploaded: ${photo.id}`);
  }

  const params = { message: caption };

  photoIds.forEach((photoId, index) => {
    params[`attached_media[${index}]`] = JSON.stringify({
      media_fbid: photoId
    });
  });

  const post = await graphPost(`${fbPageId}/feed`, params);

  log(`Facebook photo post published: ${JSON.stringify(post)}`);
  return post;
}

async function publishFacebookVideo(videoUrl, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");

  const video = await graphPost(`${fbPageId}/videos`, {
    file_url: videoUrl,
    description: caption
  });

  log(`Facebook video published: ${JSON.stringify(video)}`);
  return video;
}

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log(`Deleted file: ${filePath}`);
    }
  } catch (error) {
    log(`Delete failed for ${filePath}: ${error.message}`);
  }
}

function updateHistory(slot, originalPaths, instagramPaths, reelPath, caption, results) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) {
    history.posted = [];
  }

  const now = new Date().toISOString();

  history.posted.push({
    slot,
    posted_at: now,
    caption,
    original_files: originalPaths.map(relativePosix),
    instagram_files: instagramPaths.map(relativePosix),
    reel_file: reelPath ? relativePosix(reelPath) : null,
    results
  });

  saveHistory(history);
}

async function publishPendingPost() {
  ensureFiles();
  await testAccounts();

  const pending = loadPending();

  if (!pending || !pending.original_images || !pending.instagram_images || !pending.caption) {
    throw new Error("No pending post found. Run prepare step first.");
  }

  const originalPaths = pending.original_images.map((p) => path.join(ROOT, p));
  const instagramPaths = pending.instagram_images.map((p) => path.join(ROOT, p));
  const reelPath = pending.reel_video ? path.join(ROOT, pending.reel_video) : null;

  for (const filePath of [...originalPaths, ...instagramPaths]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file missing: ${filePath}`);
    }
  }

  if (reelPath && !fs.existsSync(reelPath)) {
    throw new Error(`Reel video missing: ${reelPath}`);
  }

  const facebookPhotoUrls = originalPaths.map(rawGithubUrl);
  const instagramPhotoUrls = instagramPaths.map(rawGithubUrl);
  const reelUrl = reelPath ? rawGithubUrl(reelPath) : null;

  log("Facebook original image URLs:");
  facebookPhotoUrls.forEach((url) => log(url));

  log("Instagram processed image URLs:");
  instagramPhotoUrls.forEach((url) => log(url));

  if (reelUrl) {
    log(`Reel video URL: ${reelUrl}`);
  }

  const caption = pending.caption;

  log("Generated caption:");
  log(caption);

  const results = {};

  results.facebookPhoto = await publishFacebookMultiPhoto(facebookPhotoUrls, caption);
  results.instagramCarousel = await publishInstagramCarousel(instagramPhotoUrls, caption);

  if (reelUrl) {
    results.facebookVideo = await publishFacebookVideo(reelUrl, caption);
    results.instagramReel = await publishInstagramReel(reelUrl, caption);
  } else {
    log("No Reel video found. Skipping Reel uploads.");
  }

  updateHistory(pending.slot, originalPaths, instagramPaths, reelPath, caption, results);

  for (const filePath of originalPaths) {
    safeDelete(filePath);
  }

  for (const filePath of instagramPaths) {
    safeDelete(filePath);
  }

  if (reelPath) {
    safeDelete(reelPath);
  }

  clearPending();

  log("Posting complete. Used photos, processed images and reel deleted.");
}

async function main() {
  ensureFiles();

  const args = process.argv.slice(2);

  if (args.includes("--prepare-only")) {
    await preparePendingPost();
    return;
  }

  if (args.includes("--publish-only")) {
    await publishPendingPost();
    return;
  }

  throw new Error("Use --prepare-only or --publish-only");
}

main().catch((error) => {
  console.error("[BOT] ERROR:", error.message);
  process.exit(1);
});
