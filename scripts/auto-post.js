import fs from "fs";
import path from "path";
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";
import { google } from "googleapis";

const execFileAsync = promisify(execFile);

const GRAPH_VERSION = "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ROOT = process.cwd();
const MEDIA_ROOT = path.join(ROOT, "media");
const DATA_ROOT = path.join(ROOT, "data");

const MORNING_DIR = path.join(MEDIA_ROOT, "morning");
const EVENING_DIR = path.join(MEDIA_ROOT, "evening");
const REELS_SOURCE_DIR = path.join(MEDIA_ROOT, "reels");
const MUSIC_DIR = path.join(MEDIA_ROOT, "music");

const IG_READY_ROOT = path.join(MEDIA_ROOT, "_ig_ready");
const REELS_OUTPUT_ROOT = path.join(MEDIA_ROOT, "_reels");
const STORIES_OUTPUT_ROOT = path.join(MEDIA_ROOT, "_stories_ready");
const SNAPCHAT_OUTPUT_ROOT = path.join(MEDIA_ROOT, "_snapchat_ready");

const HISTORY_FILE = path.join(DATA_ROOT, "posted_history.json");
const PENDING_FILE = path.join(DATA_ROOT, "pending_post.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav"];

const REEL_DURATION_SECONDS = Number(process.env.REEL_DURATION_SECONDS || 11);
const REEL_FPS = 30;

const ENABLE_YOUTUBE = (process.env.ENABLE_YOUTUBE || "false").toLowerCase() === "true";
const APPROVAL_MODE = (process.env.APPROVAL_MODE || "false").toLowerCase() === "true";
const APPROVAL_STATUS = (process.env.APPROVAL_STATUS || "").toLowerCase();

function log(message) {
  console.log(`[BOT] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEnv(name, required = true, fallback = "") {
  const value = process.env[name] || fallback;
  if (required && !value) {
    throw new Error(`Missing GitHub Secret / environment variable: ${name}`);
  }
  return value;
}

function ensureFiles() {
  for (const dir of [
    DATA_ROOT,
    MORNING_DIR,
    EVENING_DIR,
    REELS_SOURCE_DIR,
    MUSIC_DIR,
    IG_READY_ROOT,
    REELS_OUTPUT_ROOT,
    STORIES_OUTPUT_ROOT,
    SNAPCHAT_OUTPUT_ROOT
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ posted: [], used_music: [] }, null, 2), "utf8");
  }

  if (!fs.existsSync(PENDING_FILE)) {
    fs.writeFileSync(PENDING_FILE, JSON.stringify({}, null, 2), "utf8");
  }
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadHistory() {
  ensureFiles();
  return loadJson(HISTORY_FILE, { posted: [], used_music: [] });
}

function saveHistory(history) {
  saveJson(HISTORY_FILE, history);
}

function loadPending() {
  ensureFiles();
  return loadJson(PENDING_FILE, {});
}

function savePending(data) {
  saveJson(PENDING_FILE, data);
}

function clearPending() {
  saveJson(PENDING_FILE, {});
}

function indiaNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function detectMode() {
  const manualMode = (process.env.MANUAL_MODE || "").toLowerCase().trim();

  if (["morning_photo", "evening_photo", "reel", "story"].includes(manualMode)) {
    return manualMode;
  }

  const now = indiaNow();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;

  if (totalMinutes >= 390 && totalMinutes <= 480) return "morning_photo";
  if (totalMinutes >= 1140 && totalMinutes <= 1230) return "evening_photo";

  return "reel";
}

function relativePosix(localPath) {
  return path.relative(ROOT, localPath).split(path.sep).join("/");
}

function rawGithubUrl(localPath) {
  const repo = getEnv("GITHUB_REPOSITORY");
  const branch = getEnv("GITHUB_REF_NAME", false, "main");

  const relative = relativePosix(localPath);
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

function findImageFilesRecursive(folder) {
  if (!fs.existsSync(folder)) return [];

  const output = [];

  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, item.name);

    if (item.isDirectory()) {
      output.push(...findImageFilesRecursive(fullPath));
    } else if (
      item.isFile() &&
      IMAGE_EXTENSIONS.includes(path.extname(item.name).toLowerCase()) &&
      !item.name.startsWith(".")
    ) {
      output.push(fullPath);
    }
  }

  return output.sort();
}

async function getImageQualityScore(imagePath) {
  const meta = await sharp(imagePath).metadata();

  const width = meta.width || 0;
  const height = meta.height || 0;
  const pixels = width * height;

  let score = 100;
  const reasons = [];

  if (width < 720 || height < 720) {
    score -= 35;
    reasons.push("low_resolution");
  }

  if (pixels < 900000) {
    score -= 25;
    reasons.push("too_small");
  }

  const stats = await sharp(imagePath)
    .resize(300, 300, { fit: "inside" })
    .greyscale()
    .stats();

  const mean = stats.channels[0].mean;
  const stdev = stats.channels[0].stdev;

  if (mean < 45) {
    score -= 25;
    reasons.push("too_dark");
  }

  if (mean > 230) {
    score -= 20;
    reasons.push("too_bright");
  }

  if (stdev < 18) {
    score -= 30;
    reasons.push("possibly_blurry_or_flat");
  }

  return {
    imagePath,
    width,
    height,
    score,
    reasons
  };
}

async function filterGoodImages(images, minimum = 55) {
  const checked = [];

  for (const image of images) {
    try {
      const quality = await getImageQualityScore(image);
      checked.push(quality);
      log(`Quality check: ${image} score=${quality.score} reasons=${quality.reasons.join(",") || "ok"}`);
    } catch (error) {
      log(`Quality check failed for ${image}: ${error.message}`);
    }
  }

  const good = checked
    .filter((item) => item.score >= minimum)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.imagePath);

  if (good.length > 0) return good;

  log("No high-quality images found. Falling back to original images.");
  return images;
}

function getReelSceneFolders() {
  if (!fs.existsSync(REELS_SOURCE_DIR)) return [];

  return fs
    .readdirSync(REELS_SOURCE_DIR, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith("_") && !item.name.startsWith("."))
    .map((item) => path.join(REELS_SOURCE_DIR, item.name))
    .filter((folder) => findFiles(folder, IMAGE_EXTENSIONS).length >= 2)
    .sort();
}

async function pickReelPhotos(count = 3) {
  const sceneFolders = getReelSceneFolders();

  if (sceneFolders.length > 0) {
    const folder = sceneFolders[Math.floor(Math.random() * sceneFolders.length)];
    let images = findFiles(folder, IMAGE_EXTENSIONS);
    images = await filterGoodImages(images);

    if (images.length >= 2) {
      const shuffled = [...images].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, Math.min(count, shuffled.length));

      log(`Selected reel scene folder: ${folder}`);
      selected.forEach((file, index) => log(`Selected reel photo ${index + 1}: ${file}`));

      return selected;
    }
  }

  let allImages = findImageFilesRecursive(REELS_SOURCE_DIR);
  allImages = await filterGoodImages(allImages);

  if (allImages.length < 2) {
    throw new Error(`Need at least 2 good images inside ${REELS_SOURCE_DIR}.`);
  }

  const shuffled = [...allImages].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(count, shuffled.length));

  selected.forEach((file, index) => log(`Selected reel photo ${index + 1}: ${file}`));

  return selected;
}

async function pickOneImage(folder, label) {
  let images = findFiles(folder, IMAGE_EXTENSIONS);
  images = await filterGoodImages(images);

  if (images.length < 1) {
    throw new Error(`Need at least 1 image in ${folder} for ${label}. Found 0.`);
  }

  const selected = images[Math.floor(Math.random() * images.length)];
  log(`Selected ${label} image: ${selected}`);
  return selected;
}

function pickMusicRotation() {
  const musicFiles = findFiles(MUSIC_DIR, MUSIC_EXTENSIONS);

  if (musicFiles.length < 1) {
    throw new Error("Need at least 1 music file inside media/music/ for Reels.");
  }

  const history = loadHistory();
  const usedMusic = Array.isArray(history.used_music) ? history.used_music : [];
  const lastMusic = usedMusic.length > 0 ? usedMusic[usedMusic.length - 1] : null;

  let candidates = musicFiles;

  if (musicFiles.length > 1 && lastMusic) {
    candidates = musicFiles.filter((file) => relativePosix(file) !== lastMusic);
  }

  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  log(`Selected music: ${selected}`);
  return selected;
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

function getRecentCaptions(limit = 20) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) return [];

  return history.posted
    .filter((item) => item.caption && typeof item.caption === "string")
    .slice(-limit)
    .map((item) => item.caption);
}

function fallbackCaption(mode) {
  if (mode === "morning_photo") {
    return "Soft start, clean mood. ✨\n\n#TaraSuri #MorningVibes #LifestyleCreator #SoftGlow #CleanGirlAesthetic";
  }

  if (mode === "evening_photo") {
    return "Evening light, easy mood. ✨\n\n#TaraSuri #EveningVibes #LifestyleCreator #SoftGlam #NightMood";
  }

  return "Tiny moments, big mood. ✨\n\n#TaraSuri #ReelMood #LifestyleCreator #AestheticVibes #CreatorLife";
}

async function analyzePhotosWithVision(imagePaths, mode) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    return "No visual analysis available because NVIDIA_API_KEY is missing.";
  }

  const visionModel = process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";

  const content = [
    {
      type: "text",
      text: `
Look at these influencer photos.

Post mode: ${mode}

Describe:
- location/background
- outfit style
- mood/vibe
- whether the photos feel like same scene/story
- best caption angle
- best reel category: travel, home, cafe, office, gym, night, party, casual, morning, evening
- 5 to 9 clean hashtags

Safety:
- Do not identify any real person.
- Do not use adult or explicit wording.
- Do not describe private body parts.
- Keep it clean and Instagram/Facebook/YouTube friendly.
`
    }
  ];

  for (const imagePath of imagePaths) {
    content.push({
      type: "image_url",
      image_url: {
        url: rawGithubUrl(imagePath)
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
        model: visionModel,
        messages: [{ role: "user", content }],
        temperature: 0.35,
        max_tokens: 700
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

async function generateCaption(mode, imagePathOrPaths) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    log("NVIDIA_API_KEY missing. Using fallback caption.");
    return fallbackCaption(mode);
  }

  const images = Array.isArray(imagePathOrPaths) ? imagePathOrPaths : [imagePathOrPaths];
  const visualAnalysis = await analyzePhotosWithVision(images, mode);
  const recentCaptions = getRecentCaptions(20);

  log("Visual analysis:");
  log(visualAnalysis);

  const recentCaptionText =
    recentCaptions.length > 0
      ? recentCaptions.map((caption, index) => `${index + 1}. ${caption}`).join("\n")
      : "No previous captions yet.";

  const prompt = `
Create one short clean influencer caption for an influencer named Tara Suri.

Post mode: ${mode}

Visual analysis:
${visualAnalysis}

Last 20 captions:
${recentCaptionText}

Rules:
- Match the actual visual vibe
- Short: 1 or 2 lines only
- Clean influencer vibe
- Hinglish + English mix is okay
- No long paragraph
- No robotic CTA
- Do not repeat old captions
- Use only 5 to 9 hashtags
- No adult explicit content
- Do not say AI-generated
- Do not claim fake brand partnership
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
            content: "You write short, clean, natural influencer captions based on visual analysis and caption history."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.85,
        max_tokens: 280
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      log(`NVIDIA caption error: ${JSON.stringify(data)}`);
      return fallbackCaption(mode);
    }

    return data.choices[0].message.content.trim() || fallbackCaption(mode);
  } catch (error) {
    log(`NVIDIA caption failed: ${error.message}`);
    return fallbackCaption(mode);
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
  await sharp(sourcePath)
    .rotate()
    .resize(1080, 1350, {
      fit: "cover",
      position: "attention"
    })
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  log(`Created full-frame Instagram photo without blur: ${outputPath}`);
}

async function createFullFrameImage(sourcePath, outputPath, width = 1080, height = 1920) {
  await sharp(sourcePath)
    .rotate()
    .resize(width, height, {
      fit: "cover",
      position: "attention"
    })
    .modulate({
      brightness: 1.02,
      saturation: 1.06
    })
    .sharpen({
      sigma: 0.6,
      m1: 0.7,
      m2: 0.25
    })
    .jpeg({ quality: 95 })
    .toFile(outputPath);
}

function pickTransitionStyle() {
  const styles = [
    {
      name: "aircraft_hatch_sunrise",
      xfade: "circleopen",
      filter: "eq=contrast=1.08:saturation=1.16:brightness=0.02,vignette=PI/8"
    },
    {
      name: "camera_fly_through",
      xfade: "zoomin",
      filter: "eq=contrast=1.06:saturation=1.12:brightness=0.015,vignette=PI/6"
    },
    {
      name: "portal_open",
      xfade: "circleopen",
      filter: "eq=contrast=1.1:saturation=1.15:brightness=0.02"
    },
    {
      name: "smooth_creator_cut",
      xfade: "smoothleft",
      filter: "eq=contrast=1.04:saturation=1.08:brightness=0.01"
    },
    {
      name: "travel_vlog_slide",
      xfade: "slideright",
      filter: "eq=contrast=1.05:saturation=1.12:brightness=0.01"
    },
    {
      name: "night_life_flash",
      xfade: "fadeblack",
      filter: "eq=contrast=1.12:saturation=1.15:brightness=0.015"
    }
  ];

  return styles[Math.floor(Math.random() * styles.length)];
}

async function createReelFromPhotos(imagePaths, musicPath, outputPath) {
  const stamp = Date.now();
  const selected = imagePaths.slice(0, Math.min(3, imagePaths.length));
  const frames = [];

  for (let i = 0; i < selected.length; i++) {
    const frame = path.join(REELS_OUTPUT_ROOT, `frame_${stamp}_${i + 1}.jpg`);
    await createFullFrameImage(selected[i], frame, 1080, 1920);
    frames.push(frame);
  }

  const transition = pickTransitionStyle();

  const inputs = [];
  for (const frame of frames) {
    inputs.push("-loop", "1", "-t", "5", "-i", frame);
  }

  inputs.push("-stream_loop", "-1", "-i", musicPath);

  let filter = "";
  const preparedLabels = [];

  for (let i = 0; i < frames.length; i++) {
    const directionZoom =
      i % 2 === 0
        ? "zoompan=z='min(1.00+0.0008*on,1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        : "zoompan=z='max(1.045-0.0008*on,1.00)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";

    filter += `[${i}:v]scale=1080:1920,setsar=1,fps=${REEL_FPS},format=yuv420p,${transition.filter},${directionZoom}:d=${5 * REEL_FPS}:s=1080x1920:fps=${REEL_FPS},trim=duration=5,setpts=PTS-STARTPTS[v${i}];`;
    preparedLabels.push(`[v${i}]`);
  }

  if (frames.length === 2) {
    filter += `${preparedLabels[0]}${preparedLabels[1]}xfade=transition=${transition.xfade}:duration=1:offset=4,trim=duration=${REEL_DURATION_SECONDS},setpts=PTS-STARTPTS[v]`;
  } else {
    filter += `${preparedLabels[0]}${preparedLabels[1]}xfade=transition=${transition.xfade}:duration=1:offset=3.5[x1];`;
    filter += `[x1]${preparedLabels[2]}xfade=transition=smoothleft:duration=1:offset=7,trim=duration=${REEL_DURATION_SECONDS},setpts=PTS-STARTPTS[v]`;
  }

  const audioIndex = frames.length;

  const args = [
    "-y",
    ...inputs,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    `${audioIndex}:a`,
    "-t",
    String(REEL_DURATION_SECONDS),
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath
  ];

  log("Creating 3-photo cinematic Reel...");
  log(`Transition style: ${transition.name}`);
  log("Full-frame 9:16 enabled.");
  log("Blur background disabled.");
  log("Story/Snapchat export enabled.");

  await execFileAsync("ffmpeg", args, {
    maxBuffer: 1024 * 1024 * 40
  });

  for (const frame of frames) safeDelete(frame);

  log(`Created Reel video: ${outputPath}`);
  return transition.name;
}

async function copyForStoryAndSnapchat(reelPath) {
  const stamp = Date.now();

  const storyPath = path.join(STORIES_OUTPUT_ROOT, `story_ready_${stamp}.mp4`);
  const snapPath = path.join(SNAPCHAT_OUTPUT_ROOT, `snapchat_ready_${stamp}.mp4`);
  const latestSnapPath = path.join(SNAPCHAT_OUTPUT_ROOT, `latest_snapchat_ready.mp4`);

  fs.copyFileSync(reelPath, storyPath);
  fs.copyFileSync(reelPath, snapPath);
  fs.copyFileSync(reelPath, latestSnapPath);

  log(`Story-ready export: ${storyPath}`);
  log(`Snapchat-ready export: ${snapPath}`);

  return {
    story_video: relativePosix(storyPath),
    snapchat_video: relativePosix(snapPath),
    latest_snapchat_video: relativePosix(latestSnapPath)
  };
}

async function preparePhotoPost(mode) {
  const folder = mode === "morning_photo" ? MORNING_DIR : EVENING_DIR;
  const label = mode === "morning_photo" ? "morning" : "evening";

  const originalImage = await pickOneImage(folder, label);
  const caption = await generateCaption(mode, originalImage);

  const stamp = Date.now();
  const instagramImage = path.join(IG_READY_ROOT, `${mode}_${stamp}.jpg`);

  await createInstagramSafeImage(originalImage, instagramImage);

  savePending({
    type: "photo",
    mode,
    created_at: new Date().toISOString(),
    caption,
    original_image: relativePosix(originalImage),
    instagram_image: relativePosix(instagramImage),
    approval_required: APPROVAL_MODE
  });

  log("Pending photo post saved.");
}

async function prepareReelPost() {
  const reelPhotos = await pickReelPhotos(3);
  const music = pickMusicRotation();
  const caption = await generateCaption("reel", reelPhotos);

  const stamp = Date.now();
  const reelVideo = path.join(REELS_OUTPUT_ROOT, `reel_${stamp}.mp4`);

  const transitionStyle = await createReelFromPhotos(reelPhotos, music, reelVideo);
  const exports = await copyForStoryAndSnapchat(reelVideo);

  savePending({
    type: "reel",
    mode: "reel",
    created_at: new Date().toISOString(),
    caption,
    transition_style: transitionStyle,
    original_images: reelPhotos.map(relativePosix),
    music_used: relativePosix(music),
    reel_video: relativePosix(reelVideo),
    ...exports,
    approval_required: APPROVAL_MODE
  });

  log("Pending upgraded Reel post saved.");
}

async function waitForInstagramMedia(containerId) {
  log(`Waiting for Instagram media processing: ${containerId}`);

  for (let attempt = 1; attempt <= 40; attempt++) {
    const status = await graphGet(containerId, { fields: "status_code,status" });

    log(`Instagram media status attempt ${attempt}: ${JSON.stringify(status)}`);

    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") {
      throw new Error(`Instagram media processing failed: ${JSON.stringify(status)}`);
    }

    await sleep(15000);
  }

  throw new Error("Instagram media was not ready after waiting.");
}

async function publishInstagramPhoto(imageUrl, caption) {
  const igUserId = getEnv("IG_USER_ID");

  const container = await graphPost(`${igUserId}/media`, {
    image_url: imageUrl,
    caption
  });

  await waitForInstagramMedia(container.id);

  const published = await graphPost(`${igUserId}/media_publish`, {
    creation_id: container.id
  });

  log(`Instagram photo published: ${JSON.stringify(published)}`);
  return published;
}

async function publishFacebookPhoto(imageUrl, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");

  const photo = await graphPost(`${fbPageId}/photos`, {
    url: imageUrl,
    caption
  });

  log(`Facebook photo published: ${JSON.stringify(photo)}`);
  return photo;
}

async function publishInstagramReel(videoUrl, caption) {
  const igUserId = getEnv("IG_USER_ID");

  const container = await graphPost(`${igUserId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true"
  });

  await waitForInstagramMedia(container.id);

  const published = await graphPost(`${igUserId}/media_publish`, {
    creation_id: container.id
  });

  log(`Instagram Reel published: ${JSON.stringify(published)}`);
  return published;
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

function getYouTubeOAuthClient() {
  let clientId = process.env.YOUTUBE_CLIENT_ID || "";
  let clientSecret = process.env.YOUTUBE_CLIENT_SECRET || "";
  let refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || "";

  const credentialsPath = path.join(ROOT, "credentials.json");
  const tokenPath = path.join(ROOT, "token.json");

  if ((!clientId || !clientSecret) && fs.existsSync(credentialsPath)) {
    const credentials = loadJson(credentialsPath, {});
    const installed = credentials.installed || credentials.web || {};
    clientId = clientId || installed.client_id || "";
    clientSecret = clientSecret || installed.client_secret || "";
  }

  if (!refreshToken && fs.existsSync(tokenPath)) {
    const token = loadJson(tokenPath, {});
    refreshToken = token.refresh_token || "";
  }

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "YouTube upload needs YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN or credentials.json + token.json."
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, "http://localhost");
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return oauth2Client;
}

async function publishYouTubeShort(videoPath, caption) {
  if (!ENABLE_YOUTUBE) {
    log("YouTube upload disabled. Set ENABLE_YOUTUBE=true to enable.");
    return null;
  }

  const auth = getYouTubeOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });

  const titleBase = caption.split("\n")[0].replace(/[#✨]/g, "").trim() || "Tara Suri Shorts";
  const title = titleBase.length > 85 ? titleBase.slice(0, 85) : titleBase;

  const description = `${caption}\n\n#Shorts #TaraSuri #LifestyleShorts`;

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description,
        tags: ["Shorts", "Tara Suri", "Lifestyle", "Reels", "AI Influencer"],
        categoryId: "22"
      },
      status: {
        privacyStatus: process.env.YOUTUBE_PRIVACY_STATUS || "public",
        selfDeclaredMadeForKids: false
      }
    },
    media: {
      body: fs.createReadStream(videoPath)
    }
  });

  log(`YouTube Short uploaded: ${JSON.stringify(response.data)}`);
  return response.data;
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

function updateHistory(entry) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) history.posted = [];
  if (!Array.isArray(history.used_music)) history.used_music = [];

  history.posted.push(entry);

  if (entry.music_used) {
    history.used_music.push(entry.music_used);
    history.used_music = history.used_music.slice(-30);
  }

  saveHistory(history);
}

async function publishPendingPost() {
  ensureFiles();

  const pending = loadPending();

  if (!pending || !pending.type || !pending.caption) {
    throw new Error("No pending post found. Run prepare step first.");
  }

  if (pending.approval_required && APPROVAL_STATUS !== "approved") {
    log("Approval mode is ON. Post prepared but not published.");
    log("Set APPROVAL_STATUS=approved and run publish when ready.");
    return;
  }

  await testAccounts();

  const caption = pending.caption;
  const results = {};
  const postedAt = new Date().toISOString();

  log("Generated caption:");
  log(caption);

  if (pending.type === "photo") {
    const originalPath = path.join(ROOT, pending.original_image);
    const instagramPath = path.join(ROOT, pending.instagram_image);

    const facebookUrl = rawGithubUrl(originalPath);
    const instagramUrl = rawGithubUrl(instagramPath);

    results.facebookPhoto = await publishFacebookPhoto(facebookUrl, caption);
    results.instagramPhoto = await publishInstagramPhoto(instagramUrl, caption);

    updateHistory({
      type: "photo",
      mode: pending.mode,
      posted_at: postedAt,
      caption,
      original_image: pending.original_image,
      instagram_image: pending.instagram_image,
      results
    });

    safeDelete(originalPath);
    safeDelete(instagramPath);
  }

  if (pending.type === "reel") {
    const reelPath = path.join(ROOT, pending.reel_video);

    if (!fs.existsSync(reelPath)) {
      throw new Error(`Reel video missing: ${reelPath}`);
    }

    const reelUrl = rawGithubUrl(reelPath);

    results.facebookVideo = await publishFacebookVideo(reelUrl, caption);
    results.instagramReel = await publishInstagramReel(reelUrl, caption);

    const youtubeResult = await publishYouTubeShort(reelPath, caption);
    if (youtubeResult) results.youtubeShort = youtubeResult;

    updateHistory({
      type: "reel",
      mode: pending.mode,
      posted_at: postedAt,
      caption,
      transition_style: pending.transition_style || "",
      original_images: pending.original_images || [],
      music_used: pending.music_used,
      reel_video: pending.reel_video,
      story_video: pending.story_video || "",
      snapchat_video: pending.snapchat_video || "",
      results
    });

    if (Array.isArray(pending.original_images)) {
      for (const image of pending.original_images) {
        safeDelete(path.join(ROOT, image));
      }
    }

    safeDelete(reelPath);
  }

  clearPending();
  log("Posting complete.");
}

async function main() {
  ensureFiles();

  const args = process.argv.slice(2);

  if (args.includes("--prepare-only")) {
    const mode = detectMode();

    log(`Selected mode: ${mode}`);

    if (mode === "morning_photo" || mode === "evening_photo") {
      await preparePhotoPost(mode);
      return;
    }

    if (mode === "reel" || mode === "story") {
      await prepareReelPost();
      return;
    }

    throw new Error(`Unknown mode: ${mode}`);
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
