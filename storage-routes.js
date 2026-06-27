// File-storage routes — folder + file CRUD on top of MongoDB,
// blobs proxied through services/uploadFiles to Supabase S3.

const express = require("express");
const multer = require("multer");
const StorageItem   = require("./models/StorageItem");
const StorageConfig = require("./models/StorageConfig");
const upload = require("./services/uploadFiles");
const { tenantId } = require("./middleware/tenant");

const router = express.Router();

// Tenant scope for EVERY storage query/write. A user's files & bucket config are
// isolated PER ORGANIZATION (tenantId = active org id, or the user id when no
// org is selected). Without this, one workspace's files leak into another.
function scope(req, extra = {}) {
  return { user: req.user._id, organization: tenantId(req), ...extra };
}

// Load this workspace's S3 creds (with secrets unmasked). Returns null if not
// configured — handlers treat that as unconfigured.
async function loadCfg(req) {
  return StorageConfig.findOne(scope(req))
    .select("+accessKeyId +secretAccessKey");
}

// Memory storage — multer keeps the file in RAM, then we hand it to S3.
const mu = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },   // 100 MB per file
});

function normPath(p = "/") {
  let s = String(p || "/").trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+$/g, "");
  return s || "/";
}

function joinPath(parent, name) {
  const p = normPath(parent);
  return p === "/" ? `/${name}` : `${p}/${name}`;
}

function pickExt(name = "") {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

// ---------- CONFIG — per-user S3 credentials ----------
router.get("/config", async (req, res, next) => {
  try {
    const cfg = await loadCfg(req);
    res.json({
      configured: upload.isConfigured(cfg),
      bucket: cfg?.bucketName || "",
      endpointUrl: cfg?.endpointUrl || "",
      region: cfg?.region || "",
      verified: !!cfg?.verified,
      verifiedAt: cfg?.verifiedAt || null,
      lastError: cfg?.lastError || "",
      // Mask the access key and secret so the UI can show "•••• ending 1234"
      // but never the full value.
      accessKeyIdMasked: cfg?.accessKeyId ? `••••${cfg.accessKeyId.slice(-4)}` : "",
      hasSecret: !!cfg?.secretAccessKey,
    });
  } catch (err) { next(err); }
});

router.put("/config", async (req, res, next) => {
  try {
    const { endpointUrl, accessKeyId, secretAccessKey, bucketName, region } = req.body || {};
    if (!endpointUrl || !bucketName) return res.status(400).json({ error: "endpointUrl and bucketName required" });

    // Don't overwrite secret/accessKey if blank strings were sent (lets the
    // UI keep them masked while editing other fields).
    const patch = {
      endpointUrl: endpointUrl.trim(),
      bucketName:  bucketName.trim(),
      region:      (region || "ap-south-1").trim(),
      verified:    false,
      lastError:   "",
    };
    if (accessKeyId?.trim())     patch.accessKeyId     = accessKeyId.trim();
    if (secretAccessKey?.trim()) patch.secretAccessKey = secretAccessKey.trim();

    const cfg = await StorageConfig.findOneAndUpdate(
      { ...scope(req) },
      { $set: { ...patch, ...scope(req) } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).select("+accessKeyId +secretAccessKey");
    res.json({ config: cfg.toJSON(), ok: true });
  } catch (err) { next(err); }
});

router.post("/config/verify", async (req, res, next) => {
  try {
    const cfg = await loadCfg(req);
    if (!upload.isConfigured(cfg)) return res.status(400).json({ error: "Save all fields first." });
    try {
      await upload.verify({
        endpointUrl: cfg.endpointUrl, accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey, bucketName: cfg.bucketName, region: cfg.region,
      });
      cfg.verified = true; cfg.verifiedAt = new Date(); cfg.lastError = "";
      await cfg.save();
      res.json({ ok: true, message: "Bucket reachable ✓" });
    } catch (e) {
      cfg.verified = false; cfg.lastError = e.message || "Unknown error";
      await cfg.save();
      res.status(400).json({ ok: false, error: e.message });
    }
  } catch (err) { next(err); }
});

router.delete("/config", async (req, res, next) => {
  try {
    await StorageConfig.deleteOne({ ...scope(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- LIST items in a folder ----------
router.get("/items", async (req, res, next) => {
  try {
    const parentPath = normPath(req.query.path || "/");
    const items = await StorageItem
      .find({ ...scope(req), parentPath, deleted: false })
      .sort({ type: 1, name: 1 });   // folders first then files (alphabetical)
    res.json({ items, parentPath });
  } catch (err) { next(err); }
});

// ---------- RECENT (most-recent files across all folders) ----------
router.get("/recent", async (req, res, next) => {
  try {
    const items = await StorageItem
      .find({ ...scope(req), type: "file", deleted: false })
      .sort({ updatedAt: -1 }).limit(30);
    res.json({ items });
  } catch (err) { next(err); }
});

// ---------- TRASH ----------
router.get("/trash", async (req, res, next) => {
  try {
    const items = await StorageItem
      .find({ ...scope(req), deleted: true })
      .sort({ deletedAt: -1 });
    res.json({ items });
  } catch (err) { next(err); }
});

// ---------- SHARED with me (simple — by email match on user) ----------
router.get("/shared", async (req, res, next) => {
  try {
    const items = await StorageItem
      .find({ sharedWith: req.user.email.toLowerCase(), deleted: false })
      .sort({ updatedAt: -1 })
      .populate("user", "name email");
    res.json({ items });
  } catch (err) { next(err); }
});

// ---------- STATS ----------
router.get("/stats", async (req, res, next) => {
  try {
    const [total, files, folders, trashed, agg] = await Promise.all([
      StorageItem.countDocuments({ ...scope(req), deleted: false }),
      StorageItem.countDocuments({ ...scope(req), type: "file",   deleted: false }),
      StorageItem.countDocuments({ ...scope(req), type: "folder", deleted: false }),
      StorageItem.countDocuments({ ...scope(req), deleted: true }),
      StorageItem.aggregate([
        { $match: { ...scope(req), type: "file", deleted: false } },
        { $group: { _id: null, totalBytes: { $sum: "$size" } } },
      ]),
    ]);
    res.json({
      total, files, folders, trashed,
      totalBytes: agg[0]?.totalBytes || 0,
      configured: upload.isConfigured(await loadCfg(req)),
    });
  } catch (err) { next(err); }
});

// ---------- CREATE folder ----------
router.post("/folders", async (req, res, next) => {
  try {
    const { name, parentPath = "/" } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Folder name required" });
    const safeName = name.trim().replace(/[\/\\]/g, "_");
    const parent = normPath(parentPath);

    // Block duplicate folder names at this level
    const exists = await StorageItem.findOne({
      ...scope(req), parentPath: parent, name: safeName, type: "folder", deleted: false,
    });
    if (exists) return res.status(409).json({ error: "A folder with that name already exists here." });

    const item = await StorageItem.create({
      ...scope(req),
      name: safeName,
      type: "folder",
      parentPath: parent,
      path: joinPath(parent, safeName),
    });
    res.status(201).json({ item });
  } catch (err) { next(err); }
});

// ---------- UPLOAD file(s) ----------
router.post("/upload", mu.array("files", 10), async (req, res, next) => {
  try {
    const cfg = await loadCfg(req);
    if (!upload.isConfigured(cfg)) {
      return res.status(400).json({ error: "Storage not configured. Save your S3 credentials in Storage → Settings first." });
    }
    const parentPath = normPath(req.body?.parentPath || "/");
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "No files in request" });

    const created = [];
    for (const f of files) {
      const { key, location } = await upload.uploadBuffer({
        cfg,
        userId: req.user._id.toString(),
        originalName: f.originalname,
        buffer: f.buffer,
        mimeType: f.mimetype,
      });
      const item = await StorageItem.create({
        ...scope(req),
        name: f.originalname,
        type: "file",
        parentPath,
        ext: pickExt(f.originalname),
        mimeType: f.mimetype,
        size: f.size,
        s3Key: key,
      });
      created.push({ item, location });
    }
    res.status(201).json({ uploaded: created.length, items: created.map((c) => c.item) });
  } catch (err) { next(err); }
});

// ---------- SOFT DELETE (move to trash) ----------
router.delete("/items/:id", async (req, res, next) => {
  try {
    const item = await StorageItem.findOneAndUpdate(
      { _id: req.params.id, ...scope(req), deleted: false },
      { deleted: true, deletedAt: new Date() },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Item not found" });
    res.json({ item });
  } catch (err) { next(err); }
});

// ---------- RESTORE from trash ----------
router.post("/items/:id/restore", async (req, res, next) => {
  try {
    const item = await StorageItem.findOneAndUpdate(
      { _id: req.params.id, ...scope(req), deleted: true },
      { $set: { deleted: false }, $unset: { deletedAt: 1 } },
      { new: true }
    );
    if (!item) return res.status(404).json({ error: "Item not found in trash" });
    res.json({ item });
  } catch (err) { next(err); }
});

// ---------- PERMANENT DELETE (purge) ----------
router.delete("/items/:id/purge", async (req, res, next) => {
  try {
    const item = await StorageItem.findOne({ _id: req.params.id, ...scope(req) });
    if (!item) return res.status(404).json({ error: "Item not found" });
    if (item.type === "file" && item.s3Key) {
      try {
        const cfg = await loadCfg(req);
        if (upload.isConfigured(cfg)) await upload.deleteKey(cfg, item.s3Key);
      } catch (e) { console.warn("S3 delete failed:", e.message); }
    }
    await item.deleteOne();
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

router.post("/trash/empty", async (req, res, next) => {
  try {
    const items = await StorageItem.find({ ...scope(req), deleted: true });
    const keys = items.filter((i) => i.s3Key).map((i) => i.s3Key);
    try {
      const cfg = await loadCfg(req);
      if (upload.isConfigured(cfg)) await upload.deleteKeys(cfg, keys);
    } catch (e) { console.warn("S3 bulk delete failed:", e.message); }
    await StorageItem.deleteMany({ ...scope(req), deleted: true });
    res.json({ purged: items.length });
  } catch (err) { next(err); }
});

// ---------- DOWNLOAD URL (signed) ----------
router.get("/items/:id/url", async (req, res, next) => {
  try {
    const item = await StorageItem.findOne({ _id: req.params.id, ...scope(req), type: "file" });
    if (!item) return res.status(404).json({ error: "File not found" });
    if (!item.s3Key) return res.status(400).json({ error: "No object key on file" });
    const cfg = await loadCfg(req);
    if (!upload.isConfigured(cfg)) return res.status(400).json({ error: "Storage not configured for this user." });
    const url = upload.getSignedUrl(cfg, item.s3Key, Number(req.query.expires) || 3600);
    res.json({ url, expiresIn: 3600 });
  } catch (err) { next(err); }
});

// ---------- SHARE / unshare ----------
router.put("/items/:id/share", async (req, res, next) => {
  try {
    const { add = [], remove = [] } = req.body || {};
    const item = await StorageItem.findOne({ _id: req.params.id, ...scope(req) });
    if (!item) return res.status(404).json({ error: "Item not found" });
    const set = new Set(item.sharedWith || []);
    add.forEach((e) => e && set.add(String(e).toLowerCase()));
    remove.forEach((e) => set.delete(String(e).toLowerCase()));
    item.sharedWith = [...set];
    await item.save();
    res.json({ item });
  } catch (err) { next(err); }
});

module.exports = router;
