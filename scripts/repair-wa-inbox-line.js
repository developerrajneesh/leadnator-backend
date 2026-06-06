/**
 * One-off: strip wrongly tagged inbox rows for a phoneNumberId with no inbound webhook traffic.
 * Usage: node scripts/repair-wa-inbox-line.js [phoneNumberId]
 */
require("dotenv").config();
const mongoose = require("mongoose");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppConnection = require("../models/WhatsAppConnection");
const { stripAllLineTags, countLegitLineMessages } = require("../services/waScope");

const TARGET = process.argv[2] || "1180108285179252";

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const conns = await WhatsAppConnection.find({ phoneNumberId: TARGET })
    .select("user phoneNumberId inboxSince connectedAt")
    .lean();

  console.log(`Found ${conns.length} connection(s) for phoneNumberId ${TARGET}`);

  for (const c of conns) {
    const uid = c.user;
    const tagged = await WhatsAppMessage.countDocuments({ user: uid, phoneNumberId: TARGET });
    const legit = await countLegitLineMessages(uid, TARGET);
    console.log(`user=${uid} tagged=${tagged} inbound_webhook=${legit}`);

    if (legit === 0 && tagged > 0) {
      const r = await stripAllLineTags(uid, TARGET);
      console.log("stripped", r);
    }

    await WhatsAppConnection.updateOne(
      { _id: c._id },
      { $set: { inboxSince: c.inboxSince || new Date() } },
    );
    console.log("inboxSince set/kept");
  }

  const remaining = await WhatsAppMessage.countDocuments({ phoneNumberId: TARGET });
  console.log(`Messages still tagged ${TARGET} (all users): ${remaining}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
