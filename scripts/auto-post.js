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

const REEL_DURATION_SECONDS = Number(process.env.REEL_DURATION_SECONDS || 9);
const REEL_FPS = 30;

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

  if (totalMinutes >= 390 && totalMinutes <= 480) {
    return "morning_photo";
  }

  if (totalMinutes >= 1140 && totalMinutes <= 1230) {
    return "evening_photo";
  }

  return "reel";
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

function findImageFilesRecursive(folder) {
  if (!fs.existsSync(folder)) return [];

  const output = [];
  const items = fs.readdirSync(folder, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(folder, item.name);

    if (item.isDirectory()) {
      output.push(...findImageFilesRecursive(fullPath));
    } else if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();

      if (IMAGE_EXTENSIONS.includes(ext) && !item.name.startsWith(".")) {
        output.push(fullPath);
      }
    }
  }

  return output.sort();
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

function pickOneImage(folder, label) {
  const images = findFiles(folder, IMAGE_EXTENSIONS);

  if (images.length < 1) {
    throw new Error(`Need at least 1 image in ${folder} for ${label}. Found 0.`);
  }

  const selected = images[Math.floor(Math.random() * images.length)];

  log(`Selected ${label} image: ${selected}`);

  return selected;
}

function pickTwoReelPhotos() {
  const sceneFolders = getReelSceneFolders();

  if (sceneFolders.length > 0) {
    const folder = sceneFolders[Math.floor(Math.random() * sceneFolders.length)];
    const images = findFiles(folder, IMAGE_EXTENSIONS);

    const shuffled = [...images].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 2);

    log(`Selected reel scene folder: ${folder}`);
    log(`Selected reel photo 1: ${selected[0]}`);
    log(`Selected reel photo 2: ${selected[1]}`);

    return selected;
  }

  const allImages = findImageFilesRecursive(REELS_SOURCE_DIR);

  if (allImages.length < 2) {
    throw new Error(
      `Need at least 2 images inside ${REELS_SOURCE_DIR}. Add images directly or create folders like media/reels/reel001/1.jpg and 2.jpg.`
    );
  }

  const shuffled = [...allImages].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 2);

  log("No reel scene folder found, using any 2 reel images.");
  log(`Selected reel photo 1: ${selected[0]}`);
  log(`Selected reel photo 2: ${selected[1]}`);

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

async function analyzeReelPhotosWithVision(imagePaths) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    return "No reel visual analysis available because NVIDIA_API_KEY is missing.";
  }

  const visionModel =
    process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";

  const content = [
    {
      type: "text",
      text: `
Look at these two photos for a short influencer reel.

Describe:
- whether both photos feel like the same scene/story
- location/background
- outfit and vibe
- best reel mood: travel, home, cafe, office, gym, night, party, casual, morning, evening
- best clean caption angle
- 5 to 9 hashtags

Safety:
- Do not identify any real person.
- Do not use adult or explicit wording.
- Keep it clean and Instagram friendly.
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
        messages: [
          {
            role: "user",
            content
          }
        ],
        temperature: 0.35,
        max_tokens: 650
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      log(`NVIDIA reel vision error: ${JSON.stringify(data)}`);
      return "No reel visual analysis available.";
    }

    return data.choices[0].message.content.trim() || "No reel visual analysis available.";
  } catch (error) {
    log(`NVIDIA reel vision failed: ${error.message}`);
    return "No reel visual analysis available.";
  }
}

async function generateCaption(mode, imagePathOrPaths) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);

  if (!apiKey) {
    log("NVIDIA_API_KEY missing. Using fallback caption.");
    return fallbackCaption(mode);
  }

  const isReelArray = Array.isArray(imagePathOrPaths);
  const visualAnalysis = isReelArray
    ? await analyzeReelPhotosWithVision(imagePathOrPaths)
    : await analyzePhotoWithVision(imagePathOrPaths, mode);

  const recentCaptions = getRecentCaptions(15);

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

Last 15 captions:
${recentCaptionText}

Rules:
- Caption must match the actual photo/reel vibe, outfit, background, color, and mood
- Short: 1 or 2 lines only
- Clean influencer vibe
- Soft, stylish, natural, confident
- Hinglish + English mix is okay, but keep it classy
- Not too professional, not too childish
- No long paragraph
- No robotic CTA
- Do not repeat old captions
- Do not repeat the same hook line
- Use only 5 to 9 hashtags
- Hashtags must relate to actual photo/reel
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
  await sharp(sourcePath)
    .rotate()
    .resize(1080, 1350, {
      fit: "cover",
      position: "attention"
    })
    .jpeg({
      quality: 95
    })
    .toFile(outputPath);

  log(`Created full-frame Instagram photo without blur: ${outputPath}`);
}

async function createFullFrameReelImage(sourcePath, outputPath) {
  await sharp(sourcePath)
    .rotate()
    .resize(1080, 1920, {
      fit: "cover",
      position: "attention"
    })
    .modulate({
      brightness: 1.02,
      saturation: 1.05
    })
    .sharpen({
      sigma: 0.6,
      m1: 0.7,
      m2: 0.25
    })
    .jpeg({
      quality: 95
    })
    .toFile(outputPath);

  log(`Created full-frame reel image without blur: ${outputPath}`);
}

function pickTransitionStyle() {
  const styles = [
    {
      name: "aircraft_hatch_sunrise",
      xfade: "circleopen",
      color: "eq=contrast=1.08:saturation=1.18:brightness=0.02",
      extra:
        "drawbox=x=0:y=0:w=iw:h=ih:color=0x55ccff@0.04:t=fill,drawbox=x=0:y=ih*0.76:w=iw:h=ih*0.24:color=0xffcc88@0.06:t=fill"
    },
    {
      name: "camera_fly_through",
      xfade: "zoomin",
      color: "eq=contrast=1.06:saturation=1.12:brightness=0.015",
      extra: "vignette=PI/5"
    },
    {
      name: "portal_open",
      xfade: "circleopen",
      color: "eq=contrast=1.1:saturation=1.15:brightness=0.02",
      extra: "drawbox=x=0:y=0:w=iw:h=ih:color=0x9966ff@0.035:t=fill"
    },
    {
      name: "smooth_creator_cut",
      xfade: "smoothleft",
      color: "eq=contrast=1.04:saturation=1.08:brightness=0.01",
      extra: "vignette=PI/7"
    }
  ];

  return styles[Math.floor(Math.random() * styles.length)];
}

async function createReelFromTwoPhotos(imagePaths, musicPath, outputPath) {
  const [imageOne, imageTwo] = imagePaths;

  const stamp = Date.now();
  const frameOne = path.join(REELS_OUTPUT_ROOT, `frame_one_${stamp}.jpg`);
  const frameTwo = path.join(REELS_OUTPUT_ROOT, `frame_two_${stamp}.jpg`);

  await createFullFrameReelImage(imageOne, frameOne);
  await createFullFrameReelImage(imageTwo, frameTwo);

  const transition = pickTransitionStyle();

  const firstDuration = 5;
  const secondDuration = 5;
  const transitionDuration = 1;
  const transitionOffset = 4;

  const filterComplex = `
[0:v]scale=1080:1920,setsar=1,fps=${REEL_FPS},format=yuv420p,${transition.color},${transition.extra},zoompan=z='min(1.00+0.0008*on,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${firstDuration * REEL_FPS}:s=1080x1920:fps=${REEL_FPS},trim=duration=${firstDuration},setpts=PTS-STARTPTS[v0];
[1:v]scale=1080:1920,setsar=1,fps=${REEL_FPS},format=yuv420p,${transition.color},${transition.extra},zoompan=z='max(1.05-0.0008*on,1.00)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${secondDuration * REEL_FPS}:s=1080x1920:fps=${REEL_FPS},trim=duration=${secondDuration},setpts=PTS-STARTPTS[v1];
[v0][v1]xfade=transition=${transition.xfade}:duration=${transitionDuration}:offset=${transitionOffset},trim=duration=${REEL_DURATION_SECONDS},setpts=PTS-STARTPTS[v]
`.replace(/\s+/g, " ").trim();

  const args = [
    "-y",

    "-loop",
    "1",
    "-t",
    String(firstDuration),
    "-i",
    frameOne,

    "-loop",
    "1",
    "-t",
    String(secondDuration),
    "-i",
    frameTwo,

    "-stream_loop",
    "-1",
    "-i",
    musicPath,

    "-filter_complex",
    filterComplex,

    "-map",
    "[v]",

    "-map",
    "2:a",

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

  log("Creating cinematic 2-photo Reel...");
  log(`Transition style: ${transition.name}`);
  log("Full-frame 9:16 enabled.");
  log("Blur background disabled.");
  log("Text overlay disabled.");

  await execFileAsync("ffmpeg", args, {
    maxBuffer: 1024 * 1024 * 30
  });

  safeDelete(frameOne);
  safeDelete(frameTwo);

  log(`Created cinematic Reel video: ${outputPath}`);

  return transition.name;
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
  const reelPhotos = pickTwoReelPhotos();
  const music = pickMusicRotation();

  const caption = await generateCaption("reel", reelPhotos);

  const stamp = Date.now();
  const reelVideo = path.join(REELS_OUTPUT_ROOT, `reel_${stamp}.mp4`);

  const transitionStyle = await createReelFromTwoPhotos(reelPhotos, music, reelVideo);

  const pending = {
    type: "reel",
    mode: "reel",
    created_at: new Date().toISOString(),
    caption,
    transition_style: transitionStyle,
    original_images: reelPhotos.map(relativePosix),
    music_used: relativePosix(music),
    reel_video: relativePosix(reelVideo)
  };

  savePending(pending);

  log("Pending cinematic Reel post saved.");
}

async function waitForInstagramMedia(containerId) {
  log(`Waiting for Instagram media processing: ${containerId}`);

  for (let attempt = 1; attempt <= 40; attempt++) {
    const status = await graphGet(containerId, {
      fields: "status_code,status"
    });

    log(`Instagram media status attempt ${attempt}: ${JSON.stringify(status)}`);

    if (status.status_code === "FINISHED") {
      log("Instagram media is ready to publish.");
      return;
    }

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

  if (!container.id) {
    throw new Error(`Instagram photo container missing ID: ${JSON.stringify(container)}`);
  }

  log(`Instagram photo container created: ${container.id}`);

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

  if (!container.id) {
    throw new Error(`Instagram Reel container missing ID: ${JSON.stringify(container)}`);
  }

  log(`Instagram Reel container created: ${container.id}`);

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

function safeDeleteMany(filePaths) {
  for (const filePath of filePaths) {
    safeDelete(filePath);
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
    const reelPath = path.join(ROOT, pending.reel_video);

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
      transition_style: pending.transition_style || "",
      original_images: pending.original_images || [],
      music_used: pending.music_used,
      reel_video: pending.reel_video,
      results
    });

    if (Array.isArray(pending.original_images)) {
      safeDeleteMany(pending.original_images.map((file) => path.join(ROOT, file)));
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
