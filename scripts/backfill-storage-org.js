/**
 * One-off migration: storage (StorageItem, StorageConfig) was scoped by `user`
 * only, with no `organization`, so one user's files & bucket config were shared
 * across ALL their workspaces.
 *
 * This backfills `organization` on every org-less storage document, assigning it
 * to the user's PRIMARY organization (earliest membership), and fixes the
 * StorageConfig index (drop stale unique `user_1`, add unique {user,organization}).
 *
 * Run from the backend folder:  node scripts/backfill-storage-org.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const OrgMembership = require("../models/OrgMembership");
const Organization  = require("../models/Organization");

const COLLECTIONS = ["storageitems", "storageconfigs"];

async function primaryOrgFor(userId, cache) {
  const key = String(userId);
  if (cache.has(key)) return cache.get(key);
  let m = await OrgMembership.findOne({ user: userId }).sort({ createdAt: 1 });
  let orgId = m?.organization || null;
  if (!orgId) {
    const org = await Organization.findOne({ createdBy: userId }).sort({ createdAt: 1 });
    orgId = org?._id || null;
  }
  cache.set(key, orgId);
  return orgId;
}

(async () => {
  await connectDB();
  const db = mongoose.connection.db;
  const cache = new Map();

  for (const name of COLLECTIONS) {
    const coll = db.collection(name);
    const docs = await coll.find(
      { $or: [{ organization: null }, { organization: { $exists: false } }] },
      { projection: { _id: 1, user: 1 } }
    ).toArray();
    let updated = 0, orphan = 0;
    for (const d of docs) {
      if (!d.user) { orphan += 1; continue; }
      const orgId = await primaryOrgFor(d.user, cache);
      if (!orgId) { orphan += 1; continue; }
      await coll.updateOne({ _id: d._id }, { $set: { organization: orgId } });
      updated += 1;
    }
    console.log(`${name}: backfilled ${updated}, skipped ${orphan} (no user/org), of ${docs.length} org-less docs`);
  }

  // Fix StorageConfig index: drop stale unique user_1, add unique {user,organization}.
  try {
    const cfgs = db.collection("storageconfigs");
    const idx = await cfgs.indexes();
    for (const i of idx) {
      const keys = Object.keys(i.key || {});
      if (keys.length === 1 && keys[0] === "user") {
        console.log(`Dropping stale storageconfig index: ${i.name}`);
        try { await cfgs.dropIndex(i.name); } catch (e) { console.warn("  drop failed:", e.message); }
      }
    }
    await cfgs.createIndex({ user: 1 });
    await cfgs.createIndex({ user: 1, organization: 1 }, { unique: true });
    console.log("Ensured storageconfig unique index { user, organization }");
  } catch (e) {
    console.error("StorageConfig index fix failed:", e.message);
  }

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
