const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppContact = require("../models/WhatsAppContact");

const ORPHAN_PHONE_NUMBER_ID = {
  $or: [
    { phoneNumberId: { $exists: false } },
    { phoneNumberId: null },
    { phoneNumberId: "" },
  ],
};

/** Tag legacy rows with the business phone they belonged to before a number switch. */
async function assignOrphanWaData(userId, phoneNumberId) {
  if (!userId || !phoneNumberId) return;
  const base = { user: userId, ...ORPHAN_PHONE_NUMBER_ID };
  await WhatsAppMessage.updateMany(base, { $set: { phoneNumberId: String(phoneNumberId) } });
  await WhatsAppContact.updateMany(base, { $set: { phoneNumberId: String(phoneNumberId) } });
}

async function onWaPhoneNumberChange(userId, oldPhoneNumberId, newPhoneNumberId) {
  if (!newPhoneNumberId) return;
  if (oldPhoneNumberId && oldPhoneNumberId !== newPhoneNumberId) {
    await assignOrphanWaData(userId, oldPhoneNumberId);
  }
}

/** Remove every message/contact tag for this business line (fixes bulk-assign to wrong phoneNumberId). */
async function stripAllLineTags(userId, phoneNumberId) {
  if (!userId || !phoneNumberId) return { cleared: 0, contacts: 0 };
  const id = String(phoneNumberId);
  const msg = await WhatsAppMessage.updateMany(
    { user: userId, phoneNumberId: id },
    { $set: { phoneNumberId: "" } },
  );
  const contacts = await WhatsAppContact.updateMany(
    { user: userId, phoneNumberId: id },
    { $set: { phoneNumberId: "" } },
  );
  return { cleared: msg.modifiedCount, contacts: contacts.modifiedCount };
}

/** Inbound webhook traffic on this line — if zero, old bulk-tagged rows are not real chats. */
async function countLegitLineMessages(userId, phoneNumberId) {
  if (!userId || !phoneNumberId) return 0;
  return WhatsAppMessage.countDocuments({
    user: userId,
    phoneNumberId: String(phoneNumberId),
    direction: "inbound",
    messageId: { $exists: true, $ne: "" },
  });
}

/**
 * If this line has no real Meta traffic yet, strip all wrongly assigned tags.
 * Otherwise only clear tags older than the line's inboxSince.
 */
async function repairInboxAfterPhoneChange(userId, phoneNumberId, inboxSince) {
  if (!userId || !phoneNumberId) return { cleared: 0, contacts: 0, mode: "skip" };

  const legit = await countLegitLineMessages(userId, phoneNumberId);
  if (legit === 0) {
    const out = await stripAllLineTags(userId, phoneNumberId);
    return { ...out, mode: "strip_all", legit: 0 };
  }

  const cutover = inboxSince ? new Date(inboxSince) : new Date();
  const id = String(phoneNumberId);
  const filter = { user: userId, phoneNumberId: id, ts: { $lt: cutover } };
  const msg = await WhatsAppMessage.updateMany(filter, { $set: { phoneNumberId: "" } });
  await WhatsAppContact.updateMany(
    { user: userId, phoneNumberId: id, updatedAt: { $lt: cutover } },
    { $set: { phoneNumberId: "" } },
  );
  return { cleared: msg.modifiedCount, mode: "before_inbox_since", legit };
}

/** Strict inbox filter: exact phoneNumberId + only traffic since this line was activated. */
function inboxLineMatch(userId, phoneNumberId, inboxSince) {
  const match = {
    user: userId,
    phoneNumberId: String(phoneNumberId),
  };
  if (inboxSince) {
    const cut = new Date(inboxSince);
    if (!Number.isNaN(cut.getTime())) match.ts = { $gte: cut };
  }
  return match;
}

function messageScope(userId, phoneNumberId) {
  return { user: userId, phoneNumberId: String(phoneNumberId) };
}

function contactScope(userId, phoneNumberId, phone) {
  return { user: userId, phoneNumberId: String(phoneNumberId), phone };
}

module.exports = {
  ORPHAN_PHONE_NUMBER_ID,
  assignOrphanWaData,
  onWaPhoneNumberChange,
  stripAllLineTags,
  countLegitLineMessages,
  repairInboxAfterPhoneChange,
  inboxLineMatch,
  messageScope,
  contactScope,
};
