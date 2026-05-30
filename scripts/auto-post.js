import fs from "fs";
import path from "path";
import sharp from "sharp";

const GRAPH_VERSION = "v25.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ROOT = process.cwd();
const MEDIA_ROOT = path.join(ROOT, "media");
const IG_READY_ROOT = path.join(MEDIA_ROOT, "_ig_ready");
const DATA_ROOT = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_ROOT, "posted_history.json");
const PENDING_FILE = path.join(DATA_ROOT, "pending_post.json");

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

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
  if (!fs.existsSync(DATA_ROOT)) {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
  }

  if (!fs.existsSync(IG_READY_ROOT)) {
    fs.mkdirSync(IG_READY_ROOT, { recursive: true });
  }

  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(
      HISTORY_FILE,
      JSON.stringify({ posted: [] }, null, 2),
      "utf8"
    );
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

function findImages(folder) {
  if (!fs.existsSync(folder)) {
    return [];
  }

  const items = fs.readdirSync(folder, { withFileTypes: true });
  const images = [];

  for (const item of items) {
    const fullPath = path.join(folder, item.name);

    if (item.isFile()) {
      const ext = path.extname(item.name).toLowerCase();

      if (IMAGE_EXTENSIONS.includes(ext) && !item.name.startsWith(".")) {
        images.push(fullPath);
      }
    }
  }

  return images.sort();
}

function pickTwoImages(slot) {
  const folder = slotFolder(slot);
  const images = findImages(folder);

  if (images.length < 2) {
    throw new Error(`Need at least 2 images in ${folder}. Found ${images.length}.`);
  }

  const shuffled = [...images].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 2);

  log(`Selected images: ${selected.join(", ")}`);
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

function fallbackCaption(slot) {
  const captions = {
    morning:
      "New day, new glow ✨ Soft morning energy with main character confidence.\n\n#TaraSuri #MorningVibes #DigitalCreator #InfluencerLife #LifestyleCreator #FashionVibes #DelhiInfluencer #PhotoDump #AestheticVibes #ExplorePage #TrendingNow #CreatorLife",

    evening:
      "Night mood unlocked ✨ Little glam, little chaos, full confidence.\n\n#TaraSuri #NightLife #EveningVibes #DigitalCreator #InfluencerLife #FashionVibes #LifestyleCreator #DelhiInfluencer #PhotoDump #AestheticVibes #ExplorePage #TrendingNow",

    weekend:
      "Weekend scenes hit different ✨ Travel, vibes and main character energy.\n\n#TaraSuri #WeekendVibes #TravelVibes #DigitalCreator #InfluencerLife #LifestyleCreator #FashionVibes #PhotoDump #AestheticVibes #ExplorePage #TrendingNow #CreatorLife"
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

    const analysis = data.choices[0].message.content.trim();

    if (!analysis) {
      return "No visual analysis available.";
    }

    return analysis;
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

  log("Photo visual analysis:");
  log(visualAnalysis);

  const prompt = `
Create one viral social media caption for an influencer named Tara Suri.

Post type selected by schedule: ${slot}
Images: ${imageNames}

Photo analysis:
${visualAnalysis}

Caption rules:
- Caption must match the actual photo vibe, outfit, background, color, and mood
- Hinglish + English mix
- Stylish influencer tone
- Natural, not robotic
- Suitable for Instagram and Facebook
- No adult explicit content
- Do not say AI-generated
- Do not claim fake brand partnership
- Do not identify any real person
- Do not mention "photo analysis"
- Add 12 to 18 hashtags related to the actual photo
- Return only the final caption text
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
              "You write viral Instagram and Facebook captions based on visual photo analysis."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.9,
        max_tokens: 380
      })
    });

    const data = await response.json();

    if (!response.ok || !data.choices) {
      log(`NVIDIA caption error: ${JSON.stringify(data)}`);
      return fallbackCaption(slot);
    }

    const caption = data.choices[0].message.content.trim();

    if (!caption) {
      return fallbackCaption(slot);
    }

    return caption;
  } catch (error) {
    log(`NVIDIA caption failed: ${error.message}`);
    return fallbackCaption(slot);
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

async function preparePendingPost() {
  ensureFiles();

  const slot = detectSlot();
  log(`Selected slot: ${slot}`);

  const originals = pickTwoImages(slot);

  const caption = await generateCaption(slot, originals);

  const stamp = Date.now();
  const instagramProcessed = [];

  for (let i = 0; i < originals.length; i++) {
    const outputPath = path.join(IG_READY_ROOT, `${slot}_${stamp}_${i + 1}.jpg`);

    await createInstagramSafeImage(originals[i], outputPath);

    instagramProcessed.push(outputPath);
    log(`Created Instagram-safe image: ${outputPath}`);
  }

  const pending = {
    slot,
    created_at: new Date().toISOString(),
    caption,
    original_images: originals.map(relativePosix),
    instagram_images: instagramProcessed.map(relativePosix)
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

  log(`Instagram published: ${JSON.stringify(published)}`);

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

  const params = {
    message: caption
  };

  photoIds.forEach((photoId, index) => {
    params[`attached_media[${index}]`] = JSON.stringify({
      media_fbid: photoId
    });
  });

  const post = await graphPost(`${fbPageId}/feed`, params);

  log(`Facebook published: ${JSON.stringify(post)}`);

  return post;
}

function safeDelete(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log(`Deleted file: ${filePath}`);
    }
  } catch (error) {
    log(`Delete failed for ${filePath}: ${error.message}`);
  }
}

function updateHistory(slot, originalPaths, instagramPaths, igResult, fbResult) {
  const history = loadHistory();

  if (!Array.isArray(history.posted)) {
    history.posted = [];
  }

  const now = new Date().toISOString();

  for (let i = 0; i < originalPaths.length; i++) {
    history.posted.push({
      original_file: relativePosix(originalPaths[i]),
      instagram_file: instagramPaths[i] ? relativePosix(instagramPaths[i]) : null,
      slot,
      posted_at: now,
      instagram_result: igResult,
      facebook_result: fbResult
    });
  }

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

  for (const filePath of [...originalPaths, ...instagramPaths]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file missing: ${filePath}`);
    }
  }

  const facebookUrls = originalPaths.map(rawGithubUrl);
  const instagramUrls = instagramPaths.map(rawGithubUrl);

  log("Facebook original image URLs:");
  facebookUrls.forEach((url) => log(url));

  log("Instagram processed image URLs:");
  instagramUrls.forEach((url) => log(url));

  const caption = pending.caption;

  log("Generated caption:");
  log(caption);

  const fbResult = await publishFacebookMultiPhoto(facebookUrls, caption);
  const igResult = await publishInstagramCarousel(instagramUrls, caption);

  updateHistory(pending.slot, originalPaths, instagramPaths, igResult, fbResult);

  for (const filePath of originalPaths) {
    safeDelete(filePath);
  }

  for (const filePath of instagramPaths) {
    safeDelete(filePath);
  }

  clearPending();

  log("Posting complete. Originals + processed files deleted.");
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
