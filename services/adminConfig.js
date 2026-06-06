const bcrypt = require("bcryptjs");
const AdminConfig = require("../models/AdminConfig");

async function statusPayload() {
  const c = await AdminConfig.findOne({ key: "global" });
  return {
    enabled: !!c?.masterPasswordEnabled,
    set: !!c?.masterPasswordEnabled,
    updatedAt: c?.masterPasswordUpdatedAt || null,
    lastMasterLoginAt: c?.lastMasterLoginAt || null,
  };
}

async function setMasterPassword(plain, adminId) {
  if (!plain || plain.length < 8) {
    const e = new Error("Master password must be at least 8 characters.");
    e.status = 400;
    throw e;
  }
  const hash = await bcrypt.hash(plain, 10);
  await AdminConfig.updateOne(
    { key: "global" },
    { $set: { masterPasswordHash: hash, masterPasswordEnabled: true, masterPasswordUpdatedAt: new Date(), updatedBy: adminId } },
    { upsert: true },
  );
}

async function clearMasterPassword() {
  await AdminConfig.updateOne(
    { key: "global" },
    { $set: { masterPasswordHash: "", masterPasswordEnabled: false, masterPasswordUpdatedAt: new Date() } },
    { upsert: true },
  );
}

// True only when a master password is set + enabled AND it matches.
async function verifyMasterPassword(plain) {
  if (!plain) return false;
  const c = await AdminConfig.findOne({ key: "global" }).select("+masterPasswordHash masterPasswordEnabled");
  if (!c || !c.masterPasswordEnabled || !c.masterPasswordHash) return false;
  const ok = await bcrypt.compare(plain, c.masterPasswordHash);
  if (ok) AdminConfig.updateOne({ key: "global" }, { $set: { lastMasterLoginAt: new Date() } }).catch(() => {});
  return ok;
}

module.exports = { statusPayload, setMasterPassword, clearMasterPassword, verifyMasterPassword };
