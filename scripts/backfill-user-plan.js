/**
 * Backfill the denormalized billing fields on existing users so plan enforcement
 * resolves correctly: planKey (from their plan name) and subscriptionActive
 * (true if they currently have an active Subscription). Existing accounts are
 * NOT put on a trial — only brand-new signups get the 2-day Starter trial.
 *
 * Run from the backend folder:  node scripts/backfill-user-plan.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const { planKeyFromAny } = require("../config/plans");

(async () => {
  await connectDB();
  const users = await User.find({}).select("plan planKey subscriptionActive");
  let updated = 0;
  for (const u of users) {
    const planKey = planKeyFromAny(u.planKey) || planKeyFromAny(u.plan) || "starter";
    const hasActive = await Subscription.exists({ user: u._id, status: "active" });
    const set = { planKey, subscriptionActive: !!hasActive };
    await User.updateOne({ _id: u._id }, { $set: set });
    updated += 1;
  }
  console.log(`Backfilled ${updated} users (planKey + subscriptionActive).`);
  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
