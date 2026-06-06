// File-storage service — uploads, downloads, deletes blobs on any S3-compatible
// provider (Supabase Storage / AWS / Cloudflare R2 / Wasabi / Backblaze B2).
//
// Every function takes a `cfg` argument: `{ endpointUrl, accessKeyId,
// secretAccessKey, bucketName, region }`. The caller (storage-routes) loads
// these from the per-user StorageConfig collection before calling us.

const AWS = require("aws-sdk");
const crypto = require("crypto");

function s3For(cfg) {
  if (!cfg?.endpointUrl || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.bucketName) {
    const err = new Error("Storage not configured. Save your S3 credentials in Storage → Settings.");
    err.code = "STORAGE_NOT_CONFIGURED";
    throw err;
  }
  return new AWS.S3({
    endpoint: cfg.endpointUrl,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region || "ap-south-1",
    s3ForcePathStyle: true,
    signatureVersion: "v4",
  });
}

function isConfigured(cfg) {
  return !!(cfg?.endpointUrl && cfg?.accessKeyId && cfg?.secretAccessKey && cfg?.bucketName);
}

// Simple connectivity check — lists up to 1 key so we surface auth / bucket
// errors with the real Meta message ("InvalidAccessKeyId", "NoSuchBucket" etc.).
async function verify(cfg) {
  const client = s3For(cfg);
  await client.listObjectsV2({ Bucket: cfg.bucketName, MaxKeys: 1 }).promise();
  return true;
}

function makeKey(userId, originalName) {
  const safe  = String(originalName).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const stamp = Date.now().toString(36);
  const rand  = crypto.randomBytes(4).toString("hex");
  return `users/${userId}/${stamp}_${rand}_${safe}`;
}

async function uploadBuffer({ cfg, userId, originalName, buffer, mimeType }) {
  const client = s3For(cfg);
  const key = makeKey(userId, originalName);
  const data = await client.upload({
    Bucket: cfg.bucketName,
    Key: key,
    Body: buffer,
    ContentType: mimeType || "application/octet-stream",
  }).promise();
  return { key, location: data.Location, etag: data.ETag };
}

function getSignedUrl(cfg, key, expiresInSec = 3600) {
  const client = s3For(cfg);
  return client.getSignedUrl("getObject", {
    Bucket: cfg.bucketName,
    Key: key,
    Expires: expiresInSec,
  });
}

async function deleteKey(cfg, key) {
  if (!key) return;
  const client = s3For(cfg);
  await client.deleteObject({ Bucket: cfg.bucketName, Key: key }).promise();
}

async function deleteKeys(cfg, keys = []) {
  const filtered = keys.filter(Boolean);
  if (!filtered.length) return;
  const client = s3For(cfg);
  await client.deleteObjects({
    Bucket: cfg.bucketName,
    Delete: { Objects: filtered.map((Key) => ({ Key })) },
  }).promise();
}

module.exports = { isConfigured, verify, uploadBuffer, getSignedUrl, deleteKey, deleteKeys };
