/**
 * One-off migration: the `emailconfigs` collection historically carried a UNIQUE
 * index on `user` alone, which forces a single email config per user and shares
 * it across every organization the user belongs to (so one org's verified domain
 * leaks into another). Email config is meant to be per-organization.
 *
 * This script drops the stale `user_1` (and any unique `user`-only) index and
 * ensures the correct compound unique index { user, organization } exists.
 *
 * Run from the backend folder:  node scripts/fix-emailconfig-index.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

(async () => {
  await connectDB();
  const coll = mongoose.connection.db.collection("emailconfigs");

  const indexes = await coll.indexes();
  console.log("Current indexes:", indexes.map((i) => `${i.name}${i.unique ? " (unique)" : ""}`).join(", "));

  for (const idx of indexes) {
    const keys = Object.keys(idx.key || {});
    // Drop any index that is keyed on `user` alone (the stale per-user unique one).
    if (keys.length === 1 && keys[0] === "user") {
      console.log(`Dropping stale index: ${idx.name}`);
      try { await coll.dropIndex(idx.name); } catch (e) { console.warn(`  could not drop ${idx.name}:`, e.message); }
    }
  }

  // Recreate the plain (non-unique) lookup index on user + the correct compound key.
  try { await coll.createIndex({ user: 1 }); } catch (e) { console.warn("user index:", e.message); }
  try {
    await coll.createIndex({ user: 1, organization: 1 }, { unique: true });
    console.log("Ensured unique compound index { user: 1, organization: 1 }");
  } catch (e) {
    console.error("Failed to create compound unique index — there may be duplicate (user, organization) docs:", e.message);
  }

  const after = await coll.indexes();
  console.log("Indexes now:", after.map((i) => `${i.name}${i.unique ? " (unique)" : ""}`).join(", "));

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
