// scripts/auto-post.js

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.cwd();

const MEDIA_DIR = path.join(ROOT, "media");
const DATA_DIR = path.join(ROOT, "data");

const REELS_DIR = path.join(MEDIA_DIR, "reels");
const MORNING_DIR = path.join(MEDIA_DIR, "morning");
const EVENING_DIR = path.join(MEDIA_DIR, "evening");
const MUSIC_DIR = path.join(MEDIA_DIR, "music");
const GENERATED_REELS_DIR = path.join(MEDIA_DIR, "_reels");
const POSTED_DIR = path.join(MEDIA_DIR, "posted");

const PREPARED_FILE = path.join(DATA_DIR, "prepared-post.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"];

const FB_PAGE_ID = process.env.FB_PAGE_ID;
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || "main";

const MANUAL_MODE = process.env.MANUAL_MODE || "auto";

// Set this only if you want overlay.
// Example GitHub secret/env:
// REEL_TEXT_OVERLAY=Vibes ✨
// If empty, no overlay will be added.
const REEL_TEXT_OVERLAY = process.env.REEL_TEXT_OVERLAY || "";

function ensureFolders() {
  [
    MEDIA_DIR,
    DATA_DIR,
    REELS_DIR,
    MORNING_DIR,
    EVENING_DIR,
    MUSIC_DIR,
    GENERATED_REELS_DIR,
    POSTED_DIR,
  ].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([], null, 2));
  }
}

function log(...args) {
  console.log("[BOT]", ...args);
}

function fail(message) {
  console.error("[BOT] ERROR:", message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listFiles(dir, extensions) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((file) => {
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) return false;
      const ext = path.extname(file).toLowerCase();
      return extensions.includes(ext);
    })
    .map((file) => path.join(dir, file));
}

function pickRandom(files) {
  if (!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

function normalizePath(filePath) {
  return filePath.replace(ROOT + path.sep, "").replace(/\\/g, "/");
}

function rawGithubUrl(relativePath) {
  if (!GITHUB_REPOSITORY) {
    fail("GITHUB_REPOSITORY env missing.");
  }

  const cleanPath = relativePath.replace(/\\/g, "/");
  const encodedPath = cleanPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_REF_NAME}/${encodedPath}`;
}

function detectMode() {
  if (MANUAL_MODE && MANUAL_MODE !== "auto") return MANUAL_MODE;

  const now = new Date();
  const indiaTime = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );

  const hour = indiaTime.getHours();
  const minute = indiaTime.getMinutes();

  log(`India time detected: ${hour}:${String(minute).padStart(2, "0")}`);

  if (hour >= 6 && hour <= 8) return "morning_photo";
  if (hour >= 18 && hour <= 20) return "evening_photo";

  return "reel";
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeHistory(entry) {
  const history = readHistory();
  history.push({
    ...entry,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function removeFileSafe(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    log("Could not remove file:", filePath, err.message);
  }
}

function basicCaption(mode) {
  const captions = {
    morning_photo:
      "New day, new energy ✨ #morningvibes #lifestyle #dailylook #positivevibes #fashion",
    evening_photo:
      "Evening mood, soft lights ✨ #eveningvibes #lifestyle #streetstyle #fashion #aesthetic",
    reel:
      "Sipping into the moment ✨ #urbanvibes #streetstyle #fashionforward #lifestyle #reels",
  };

  return captions[mode] || captions.reel;
}

function cleanOverlayText(input) {
  if (!input || !input.trim()) return "";

  const emojiMatch =
    input.match(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
    )?.[0] || "✨";

  const withoutEmoji = input
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[^a-zA-Z]/g, " ")
    .trim();

  const word = withoutEmoji.split(/\s+/)[0] || "Vibes";

  return `${word} ${emojiMatch}`;
}

function escapeDrawText(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function createReelVideo(imagePath, musicPath) {
  const timestamp = Date.now();
  const outputPath = path.join(GENERATED_REELS_DIR, `reel_${timestamp}.mp4`);

  const overlayText = cleanOverlayText(REEL_TEXT_OVERLAY);

  const baseVideoFilter =
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p";

  let videoFilter = baseVideoFilter;

  if (overlayText) {
    const safeText = escapeDrawText(overlayText);

    videoFilter +=
      `,drawtext=text='${safeText}'` +
      ":fontcolor=white" +
      ":fontsize=76" +
      ":borderw=4" +
      ":bordercolor=black" +
      ":x=(w-text_w)/2" +
      ":y=h-260";
  }

  log("Creating reel video...");
  log("Overlay:", overlayText ? overlayText : "No overlay");

  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      imagePath,
      "-i",
      musicPath,
      "-t",
      "12",
      "-vf",
      videoFilter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      outputPath,
    ],
    { stdio: "inherit" }
  );

  if (!fs.existsSync(outputPath)) {
    fail("Reel video was not created.");
  }

  return outputPath;
}

function prepareContent() {
  ensureFolders();

  const mode = detectMode();
  log("Selected mode:", mode);

  let prepared = {
    mode,
    caption: basicCaption(mode),
    createdAt: new Date().toISOString(),
  };

  if (mode === "reel") {
    const reelImages = listFiles(REELS_DIR, IMAGE_EXTENSIONS);
    const musicFiles = listFiles(MUSIC_DIR, MUSIC_EXTENSIONS);

    if (!reelImages.length) {
      fail(`Need at least 1 image in ${normalizePath(REELS_DIR)} for reel. Found 0.`);
    }

    if (!musicFiles.length) {
      fail(`Need at least 1 music file inside ${normalizePath(MUSIC_DIR)}/ for Reels.`);
    }

    const selectedImage = pickRandom(reelImages);
    const selectedMusic = pickRandom(musicFiles);

    log("Selected reel image:", normalizePath(selectedImage));
    log("Selected music:", normalizePath(selectedMusic));

    const videoPath = createReelVideo(selectedImage, selectedMusic);

    prepared = {
      ...prepared,
      type: "reel",
      sourceImagePath: normalizePath(selectedImage),
      sourceMusicPath: normalizePath(selectedMusic),
      videoPath: normalizePath(videoPath),
    };
  }

  if (mode === "morning_photo") {
    const photos = listFiles(MORNING_DIR, IMAGE_EXTENSIONS);

    if (!photos.length) {
      fail(`Need at least 1 image inside ${normalizePath(MORNING_DIR)}/`);
    }

    const selectedPhoto = pickRandom(photos);
    log("Selected morning photo:", normalizePath(selectedPhoto));

    prepared = {
      ...prepared,
      type: "photo",
      sourceImagePath: normalizePath(selectedPhoto),
    };
  }

  if (mode === "evening_photo") {
    const photos = listFiles(EVENING_DIR, IMAGE_EXTENSIONS);

    if (!photos.length) {
      fail(`Need at least 1 image inside ${normalizePath(EVENING_DIR)}/`);
    }

    const selectedPhoto = pickRandom(photos);
    log("Selected evening photo:", normalizePath(selectedPhoto));

    prepared = {
      ...prepared,
      type: "photo",
      sourceImagePath: normalizePath(selectedPhoto),
    };
  }

  fs.writeFileSync(PREPARED_FILE, JSON.stringify(prepared, null, 2));

  log("Prepared content saved:", normalizePath(PREPARED_FILE));
  log("Prepared data:", prepared);
}

async function graphGet(url) {
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) {
    throw new Error(JSON.stringify(data.error));
  }

  return data;
}

async function graphPost(url, params = {}) {
  const body = new URLSearchParams(params);

  const res = await fetch(url, {
    method: "POST",
    body,
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(JSON.stringify(data.error));
  }

  return data;
}

async function checkAccounts() {
  if (!FB_PAGE_ID) fail("FB_PAGE_ID secret missing.");
  if (!FB_PAGE_ACCESS_TOKEN) fail("FB_PAGE_ACCESS_TOKEN secret missing.");
  if (!IG_USER_ID) fail("IG_USER_ID secret missing.");

  const pageUrl = `https://graph.facebook.com/v20.0/${FB_PAGE_ID}?fields=id,name&access_token=${FB_PAGE_ACCESS_TOKEN}`;
  const igUrl = `https://graph.facebook.com/v20.0/${IG_USER_ID}?fields=id,username&access_token=${FB_PAGE_ACCESS_TOKEN}`;

  const page = await graphGet(pageUrl);
  const instagram = await graphGet(igUrl);

  log("Facebook Page OK:", JSON.stringify(page));
  log("Instagram OK:", JSON.stringify(instagram));
}

async function waitForInstagramContainer(containerId) {
  log("Waiting for Instagram media processing...");

  for (let i = 1; i <= 30; i++) {
    const url =
      `https://graph.facebook.com/v20.0/${containerId}` +
      `?fields=status_code,status` +
      `&access_token=${FB_PAGE_ACCESS_TOKEN}`;

    const data = await graphGet(url);

    log(`Instagram status check ${i}:`, JSON.stringify(data));

    if (data.status_code === "FINISHED") {
      log("Instagram media processing finished.");
      return;
    }

    if (data.status_code === "ERROR") {
      throw new Error("Instagram media processing failed: " + JSON.stringify(data));
    }

    await sleep(15000);
  }

  throw new Error("Instagram media was not ready after waiting.");
}

async function publishFacebookPhoto(imageUrl, caption) {
  const url = `https://graph.facebook.com/v20.0/${FB_PAGE_ID}/photos`;

  const data = await graphPost(url, {
    url: imageUrl,
    caption,
    access_token: FB_PAGE_ACCESS_TOKEN,
  });

  log("Facebook photo published:", JSON.stringify(data));
  return data;
}

async function publishFacebookVideo(videoUrl, caption) {
  const url = `https://graph.facebook.com/v20.0/${FB_PAGE_ID}/videos`;

  const data = await graphPost(url, {
    file_url: videoUrl,
    description: caption,
    access_token: FB_PAGE_ACCESS_TOKEN,
  });

  log("Facebook video published:", JSON.stringify(data));
  return data;
}

async function createInstagramPhotoContainer(imageUrl, caption) {
  const url = `https://graph.facebook.com/v20.0/${IG_USER_ID}/media`;

  const data = await graphPost(url, {
    image_url: imageUrl,
    caption,
    access_token: FB_PAGE_ACCESS_TOKEN,
  });

  log("Instagram photo container created:", data.id);
  return data.id;
}

async function createInstagramReelContainer(videoUrl, caption) {
  const url = `https://graph.facebook.com/v20.0/${IG_USER_ID}/media`;

  const data = await graphPost(url, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
    access_token: FB_PAGE_ACCESS_TOKEN,
  });

  log("Instagram Reel container created:", data.id);
  return data.id;
}

async function publishInstagramContainer(creationId) {
  await waitForInstagramContainer(creationId);

  const url = `https://graph.facebook.com/v20.0/${IG_USER_ID}/media_publish`;

  const data = await graphPost(url, {
    creation_id: creationId,
    access_token: FB_PAGE_ACCESS_TOKEN,
  });

  log("Instagram published:", JSON.stringify(data));
  return data;
}

function cleanupPreparedFiles(prepared) {
  if (!prepared) return;

  if (prepared.type === "reel") {
    removeFileSafe(path.join(ROOT, prepared.sourceImagePath));
    removeFileSafe(path.join(ROOT, prepared.videoPath));

    // Music is not deleted so it can be reused.
    // To delete music after every reel, uncomment:
    // removeFileSafe(path.join(ROOT, prepared.sourceMusicPath));
  }

  if (prepared.type === "photo") {
    removeFileSafe(path.join(ROOT, prepared.sourceImagePath));
  }

  removeFileSafe(PREPARED_FILE);
}

async function publishContent() {
  ensureFolders();

  if (!fs.existsSync(PREPARED_FILE)) {
    fail("No prepared-post.json found. Run prepare first.");
  }

  const prepared = JSON.parse(fs.readFileSync(PREPARED_FILE, "utf8"));

  await checkAccounts();

  const caption = prepared.caption || basicCaption(prepared.mode);

  if (prepared.type === "reel") {
    const videoUrl = rawGithubUrl(prepared.videoPath);

    log("Generated caption:");
    log(`"${caption}"`);

    log("Reel video URL:", videoUrl);

    await publishFacebookVideo(videoUrl, caption);

    const creationId = await createInstagramReelContainer(videoUrl, caption);

    await publishInstagramContainer(creationId);

    writeHistory({
      type: "reel",
      mode: prepared.mode,
      caption,
      videoPath: prepared.videoPath,
      sourceImagePath: prepared.sourceImagePath,
      sourceMusicPath: prepared.sourceMusicPath,
      status: "published",
    });

    cleanupPreparedFiles(prepared);

    log("Reel published and cleanup completed.");
    return;
  }

  if (prepared.type === "photo") {
    const imageUrl = rawGithubUrl(prepared.sourceImagePath);

    log("Generated caption:");
    log(`"${caption}"`);

    log("Photo URL:", imageUrl);

    await publishFacebookPhoto(imageUrl, caption);

    const creationId = await createInstagramPhotoContainer(imageUrl, caption);

    await publishInstagramContainer(creationId);

    writeHistory({
      type: "photo",
      mode: prepared.mode,
      caption,
      sourceImagePath: prepared.sourceImagePath,
      status: "published",
    });

    cleanupPreparedFiles(prepared);

    log("Photo published and cleanup completed.");
    return;
  }

  fail("Unknown prepared content type.");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--prepare-only")) {
    prepareContent();
    return;
  }

  if (args.includes("--publish-only")) {
    await publishContent();
    return;
  }

  prepareContent();
  await publishContent();
}

main().catch((err) => {
  console.error("[BOT] ERROR:", err.message);
  process.exit(1);
});
