// S3 uploader used by the ported Meta Ads ad controller (optional
// /ads/upload-image-s3 route — hosts an image so its URL can be passed to
// Meta). Same signature as the original LCM service: (buffer, name, mime) →
// { url, key }. Reads creds from env; throws clearly if no bucket is set.
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const BUCKET = process.env.META_S3_BUCKET || process.env.BUCKET_NAME || "";

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || process.env.REGION || "eu-north-1",
  ...(process.env.ENDPOINT_URL ? { endpoint: process.env.ENDPOINT_URL, s3ForcePathStyle: true } : {}),
});

module.exports = async function uploadToS3(fileBuffer, fileName, mimeType) {
  if (!BUCKET) throw new Error("S3 bucket not configured — set META_S3_BUCKET in .env");
  const key = `meta-ads/${uuidv4()}${path.extname(fileName) || ".png"}`;
  const data = await s3
    .upload({ Bucket: BUCKET, Key: key, Body: fileBuffer, ContentType: mimeType })
    .promise();
  return { url: data.Location, key: data.Key };
};
