import fs from "fs";
import path from "path";
import crypto from "crypto";
import sharp from "sharp";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;
const NVIDIA_URL = process.env.NVIDIA_API_URL || "https://integrate.api.nvidia.com/v1/chat/completions";

const ROOT = process.cwd();
const MEDIA_ROOT = path.join(ROOT, "media");
const DATA_ROOT = path.join(ROOT, "data");

const LEGACY_MORNING_DIR = path.join(MEDIA_ROOT, "morning");
const LEGACY_EVENING_DIR = path.join(MEDIA_ROOT, "evening");
const LEGACY_REELS_DIR = path.join(MEDIA_ROOT, "reels");
const VIDEO_SOURCE_DIR = path.join(MEDIA_ROOT, "videos");
const MUSIC_DIR = path.join(MEDIA_ROOT, "music");

const PHOTOS_ROOT = path.join(MEDIA_ROOT, "photos");
const INCOMING_DIR = path.join(PHOTOS_ROOT, "incoming");
const USED_DIR = path.join(PHOTOS_ROOT, "used");
const REJECTED_DIR = path.join(PHOTOS_ROOT, "rejected");
const PLANNED_DIR = path.join(PHOTOS_ROOT, "planned");

const IG_READY_ROOT = path.join(MEDIA_ROOT, "_ig_ready");
const REELS_OUTPUT_ROOT = path.join(MEDIA_ROOT, "_reels");
const CLOUD_CACHE_DIR = path.join(MEDIA_ROOT, "_cloud_cache");

const HISTORY_FILE = path.join(DATA_ROOT, "posted_history.json");
const PENDING_FILE = path.join(DATA_ROOT, "pending_post.json");
const LIBRARY_FILE = path.join(DATA_ROOT, "content_library.json");
const CALENDAR_FILE = path.join(DATA_ROOT, "content_calendar.json");
const PROFILE_FILE = path.join(DATA_ROOT, "influencer_profile.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"];
const MUSIC_EXTENSIONS = [".mp3", ".m4a", ".aac", ".wav"];

const DEFAULT_PROFILE = {
  influencer_name: "Tara Suri",
  identity: "clean travel, fashion and lifestyle creator",
  language_style: "natural English with light Hinglish only when it feels human",
  current_story_arc: "Bali girls trip",
  safety: "clean, non-explicit, no fake brand claims, no real-person identification",
  caption_rules: [
    "short, human, not robotic",
    "1 to 3 lines before hashtags",
    "do not repeat the last 15 captions",
    "make it feel like a real trip diary, not an ad",
    "include SEO-friendly hashtags that match the photo"
  ]
};

const DEFAULT_CALENDAR = {
  slots: {
    morning_photo: {
      label: "morning",
      categories: ["morning", "breakfast", "coffee", "pool", "villa", "beach", "sunrise", "bedroom", "balcony"],
      captionMood: "soft morning travel diary"
    },
    afternoon_photo: {
      label: "afternoon",
      categories: ["market", "cafe", "shopping", "street", "travel", "temple", "rice_fields", "beach", "food"],
      captionMood: "real daytime exploring"
    },
    evening_photo: {
      label: "evening",
      categories: ["sunset", "dinner", "villa", "beach", "pool", "city", "night"],
      captionMood: "golden evening, calm, cinematic"
    },
    night_photo: {
      label: "night",
      categories: ["night", "bedroom", "hotel", "party", "dinner", "city", "cozy"],
      captionMood: "cozy night diary"
    },
    reel: {
      label: "reel",
      categories: ["travel", "girls_trip", "photo_dump", "pool", "market", "beach", "villa", "food", "sunset"],
      captionMood: "viral travel reel, girls trip recap"
    },
    story: {
      label: "story",
      categories: ["morning", "food", "coffee", "pool", "market", "sunset", "night", "behind_the_scenes"],
      captionMood: "short story text"
    }
  },
  realLifeCycle: [
    { start: "06:00", end: "09:30", mode: "morning_photo" },
    { start: "09:31", end: "15:59", mode: "afternoon_photo" },
    { start: "16:00", end: "20:30", mode: "evening_photo" },
    { start: "20:31", end: "23:59", mode: "night_photo" },
    { start: "00:00", end: "05:59", mode: "reel" }
  ]
};

function log(message) {
  console.log(`[AI MANAGER] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getEnv(name, required = true, fallback = "") {
  const value = process.env[name] || fallback;
  if (required && !value) throw new Error(`Missing GitHub Secret / environment variable: ${name}`);
  return value;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function ensureFiles() {
  [
    DATA_ROOT,
    MEDIA_ROOT,
    LEGACY_MORNING_DIR,
    LEGACY_EVENING_DIR,
    LEGACY_REELS_DIR,
    VIDEO_SOURCE_DIR,
    MUSIC_DIR,
    PHOTOS_ROOT,
    INCOMING_DIR,
    USED_DIR,
    REJECTED_DIR,
    PLANNED_DIR,
    IG_READY_ROOT,
    REELS_OUTPUT_ROOT,
    CLOUD_CACHE_DIR
  ].forEach(ensureDir);

  if (!fs.existsSync(HISTORY_FILE)) writeJson(HISTORY_FILE, { posted: [], used_music: [] });
  if (!fs.existsSync(PENDING_FILE)) writeJson(PENDING_FILE, {});
  if (!fs.existsSync(LIBRARY_FILE)) writeJson(LIBRARY_FILE, { assets: [] });
  if (!fs.existsSync(CALENDAR_FILE)) writeJson(CALENDAR_FILE, DEFAULT_CALENDAR);
  if (!fs.existsSync(PROFILE_FILE)) writeJson(PROFILE_FILE, DEFAULT_PROFILE);
}

function indiaNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function minutesFromHHMM(value) {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

function detectMode() {
  const manualMode = (process.env.MANUAL_MODE || "").toLowerCase().trim();
  const valid = ["auto", "morning_photo", "afternoon_photo", "evening_photo", "night_photo", "reel", "story"];
  if (valid.includes(manualMode) && manualMode !== "auto") return manualMode;

  const now = indiaNow();
  const total = now.getUTCHours() * 60 + now.getUTCMinutes();
  const calendar = readJson(CALENDAR_FILE, DEFAULT_CALENDAR);
  const cycle = calendar.realLifeCycle || DEFAULT_CALENDAR.realLifeCycle;

  for (const slot of cycle) {
    const start = minutesFromHHMM(slot.start);
    const end = minutesFromHHMM(slot.end);
    if (start <= end && total >= start && total <= end) return slot.mode;
    if (start > end && (total >= start || total <= end)) return slot.mode;
  }

  return "reel";
}

function relativePosix(localPath) {
  return path.relative(ROOT, localPath).split(path.sep).join("/");
}

function absoluteFromRelative(relativePath) {
  return path.join(ROOT, relativePath);
}

function rawGithubUrl(localPath) {
  const repo = getEnv("GITHUB_REPOSITORY");
  const branch = getEnv("GITHUB_REF_NAME", false, "main");
  const relative = relativePosix(localPath);
  const encoded = relative.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`;
}

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function findFiles(folder, extensions, recursive = true) {
  if (!fs.existsSync(folder)) return [];
  const results = [];
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    if (item.name.startsWith(".")) continue;
    const full = path.join(folder, item.name);
    if (item.isDirectory() && recursive) results.push(...findFiles(full, extensions, recursive));
    if (item.isFile() && extensions.includes(path.extname(item.name).toLowerCase())) results.push(full);
  }
  return results.sort();
}

function cleanCaptionText(text) {
  return String(text || "")
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/```$/i, "")
    .replace(/^['\"]|['\"]$/g, "")
    .trim();
}

function loadHistory() {
  ensureFiles();
  const history = readJson(HISTORY_FILE, { posted: [], used_music: [] });
  if (!Array.isArray(history.posted)) history.posted = [];
  if (!Array.isArray(history.used_music)) history.used_music = [];
  return history;
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

function getRecentCaptions(limit = 15) {
  return loadHistory().posted
    .filter((item) => item.caption && typeof item.caption === "string")
    .slice(-limit)
    .map((item) => item.caption);
}

function normalizeCategory(value) {
  const v = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (["sunrise", "breakfast", "coffee", "pool", "villa", "balcony"].includes(v)) return "morning";
  if (["sunset", "dinner", "golden_hour"].includes(v)) return "evening";
  if (["hotel_room", "bed", "room"].includes(v)) return "bedroom";
  return v || "lifestyle";
}

function keywordCategories(filePath) {
  const name = relativePosix(filePath).toLowerCase();
  const map = [
    ["morning", ["morning", "sunrise", "breakfast", "coffee", "chai"]],
    ["evening", ["evening", "sunset", "golden", "dinner"]],
    ["night", ["night", "bed", "bedroom", "hotel", "room"]],
    ["pool", ["pool", "swim", "villa"]],
    ["market", ["market", "shopping", "bazaar"]],
    ["cafe", ["cafe", "coffee", "smoothie", "breakfast", "food"]],
    ["beach", ["beach", "ocean", "sea", "surf"]],
    ["temple", ["temple", "mandir"]],
    ["travel", ["travel", "scooter", "cycle", "road", "airport"]],
    ["girls_trip", ["friend", "friends", "bestie", "girls"]],
    ["rice_fields", ["rice", "ubud", "field"]]
  ];
  const found = [];
  for (const [cat, words] of map) {
    if (words.some((word) => name.includes(word))) found.push(cat);
  }
  return found;
}

async function imageMeta(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    const ratio = width && height ? width / height : 1;
    return { width, height, ratio, format: meta.format || path.extname(filePath).slice(1) };
  } catch {
    return { width: 0, height: 0, ratio: 1, format: path.extname(filePath).slice(1) };
  }
}

function imageDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const b64 = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${b64}`;
}

async function nvidiaChat({ messages, model, temperature = 0.5, max_tokens = 700 }) {
  const apiKey = getEnv("NVIDIA_API_KEY", false);
  if (!apiKey) return null;

  try {
    const response = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.choices?.[0]?.message?.content) {
      log(`NVIDIA error: ${JSON.stringify(data).slice(0, 800)}`);
      return null;
    }
    return data.choices[0].message.content.trim();
  } catch (error) {
    log(`NVIDIA request failed: ${error.message}`);
    return null;
  }
}

function extractJson(text, fallback) {
  if (!text) return fallback;
  const cleaned = cleanCaptionText(text).replace(/^```json\n?/i, "").replace(/^```\n?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
  }
  return fallback;
}

async function analyzePhoto(filePath, mode = "auto") {
  const meta = await imageMeta(filePath);
  const fallbackCats = keywordCategories(filePath);
  const fallback = {
    description: `${path.basename(filePath)} lifestyle travel photo`,
    categories: fallbackCats.length ? fallbackCats : ["lifestyle"],
    time_of_day: fallbackCats.includes("morning") ? "morning" : fallbackCats.includes("evening") ? "evening" : fallbackCats.includes("night") ? "night" : "day",
    mood: "natural travel lifestyle",
    outfit: "stylish vacation outfit",
    location: "travel location",
    quality_score: 7,
    reel_score: meta.height >= meta.width ? 8 : 6,
    post_score: 7,
    reject: false,
    reason: "filename and image metadata analysis"
  };

  const apiKey = getEnv("NVIDIA_API_KEY", false);
  if (!apiKey) return fallback;

  const prompt = `
You are the social media manager for a clean lifestyle/travel influencer. Analyze this image for posting.
Return ONLY valid JSON. No markdown.

Mode requested: ${mode}
File name: ${path.basename(filePath)}

JSON shape:
{
  "description": "one sentence visual description",
  "categories": ["morning|afternoon|evening|night|pool|villa|market|cafe|food|beach|temple|travel|girls_trip|bedroom|sunset|rice_fields|lifestyle"],
  "time_of_day": "morning|afternoon|evening|night|unknown",
  "mood": "short mood",
  "outfit": "clean outfit description without explicit body wording",
  "location": "likely location/vibe",
  "quality_score": 1-10,
  "reel_score": 1-10,
  "post_score": 1-10,
  "reject": false,
  "reason": "why this should be used or rejected"
}

Safety:
- Do not identify any real person.
- Keep it clean and non-explicit.
- Do not describe private body parts.
- If the image is too low quality, duplicate-looking, very blurry, or unsafe for a normal public lifestyle post, set reject true.
`;

  const result = await nvidiaChat({
    model: process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct",
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl(filePath) } }] }],
    temperature: 0.25,
    max_tokens: 700
  });

  const parsed = extractJson(result, fallback);
  parsed.categories = Array.isArray(parsed.categories) ? parsed.categories.map(normalizeCategory) : fallback.categories;
  parsed.quality_score = Number(parsed.quality_score || fallback.quality_score);
  parsed.reel_score = Number(parsed.reel_score || fallback.reel_score);
  parsed.post_score = Number(parsed.post_score || fallback.post_score);
  parsed.reject = Boolean(parsed.reject);
  return { ...fallback, ...parsed };
}

async function buildContentLibrary(mode) {
  ensureFiles();
  const oldLibrary = readJson(LIBRARY_FILE, { assets: [] });
  const oldByHash = new Map((oldLibrary.assets || []).map((a) => [a.hash, a]));

  const roots = [INCOMING_DIR, LEGACY_MORNING_DIR, LEGACY_EVENING_DIR, LEGACY_REELS_DIR];
  const files = [...new Set(roots.flatMap((dir) => findFiles(dir, IMAGE_EXTENSIONS, true)))]
    .filter((file) => !relativePosix(file).includes("/_ig_ready/") && !relativePosix(file).includes("/_reels/"));

  const postedImages = new Set(loadHistory().posted.flatMap((p) => [p.original_image, p.instagram_image, p.reel_video]).filter(Boolean));
  const assets = [];

  for (const file of files) {
    const rel = relativePosix(file);
    if (postedImages.has(rel)) continue;

    const hash = fileHash(file);
    const existing = oldByHash.get(hash);
    const meta = await imageMeta(file);

    if (existing && existing.path === rel && existing.analysis) {
      assets.push({ ...existing, meta, exists: true });
      continue;
    }

    log(`Analyzing image: ${rel}`);
    const analysis = await analyzePhoto(file, mode);
    assets.push({
      id: hash.slice(0, 12),
      hash,
      path: rel,
      added_at: new Date().toISOString(),
      source: rel.includes("media/photos/incoming") ? "incoming" : "legacy",
      meta,
      analysis,
      used: false
    });
  }

  const library = { updated_at: new Date().toISOString(), assets };
  writeJson(LIBRARY_FILE, library);
  return library;
}

function scoreAssetForMode(asset, mode) {
  const calendar = readJson(CALENDAR_FILE, DEFAULT_CALENDAR);
  const slot = calendar.slots?.[mode] || calendar.slots?.reel || DEFAULT_CALENDAR.slots.reel;
  const cats = new Set(asset.analysis?.categories || []);
  const wanted = slot.categories || [];
  let score = 0;

  for (const cat of wanted) if (cats.has(cat)) score += 4;

  const time = asset.analysis?.time_of_day;
  if (mode.includes("morning") && time === "morning") score += 5;
  if (mode.includes("afternoon") && ["afternoon", "day", "unknown"].includes(time)) score += 3;
  if (mode.includes("evening") && ["evening", "sunset"].includes(time)) score += 5;
  if (mode.includes("night") && time === "night") score += 5;
  if (mode === "reel") score += Number(asset.analysis?.reel_score || 0);
  else score += Number(asset.analysis?.post_score || 0);

  score += Number(asset.analysis?.quality_score || 0);
  if (asset.analysis?.reject) score -= 100;
  if (asset.meta?.height > asset.meta?.width) score += 1;
  if (asset.path.includes("/morning/") && mode === "morning_photo") score += 3;
  if (asset.path.includes("/evening/") && mode === "evening_photo") score += 3;
  if (asset.path.includes("/reels/") && mode === "reel") score += 4;
  return score;
}

function selectBestAsset(library, mode) {
  const candidates = (library.assets || [])
    .filter((a) => a.path && !a.used && !a.analysis?.reject)
    .map((a) => ({ ...a, _score: scoreAssetForMode(a, mode) }))
    .sort((a, b) => b._score - a._score);

  if (!candidates.length) throw new Error(`No usable images found for ${mode}. Add photos to media/photos/incoming, media/morning, media/evening, or media/reels.`);
  log(`Selected ${mode}: ${candidates[0].path} score=${candidates[0]._score}`);
  return candidates[0];
}

function selectReelAssets(library, count = 5) {
  const candidates = (library.assets || [])
    .filter((a) => a.path && !a.used && !a.analysis?.reject)
    .map((a) => ({ ...a, _score: scoreAssetForMode(a, "reel") }))
    .sort((a, b) => b._score - a._score);

  if (candidates.length < 1) throw new Error("No usable reel images found. Add images to media/photos/incoming or media/reels.");
  const max = Math.min(Number(process.env.REEL_IMAGE_COUNT || count), 8, candidates.length);
  const min = Math.min(3, candidates.length);
  return candidates.slice(0, Math.max(min, max));
}

function pickMusicRotation() {
  const musicFiles = findFiles(MUSIC_DIR, MUSIC_EXTENSIONS, true);
  if (musicFiles.length < 1) throw new Error("Need at least 1 music file inside media/music/ for reels.");

  const history = loadHistory();
  const usedMusic = Array.isArray(history.used_music) ? history.used_music : [];
  const lastMusic = usedMusic.length ? usedMusic[usedMusic.length - 1] : null;
  const candidates = musicFiles.length > 1 && lastMusic ? musicFiles.filter((file) => relativePosix(file) !== lastMusic) : musicFiles;
  const selected = candidates[Math.floor(Math.random() * candidates.length)];
  log(`Selected music: ${relativePosix(selected)}`);
  return selected;
}

function fallbackCaption(mode, asset = null) {
  const cats = asset?.analysis?.categories || [];
  if (mode === "morning_photo") return `bali morning, soft light and no rush 🌞🌴\n\n#BaliMorning #BaliGirlsTrip #BaliTravelDiary #IslandLife #TravelAesthetic #TaraSuri`;
  if (mode === "afternoon_photo") return `market walks, coconut bags and little bali moments 🌴🤍\n\n#BaliMarket #BaliGirlsTrip #BaliTravel #TravelDiary #BaliStyle #TaraSuri`;
  if (mode === "evening_photo") return `golden hour in bali really knows what it’s doing ✨\n\n#BaliSunset #BaliEvening #GirlsTripBali #TravelAesthetic #IslandVibes #TaraSuri`;
  if (mode === "night_photo") return `slow night, ocean view, soft little memories 🤍\n\n#BaliNights #VillaLife #TravelDiary #GirlsTrip #CozyVibes #TaraSuri`;
  if (cats.includes("girls_trip")) return `two days in bali with my girl, and the camera roll says everything 🌴🤍\n\n#BaliGirlsTrip #BaliPhotoDump #TravelWithFriends #BaliDiaries #VacationMood #TaraSuri`;
  return `bali camera roll before breakfast 🌞🌴\n\n#BaliReel #BaliPhotoDump #GirlsTripBali #BaliTravelDiary #TropicalVacation #TaraSuri`;
}

async function generatePostCopy(mode, assets) {
  const profile = readJson(PROFILE_FILE, DEFAULT_PROFILE);
  const list = Array.isArray(assets) ? assets : [assets];
  const recentCaptionText = getRecentCaptions(15).map((c, i) => `${i + 1}. ${c}`).join("\n") || "No previous captions yet.";
  const descriptions = list.map((a, i) => `${i + 1}. ${a.path}\nAnalysis: ${JSON.stringify(a.analysis)}`).join("\n\n");

  const prompt = `
You are the social media manager for ${profile.influencer_name}, a ${profile.identity}.
Current story arc: ${profile.current_story_arc}
Post mode: ${mode}
Style: ${profile.language_style}
Safety: ${profile.safety}

Photo/video assets:
${descriptions}

Last 15 captions to avoid repeating:
${recentCaptionText}

Return ONLY valid JSON. No markdown.
{
  "caption": "1-3 natural lines + 7-15 relevant hashtags. Must feel like a real human trip post.",
  "alt_text": "SEO friendly visual alt text, 1 sentence, accurate to the photo(s)",
  "overlay_text": "short reel text, max 7 words",
  "story_text": "short story text, max 9 words",
  "first_comment": "optional short first comment or empty string"
}

Rules:
- Make it feel like a real life cycle, not random AI content.
- Match the actual photo scene: morning/evening/market/pool/villa/cafe/bedroom/friends/beach.
- Clean public Instagram/Facebook wording only.
- No explicit/adult words. Do not describe private body parts.
- No fake sponsorships, no fake claims, no person identification.
- No quotes around final caption.
`;

  const result = await nvidiaChat({
    model: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
    messages: [
      { role: "system", content: "You create clean, natural, SEO-friendly influencer captions and metadata as valid JSON only." },
      { role: "user", content: prompt }
    ],
    temperature: 0.8,
    max_tokens: 650
  });

  const parsed = extractJson(result, null);
  if (!parsed?.caption) {
    return {
      caption: fallbackCaption(mode, list[0]),
      alt_text: `Bali girls trip lifestyle photo showing ${list.map((a) => a.analysis?.description || "travel moment").join(", ")}.`,
      overlay_text: mode === "reel" ? "bali girls trip" : "bali morning",
      story_text: "bali lately 🌴",
      first_comment: ""
    };
  }

  return {
    caption: cleanCaptionText(parsed.caption),
    alt_text: cleanCaptionText(parsed.alt_text || "Bali travel lifestyle photo."),
    overlay_text: cleanCaptionText(parsed.overlay_text || "bali diary").slice(0, 70),
    story_text: cleanCaptionText(parsed.story_text || "bali lately 🌴").slice(0, 90),
    first_comment: cleanCaptionText(parsed.first_comment || "")
  };
}

async function createInstagramSafeImage(sourcePath, outputPath) {
  ensureDir(path.dirname(outputPath));
  await sharp(sourcePath)
    .rotate()
    .resize(1080, 1350, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
    .jpeg({ quality: 94 })
    .toFile(outputPath);
  log(`Created Instagram-safe image without blur: ${relativePosix(outputPath)}`);
}

async function createStoryImage(sourcePath, outputPath, storyText = "") {
  ensureDir(path.dirname(outputPath));
  const base = await sharp(sourcePath)
    .rotate()
    .resize(1080, 1920, { fit: "cover", position: "centre" })
    .modulate({ brightness: 0.92 })
    .jpeg({ quality: 92 })
    .toBuffer();

  const safe = String(storyText || "").replace(/[<>&]/g, "").slice(0, 80);
  const svg = `<svg width="1080" height="1920"><text x="540" y="170" font-size="54" fill="white" text-anchor="middle" font-family="Georgia, serif">${safe}</text></svg>`;
  await sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 92 }).toFile(outputPath);
}

async function createReelFromImages(imagePaths, musicPath, outputPath, overlayText = "") {
  ensureDir(path.dirname(outputPath));
  const workDir = path.join(REELS_OUTPUT_ROOT, `_frames_${Date.now()}`);
  ensureDir(workDir);

  const frameVideos = [];
  const durationPerImage = Number(process.env.REEL_SECONDS_PER_IMAGE || 2.2);
  const overlay = String(overlayText || "").replace(/[<>&]/g, "").slice(0, 80);

  try {
    for (let i = 0; i < imagePaths.length; i++) {
      const img = imagePaths[i];
      const frame = path.join(workDir, `frame_${String(i).padStart(2, "0")}.jpg`);
      const video = path.join(workDir, `clip_${String(i).padStart(2, "0")}.mp4`);

      let buffer = await sharp(img)
        .rotate()
        .resize(1080, 1920, { fit: "cover", position: "attention" })
        .jpeg({ quality: 94 })
        .toBuffer();

      if (i === 0 && overlay) {
        const svg = `<svg width="1080" height="1920"><rect x="0" y="0" width="1080" height="260" fill="black" opacity="0.16"/><text x="540" y="155" font-size="58" fill="white" text-anchor="middle" font-family="Georgia, serif">${overlay}</text></svg>`;
        buffer = await sharp(buffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 94 }).toBuffer();
      }

      fs.writeFileSync(frame, buffer);

      await execFileAsync("ffmpeg", [
        "-y",
        "-loop", "1",
        "-framerate", "30",
        "-i", frame,
        "-t", String(durationPerImage),
        "-vf", "zoompan=z='min(zoom+0.0009,1.055)':d=66:s=1080x1920:fps=30,format=yuv420p",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "21",
        "-pix_fmt", "yuv420p",
        video
      ], { maxBuffer: 1024 * 1024 * 20 });

      frameVideos.push(video);
    }

    const concatFile = path.join(workDir, "concat.txt");
    fs.writeFileSync(concatFile, frameVideos.map((v) => `file '${v.replace(/'/g, "'\\''")}'`).join("\n"));
    const silentVideo = path.join(workDir, "silent.mp4");

    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatFile,
      "-c", "copy",
      silentVideo
    ], { maxBuffer: 1024 * 1024 * 20 });

    await execFileAsync("ffmpeg", [
      "-y",
      "-i", silentVideo,
      "-stream_loop", "-1",
      "-i", musicPath,
      "-map", "0:v",
      "-map", "1:a",
      "-shortest",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputPath
    ], { maxBuffer: 1024 * 1024 * 30 });

    log(`Created clean multi-photo reel: ${relativePosix(outputPath)}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function maybeCreateAIVideo(asset, copy) {
  const provider = (process.env.VIDEO_GENERATION_PROVIDER || "none").toLowerCase();
  if (provider === "none" || !process.env.VIDEO_GENERATION_API_KEY) return null;

  const prompt = `Realistic clean influencer travel reel: ${asset.analysis?.description || "Bali travel moment"}. Natural camera movement, ${copy.overlay_text || "travel diary"}, non-explicit, public social media safe.`;

  // Placeholder manager hook. Add your chosen provider endpoint here later: Runway, Kling, Pika, Luma, Replicate, etc.
  // The bot safely falls back to FFmpeg photo reels until a provider is configured.
  log(`Video generation provider requested (${provider}) but no provider adapter is configured in this file. Falling back to photo reel. Prompt: ${prompt}`);
  return null;
}

async function preparePhotoPost(mode) {
  const library = await buildContentLibrary(mode);
  const asset = selectBestAsset(library, mode);
  const copy = await generatePostCopy(mode, asset);
  const stamp = Date.now();
  const instagramImage = path.join(IG_READY_ROOT, `${mode}_${stamp}.jpg`);

  await createInstagramSafeImage(absoluteFromRelative(asset.path), instagramImage);

  savePending({
    type: "photo",
    mode,
    created_at: new Date().toISOString(),
    caption: copy.caption,
    alt_text: copy.alt_text,
    story_text: copy.story_text,
    first_comment: copy.first_comment,
    assets: [asset.path],
    original_image: asset.path,
    instagram_image: relativePosix(instagramImage),
    manager: { selected_score: asset._score || scoreAssetForMode(asset, mode), analysis: asset.analysis }
  });
  log("Pending photo post saved.");
}

async function prepareStoryPost() {
  const library = await buildContentLibrary("story");
  const asset = selectBestAsset(library, "story");
  const copy = await generatePostCopy("story", asset);
  const stamp = Date.now();
  const storyImage = path.join(IG_READY_ROOT, `story_${stamp}.jpg`);
  await createStoryImage(absoluteFromRelative(asset.path), storyImage, copy.story_text);

  savePending({
    type: "story",
    mode: "story",
    created_at: new Date().toISOString(),
    caption: copy.caption,
    alt_text: copy.alt_text,
    story_text: copy.story_text,
    assets: [asset.path],
    original_image: asset.path,
    instagram_image: relativePosix(storyImage),
    manager: { selected_score: asset._score || scoreAssetForMode(asset, "story"), analysis: asset.analysis }
  });
  log("Pending story saved.");
}

async function prepareReelPost() {
  const library = await buildContentLibrary("reel");
  const assets = selectReelAssets(library, 5);
  const copy = await generatePostCopy("reel", assets);
  const music = pickMusicRotation();
  const stamp = Date.now();
  const reelVideo = path.join(REELS_OUTPUT_ROOT, `reel_${stamp}.mp4`);

  const aiVideo = await maybeCreateAIVideo(assets[0], copy);
  if (aiVideo) {
    fs.copyFileSync(aiVideo, reelVideo);
  } else {
    await createReelFromImages(assets.map((a) => absoluteFromRelative(a.path)), music, reelVideo, copy.overlay_text);
  }

  savePending({
    type: "reel",
    mode: "reel",
    created_at: new Date().toISOString(),
    caption: copy.caption,
    alt_text: copy.alt_text,
    overlay_text: copy.overlay_text,
    story_text: copy.story_text,
    first_comment: copy.first_comment,
    assets: assets.map((a) => a.path),
    original_image: assets[0].path,
    music_used: relativePosix(music),
    reel_video: relativePosix(reelVideo),
    manager: { assets: assets.map((a) => ({ path: a.path, score: a._score, analysis: a.analysis })) }
  });
  log("Pending reel post saved.");
}

async function graphPost(endpoint, params = {}) {
  const token = getEnv("FB_PAGE_ACCESS_TOKEN");
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") body.append(key, String(value));
  }
  body.append("access_token", token);

  const response = await fetch(`${GRAPH_URL}/${endpoint.replace(/^\/+/, "")}`, { method: "POST", body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Graph POST error at ${endpoint}: ${JSON.stringify(data)}`);
  return data;
}

async function graphGet(endpoint, params = {}) {
  const token = getEnv("FB_PAGE_ACCESS_TOKEN");
  const url = new URL(`${GRAPH_URL}/${endpoint.replace(/^\/+/, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.append(key, String(value));
  url.searchParams.append("access_token", token);

  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(`Graph GET error at ${endpoint}: ${JSON.stringify(data)}`);
  return data;
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
  log(`Waiting for Instagram media processing: ${containerId}`);
  for (let attempt = 1; attempt <= 40; attempt++) {
    const status = await graphGet(containerId, { fields: "status_code,status" });
    log(`Instagram media status attempt ${attempt}: ${JSON.stringify(status)}`);
    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") throw new Error(`Instagram media processing failed: ${JSON.stringify(status)}`);
    await sleep(15000);
  }
  throw new Error("Instagram media was not ready after waiting.");
}

async function publishInstagramPhoto(imageUrl, caption) {
  const igUserId = getEnv("IG_USER_ID");
  const container = await graphPost(`${igUserId}/media`, { image_url: imageUrl, caption });
  if (!container.id) throw new Error(`Instagram photo container missing ID: ${JSON.stringify(container)}`);
  await waitForInstagramMedia(container.id);
  const published = await graphPost(`${igUserId}/media_publish`, { creation_id: container.id });
  log(`Instagram photo published: ${JSON.stringify(published)}`);
  return published;
}

async function publishInstagramStory(imageUrl) {
  const igUserId = getEnv("IG_USER_ID");
  const container = await graphPost(`${igUserId}/media`, { image_url: imageUrl, media_type: "STORIES" });
  if (!container.id) throw new Error(`Instagram story container missing ID: ${JSON.stringify(container)}`);
  await waitForInstagramMedia(container.id);
  const published = await graphPost(`${igUserId}/media_publish`, { creation_id: container.id });
  log(`Instagram story published: ${JSON.stringify(published)}`);
  return published;
}

async function publishFacebookPhoto(imageUrl, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");
  const photo = await graphPost(`${fbPageId}/photos`, { url: imageUrl, caption });
  log(`Facebook photo published: ${JSON.stringify(photo)}`);
  return photo;
}

async function publishInstagramReel(videoUrl, caption) {
  const igUserId = getEnv("IG_USER_ID");
  const container = await graphPost(`${igUserId}/media`, { media_type: "REELS", video_url: videoUrl, caption, share_to_feed: "true" });
  if (!container.id) throw new Error(`Instagram Reel container missing ID: ${JSON.stringify(container)}`);
  await waitForInstagramMedia(container.id);
  const published = await graphPost(`${igUserId}/media_publish`, { creation_id: container.id });
  log(`Instagram Reel published: ${JSON.stringify(published)}`);
  return published;
}

async function publishFacebookVideo(videoUrl, caption) {
  const fbPageId = getEnv("FB_PAGE_ID");
  const video = await graphPost(`${fbPageId}/videos`, { file_url: videoUrl, description: caption });
  log(`Facebook video published: ${JSON.stringify(video)}`);
  return video;
}

function archiveOrDelete(filePath) {
  const action = (process.env.POST_USE_ACTION || "delete").toLowerCase();
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    if (action === "move") {
      const rel = relativePosix(filePath).replace(/^media\//, "").replace(/[\/]/g, "__");
      const dest = path.join(USED_DIR, rel);
      ensureDir(path.dirname(dest));
      fs.renameSync(filePath, dest);
      log(`Moved used file: ${relativePosix(filePath)} -> ${relativePosix(dest)}`);
    } else {
      fs.unlinkSync(filePath);
      log(`Deleted used file: ${relativePosix(filePath)}`);
    }
  } catch (error) {
    log(`Cleanup failed for ${filePath}: ${error.message}`);
  }
}

function updateHistory(entry) {
  const history = loadHistory();
  history.posted.push(entry);
  if (entry.music_used) {
    history.used_music.push(entry.music_used);
    history.used_music = history.used_music.slice(-30);
  }
  saveHistory(history);
}

function markAssetsUsed(assetPaths) {
  const library = readJson(LIBRARY_FILE, { assets: [] });
  const set = new Set(assetPaths || []);
  library.assets = (library.assets || []).map((asset) => set.has(asset.path) ? { ...asset, used: true, used_at: new Date().toISOString() } : asset);
  library.updated_at = new Date().toISOString();
  writeJson(LIBRARY_FILE, library);
}

async function publishPendingPost() {
  ensureFiles();
  await testAccounts();

  const pending = loadPending();
  if (!pending?.type) throw new Error("No pending post found. Run prepare step first.");

  const results = {};
  const postedAt = new Date().toISOString();
  log("Generated caption:");
  log(pending.caption || "");

  if (pending.type === "photo") {
    const originalPath = absoluteFromRelative(pending.original_image);
    const instagramPath = absoluteFromRelative(pending.instagram_image);
    if (!fs.existsSync(originalPath)) throw new Error(`Original photo missing: ${originalPath}`);
    if (!fs.existsSync(instagramPath)) throw new Error(`Instagram image missing: ${instagramPath}`);

    results.facebookPhoto = await publishFacebookPhoto(rawGithubUrl(originalPath), pending.caption);
    results.instagramPhoto = await publishInstagramPhoto(rawGithubUrl(instagramPath), pending.caption);

    updateHistory({ ...pending, posted_at: postedAt, results });
    markAssetsUsed(pending.assets || [pending.original_image]);
    for (const p of [originalPath, instagramPath]) archiveOrDelete(p);
  }

  if (pending.type === "story") {
    const originalPath = absoluteFromRelative(pending.original_image);
    const instagramPath = absoluteFromRelative(pending.instagram_image);
    if (!fs.existsSync(originalPath)) throw new Error(`Original story photo missing: ${originalPath}`);
    if (!fs.existsSync(instagramPath)) throw new Error(`Story image missing: ${instagramPath}`);

    results.instagramStory = await publishInstagramStory(rawGithubUrl(instagramPath));
    // Facebook Page story publishing is not added here because the old bot is page feed-focused.
    updateHistory({ ...pending, posted_at: postedAt, results });
    markAssetsUsed(pending.assets || [pending.original_image]);
    for (const p of [originalPath, instagramPath]) archiveOrDelete(p);
  }

  if (pending.type === "reel") {
    const reelPath = absoluteFromRelative(pending.reel_video);
    if (!fs.existsSync(reelPath)) throw new Error(`Reel video missing: ${reelPath}`);

    const reelUrl = rawGithubUrl(reelPath);
    results.facebookVideo = await publishFacebookVideo(reelUrl, pending.caption);
    results.instagramReel = await publishInstagramReel(reelUrl, pending.caption);

    updateHistory({ ...pending, posted_at: postedAt, results });
    markAssetsUsed(pending.assets || [pending.original_image]);
    for (const asset of pending.assets || [pending.original_image]) archiveOrDelete(absoluteFromRelative(asset));
    archiveOrDelete(reelPath);
  }

  clearPending();
  log("Posting complete.");
}

async function downloadCloudManifest() {
  const manifestUrl = process.env.CLOUD_IMAGE_MANIFEST_URL || "";
  if (!manifestUrl) return;

  log(`Downloading cloud manifest: ${manifestUrl}`);
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Cloud manifest download failed: ${response.status}`);
  const data = await response.json();
  const urls = Array.isArray(data) ? data : Array.isArray(data.images) ? data.images : [];
  if (!urls.length) {
    log("Cloud manifest has no images array.");
    return;
  }

  for (const item of urls) {
    const url = typeof item === "string" ? item : item.url;
    if (!url) continue;
    const clean = url.split("?")[0];
    const ext = IMAGE_EXTENSIONS.includes(path.extname(clean).toLowerCase()) ? path.extname(clean).toLowerCase() : ".jpg";
    const name = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) + ext;
    const dest = path.join(INCOMING_DIR, name);
    if (fs.existsSync(dest)) continue;
    const img = await fetch(url);
    if (!img.ok) {
      log(`Skipping cloud image: ${url} (${img.status})`);
      continue;
    }
    fs.writeFileSync(dest, Buffer.from(await img.arrayBuffer()));
    log(`Saved cloud image: ${relativePosix(dest)}`);
  }
}

async function main() {
  ensureFiles();
  const args = process.argv.slice(2);

  if (args.includes("--sync-cloud")) {
    await downloadCloudManifest();
    return;
  }

  if (args.includes("--prepare-only")) {
    await downloadCloudManifest();
    const mode = detectMode();
    log(`Selected mode: ${mode}`);
    if (["morning_photo", "afternoon_photo", "evening_photo", "night_photo"].includes(mode)) return preparePhotoPost(mode);
    if (mode === "story") return prepareStoryPost();
    if (mode === "reel") return prepareReelPost();
    throw new Error(`Unknown mode: ${mode}`);
  }

  if (args.includes("--publish-only")) return publishPendingPost();
  throw new Error("Use --prepare-only, --publish-only, or --sync-cloud");
}

main().catch((error) => {
  console.error("[AI MANAGER] ERROR:", error.message);
  process.exit(1);
});
