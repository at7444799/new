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
const DATA_ROOT = path.join(ROOT, "data");

const MORNING_DIR = path.join(MEDIA_ROOT, "morning");
const EVENING_DIR = path.join(MEDIA_ROOT, "evening");
const REELS_SOURCE_DIR = path.join(MEDIA_ROOT, "reels");
const MUSIC_DIR = path.join(MEDIA_ROOT, "music");

const IG_READY_ROOT = path.join(MEDIA_ROOT, "_ig_ready");
const REELS_OUTPUT_ROOT = path.join(MEDIA_ROOT, "_reels");

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
  for (const dir of [
    DATA_ROOT,
    MORNING_DIR,
    EVENING_DIR,
    REELS_SOURCE_DIR,
    MUSIC_DIR,
    IG_READY_ROOT,
    REELS_OUTPUT_ROOT
  ]) {
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

function detectMode() {
  const manualMode = (process.env.MANUAL_MODE || "").toLowerCase().trim();

  if (["morning_photo", "evening_photo", "reel"].includes(manualMode)) {
    return manualMode;
  }

  const now = indiaNow();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;

  // India time windows
  // 7:00 AM photo
  if (totalMinutes >= 390 && totalMinutes <= 480) {
    return "morning_photo";
  }

  // 7:30 PM photo
  if (totalMinutes >= 1140 && totalMinutes <= 1230) {
    return "evening_photo";
  }

  // All other scheduled runs are Reels
  return "reel";
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

function pickOneImage(folder, label) {
  const images = findFiles(folder, IMAGE_EXTENSIONS);

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

function getRecentCaptions(limit = 15) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) return [];

  return history.posted
    .filter((item) => item.caption && typeof item.caption === "string")
    .slice(-limit)
    .map((item) => item.caption);
}

function fallbackCaption(mode) {
  if (mode === "morning_photo") {
    return "Soft start, clean mood. ✨\n\n#TaraSuri #MorningVibes #SoftGlow #LifestyleCreator #CleanGirlAesthetic";
  }

  if (mode === "evening_photo") {
    return "Evening light, easy mood. ✨\n\n#TaraSuri #EveningVibes #SoftGlam #LifestyleCreator #NightMood";
  }

  return "A little vibe for the timeline. ✨\n\n#TaraSuri #ReelMood #LifestyleCreator #AestheticVibes #CreatorLife";
}

async function analyzePhotoWithVision(imagePath, mode) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    return "No visual analysis available because NVIDIA_API_KEY is missing.";
  }

  const visionModel =
    process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";

  const imageUrl = rawGithubUrl(imagePath);

  const prompt = `
Look carefully at this influencer photo.

Post mode: ${mode}

Describe:
- background/location
- outfit style
- mood/vibe
- colors
- pose/body language
- whether it feels like morning, evening, travel, party, cafe, office, home, or casual lifestyle
- best short caption angle
- 5 to 9 hashtags that match the actual photo

Safety:
- Do not identify any real person.
- Do not use adult or explicit wording.
- Do not describe private body parts.
- Keep the description useful for writing a clean Instagram/Facebook influencer caption.
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
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
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

async function generateCaption(mode, imagePath) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    log("NVIDIA_API_KEY missing. Using fallback caption.");
    return fallbackCaption(mode);
  }

  const visualAnalysis = await analyzePhotoWithVision(imagePath, mode);
  const recentCaptions = getRecentCaptions(15);

  log("Photo visual analysis:");
  log(visualAnalysis);

  const recentCaptionText =
    recentCaptions.length > 0
      ? recentCaptions.map((caption, index) => `${index + 1}. ${caption}`).join("\n")
      : "No previous captions yet.";

  const prompt = `
Create one short clean influencer caption for an influencer named Tara Suri.

Post mode: ${mode}
Image file: ${path.basename(imagePath)}

Photo analysis:
${visualAnalysis}

Last 15 captions:
${recentCaptionText}

Rules:
- Caption must match the actual photo vibe, outfit, background, color, and mood
- Short: 1 or 2 lines only
- Clean influencer vibe
- Soft, stylish, natural, confident
- Hinglish + English mix is okay, but keep it classy
- Not too professional, not too childish
- No long paragraph
- No robotic CTA
- Do not repeat old captions
- Do not repeat the same hook line
- Keep Tara Suri's personality consistent
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
      return fallbackCaption(mode);
    }

    return data.choices[0].message.content.trim() || fallbackCaption(mode);
  } catch (error) {
    log(`NVIDIA caption failed: ${error.message}`);
    return fallbackCaption(mode);
  }
}

async function generateOverlayText(mode, imagePath) {
  const caption = await generateCaption(`overlay_${mode}`, imagePath);

  const firstLine = caption
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));

  if (!firstLine) {
    return "Soft vibe";
  }

  return firstLine
    .replace(/[^\p{L}\p{N}\s.,!?'✨-]/gu, "")
    .slice(0, 42);
}

async function testAccounts() {
  const fbPageId = getEnv("FB_PAGE_ID");
  const igUserId = getEnv("IG_USER_ID");

  const fb = await graphGet(fbPageId, {
    fields: "id,name"
  });

  log(`Facebook Page OK: ${JSON.stringify(fb)}`);

  const ig = await graphGet(igUserId, {
    fields: "id,username"
  });

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
    .jpeg({
      quality: 92
    })
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
    .jpeg({
      quality: 94
    })
    .toFile(outputPath);
}

async function createReelFrame(sourcePath, outputPath) {
  const source = sharp(sourcePath).rotate();

  const backgroundBuffer = await source
    .clone()
    .resize(1080, 1920, {
      fit: "cover",
      position: "attention"
    })
    .blur(30)
    .modulate({
      brightness: 0.86,
      saturation: 1.05
    })
    .jpeg({
      quality: 90
    })
    .toBuffer();

  const foregroundBuffer = await source
    .clone()
    .resize(1010, 1600, {
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
    .jpeg({
      quality: 94
    })
    .toFile(outputPath);
}

function escapeDrawText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,");
}

async function createReelFromPhoto(imagePath, musicPath, outputPath, overlayText) {
  const framePath = path.join(REELS_OUTPUT_ROOT, `frame_${Date.now()}.jpg`);
  await createReelFrame(imagePath, framePath);

  const safeText = escapeDrawText(overlayText || "Soft vibe");

  const filter =
    "scale=1080:1920," +
    "zoompan=z='min(zoom+0.0012,1.08)':d=270:s=1080x1920:fps=30," +
    "format=yuv420p," +
    `drawtext=text='${safeText}':` +
    "fontcolor=white:" +
    "fontsize=54:" +
    "box=1:" +
    "boxcolor=black@0.35:" +
    "boxborderw=24:" +
    "x=(w-text_w)/2:" +
    "y=h-300";

  const args = [
    "-y",
    "-loop",
    "1",
    "-i",
    framePath,
    "-stream_loop",
    "-1",
    "-i",
    musicPath,
    "-t",
    "9",
    "-vf",
    filter,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-shortest",
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
  ];

  log("Creating Reel video with FFmpeg...");
  await execFileAsync("ffmpeg", args, {
    maxBuffer: 1024 * 1024 * 10
  });

  safeDelete(framePath);

  log(`Created Reel video: ${outputPath}`);
}

async function preparePhotoPost(mode) {
  const folder = mode === "morning_photo" ? MORNING_DIR : EVENING_DIR;
  const label = mode === "morning_photo" ? "morning" : "evening";

  const originalImage = pickOneImage(folder, label);
  const caption = await generateCaption(mode, originalImage);

  const stamp = Date.now();
  const instagramImage = path.join(IG_READY_ROOT, `${mode}_${stamp}.jpg`);

  await createInstagramSafeImage(originalImage, instagramImage);

  const pending = {
    type: "photo",
    mode,
    created_at: new Date().toISOString(),
    caption,
    original_image: relativePosix(originalImage),
    instagram_image: relativePosix(instagramImage)
  };

  savePending(pending);
  log("Pending photo post saved.");
}

async function prepareReelPost() {
  const reelImage = pickOneImage(REELS_SOURCE_DIR, "reel");
  const music = pickMusicRotation();

  const caption = await generateCaption("reel", reelImage);
  const overlayText = await generateOverlayText("reel", reelImage);

  const stamp = Date.now();
  const reelVideo = path.join(REELS_OUTPUT_ROOT, `reel_${stamp}.mp4`);

  await createReelFromPhoto(reelImage, music, reelVideo, overlayText);

  const pending = {
    type: "reel",
    mode: "reel",
    created_at: new Date().toISOString(),
    caption,
    overlay_text: overlayText,
    original_image: relativePosix(reelImage),
    music_used: relativePosix(music),
    reel_video: relativePosix(reelVideo)
  };

  savePending(pending);
  log("Pending Reel post saved.");
}

async function publishInstagramPhoto(imageUrl, caption) {
  const igUserId = getEnv("IG_USER_ID");

  const container = await graphPost(`${igUserId}/media`, {
    image_url: imageUrl,
    caption
  });

  if (!container.id) {
    throw new Error(`Instagram photo container missing ID: ${JSON.stringify(container)}`);
  }

  log(`Instagram photo container created: ${container.id}`);

  await new Promise((resolve) => setTimeout(resolve, 10000));

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

function updateHistory(entry) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) {
    history.posted = [];
  }

  if (!Array.isArray(history.used_music)) {
    history.used_music = [];
  }

  history.posted.push(entry);

  if (entry.music_used) {
    history.used_music.push(entry.music_used);
    history.used_music = history.used_music.slice(-20);
  }

  saveHistory(history);
}

async function publishPendingPost() {
  ensureFiles();
  await testAccounts();

  const pending = loadPending();

  if (!pending || !pending.type || !pending.caption) {
    throw new Error("No pending post found. Run prepare step first.");
  }

  const caption = pending.caption;
  const results = {};
  const postedAt = new Date().toISOString();

  log("Generated caption:");
  log(caption);

  if (pending.type === "photo") {
    const originalPath = path.join(ROOT, pending.original_image);
    const instagramPath = path.join(ROOT, pending.instagram_image);

    if (!fs.existsSync(originalPath)) {
      throw new Error(`Original photo missing: ${originalPath}`);
    }

    if (!fs.existsSync(instagramPath)) {
      throw new Error(`Instagram image missing: ${instagramPath}`);
    }

    const facebookUrl = rawGithubUrl(originalPath);
    const instagramUrl = rawGithubUrl(instagramPath);

    log(`Facebook original photo URL: ${facebookUrl}`);
    log(`Instagram processed photo URL: ${instagramUrl}`);

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
    const originalPath = path.join(ROOT, pending.original_image);
    const reelPath = path.join(ROOT, pending.reel_video);

    if (!fs.existsSync(originalPath)) {
      throw new Error(`Original reel photo missing: ${originalPath}`);
    }

    if (!fs.existsSync(reelPath)) {
      throw new Error(`Reel video missing: ${reelPath}`);
    }

    const reelUrl = rawGithubUrl(reelPath);

    log(`Reel video URL: ${reelUrl}`);

    results.facebookVideo = await publishFacebookVideo(reelUrl, caption);
    results.instagramReel = await publishInstagramReel(reelUrl, caption);

    updateHistory({
      type: "reel",
      mode: pending.mode,
      posted_at: postedAt,
      caption,
      overlay_text: pending.overlay_text,
      original_image: pending.original_image,
      music_used: pending.music_used,
      reel_video: pending.reel_video,
      results
    });

    safeDelete(originalPath);
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

    if (mode === "reel") {
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
