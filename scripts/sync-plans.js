/**
 * Upsert the DB `Plan` documents (which power the pricing page) from the single
 * source of truth in config/plans.js. Safe to re-run anytime.
 *
 * Run from the backend folder:  node scripts/sync-plans.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Plan = require("../models/Plan");
const { dbPlanDocs } = require("../config/plans");

(async () => {
  await connectDB();
  for (const doc of dbPlanDocs()) {
    await Plan.findOneAndUpdate({ key: doc.key }, { $set: doc }, { upsert: true, new: true, setDefaultsOnInsert: true });
    console.log(`Synced plan: ${doc.name} (₹${doc.price}) — ${doc.features.length} features, ${doc.disabled.length} disabled`);
  }
  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
