import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function main() {
  console.log("Testing Cloudinary connection...");

  const result = await cloudinary.api.resources({
    type: "upload",
    prefix: "AI- INFLUENCER/images-pending",
    max_results: 10,
  });

  console.log("Files found:", result.resources.length);

  result.resources.forEach((file, index) => {
    console.log(`${index + 1}. ${file.public_id}`);
    console.log(file.secure_url);
  });
}

main().catch((err) => {
  console.error("Cloudinary error:", err);
  process.exit(1);
});
