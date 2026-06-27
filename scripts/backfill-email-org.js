/**
 * One-off migration: the email collections (config, subscribers, templates,
 * campaigns, logs, messages) were historically scoped by `user` only, with no
 * `organization`. That shares one user's email data across ALL their workspaces.
 *
 * This backfills `organization` on every org-less email document, assigning it to
 * the user's PRIMARY organization (their earliest membership) — so their real
 * data lands in their main workspace and newer/test workspaces start clean.
 *
 * It also fixes the EmailSubscriber unique index to include organization.
 *
 * Run from the backend folder:  node scripts/backfill-email-org.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const OrgMembership = require("../models/OrgMembership");
const Organization  = require("../models/Organization");

const COLLECTIONS = ["emailconfigs", "emailsubscribers", "emailtemplates", "emailcampaigns", "emaillogs", "emailmessages"];

async function primaryOrgFor(userId, cache) {
  const key = String(userId);
  if (cache.has(key)) return cache.get(key);
  // Earliest membership = the workspace the user has had the longest = primary.
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
    // Docs with no organization yet (null or missing).
    const cursor = coll.find({ $or: [{ organization: null }, { organization: { $exists: false } }] }, { projection: { _id: 1, user: 1 } });
    let updated = 0, orphan = 0;
    const docs = await cursor.toArray();
    for (const d of docs) {
      if (!d.user) { orphan += 1; continue; }
      const orgId = await primaryOrgFor(d.user, cache);
      if (!orgId) { orphan += 1; continue; }
      await coll.updateOne({ _id: d._id }, { $set: { organization: orgId } });
      updated += 1;
    }
    console.log(`${name}: backfilled ${updated}, skipped ${orphan} (no user/org), of ${docs.length} org-less docs`);
  }

  // Fix the subscriber unique index: (user,email) -> (user,organization,email).
  try {
    const subs = db.collection("emailsubscribers");
    const idx = await subs.indexes();
    for (const i of idx) {
      const keys = Object.keys(i.key || {});
      if (keys.length === 2 && keys[0] === "user" && keys[1] === "email") {
        console.log(`Dropping stale subscriber index: ${i.name}`);
        try { await subs.dropIndex(i.name); } catch (e) { console.warn("  drop failed:", e.message); }
      }
    }
    await subs.createIndex({ user: 1, organization: 1, email: 1 }, { unique: true });
    console.log("Ensured subscriber unique index { user, organization, email }");
  } catch (e) {
    console.error("Subscriber index fix failed (possible duplicates):", e.message);
  }

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
