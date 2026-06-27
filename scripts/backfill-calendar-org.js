/**
 * One-off migration: calendar data (CalendarEvent, Availability, BookingType,
 * Booking) and the Google connection (GoogleAccount) were scoped by user only,
 * so they were shared across ALL of a user's workspaces.
 *
 * This backfills `organization` on every org-less doc, assigning it to the
 * user's PRIMARY organization (earliest membership). Bookings inherit the org of
 * their BookingType (host's primary if unknown). It also fixes the stale unique
 * indexes on Availability.user and GoogleAccount.user.
 *
 * Run from the backend folder:  node scripts/backfill-calendar-org.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const OrgMembership = require("../models/OrgMembership");
const Organization  = require("../models/Organization");

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

  // user-keyed collections: backfill from the user's/host's primary org.
  const byUser = [
    { name: "calendarevents", userField: "user" },
    { name: "availabilities", userField: "user" },
    { name: "bookingtypes",   userField: "user" },
    { name: "googleaccounts", userField: "user" },
    { name: "bookings",       userField: "host" },
  ];

  for (const { name, userField } of byUser) {
    const coll = db.collection(name);
    const docs = await coll.find(
      { $or: [{ organization: null }, { organization: { $exists: false } }] },
      { projection: { _id: 1, [userField]: 1 } }
    ).toArray();
    let updated = 0, orphan = 0;
    for (const d of docs) {
      const uid = d[userField];
      if (!uid) { orphan += 1; continue; }
      const orgId = await primaryOrgFor(uid, cache);
      if (!orgId) { orphan += 1; continue; }
      await coll.updateOne({ _id: d._id }, { $set: { organization: orgId } });
      updated += 1;
    }
    console.log(`${name}: backfilled ${updated}, skipped ${orphan}, of ${docs.length} org-less docs`);
  }

  // Fix stale unique indexes on Availability.user and GoogleAccount.user.
  for (const [name, fields] of [["availabilities", { user: 1, organization: 1 }], ["googleaccounts", { user: 1, organization: 1 }]]) {
    try {
      const coll = db.collection(name);
      const idx = await coll.indexes();
      for (const i of idx) {
        const keys = Object.keys(i.key || {});
        if (keys.length === 1 && keys[0] === "user") {
          console.log(`Dropping stale ${name} index: ${i.name}`);
          try { await coll.dropIndex(i.name); } catch (e) { console.warn("  drop failed:", e.message); }
        }
      }
      await coll.createIndex(fields, { unique: true });
      console.log(`Ensured ${name} unique index { user, organization }`);
    } catch (e) {
      console.error(`${name} index fix failed:`, e.message);
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
