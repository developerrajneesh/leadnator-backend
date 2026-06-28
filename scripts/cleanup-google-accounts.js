/**
 * Remove orphaned Google connections — GoogleAccount rows whose user or org no
 * longer exists (e.g. left over after an account/workspace was recreated). These
 * cause "connected" toasts that never reflect in status.
 *
 * Run from the backend folder:  node scripts/cleanup-google-accounts.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

(async () => {
  await connectDB();
  const db = mongoose.connection.db;
  const accts = await db.collection("googleaccounts").find({}).toArray();
  let removed = 0;
  for (const a of accts) {
    const userOk = a.user && await db.collection("users").findOne({ _id: a.user }, { projection: { _id: 1 } });
    const orgOk = a.organization == null || await db.collection("organizations").findOne({ _id: a.organization }, { projection: { _id: 1 } });
    if (!userOk || !orgOk) {
      await db.collection("googleaccounts").deleteOne({ _id: a._id });
      console.log(`Removed orphan GoogleAccount user=${a.user} org=${a.organization} (${a.email})`);
      removed += 1;
    }
  }
  console.log(`Done. Removed ${removed} orphaned Google connection(s).`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
