// Support module — tickets (user ↔ admin chat), FAQs, and documentation.
// Users can open tickets and reply. Admins can read/reply to every ticket
// and author the shared FAQ + Docs catalogue. Socket.IO emits keep both
// sides live.

const express = require("express");
const Ticket     = require("./models/Ticket");
const SupportFaq = require("./models/SupportFaq");
const SupportDoc = require("./models/SupportDoc");
const { emitToUser, emitToRole } = require("./services/socket");

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

// Human-friendly ticket code like "T-1042". Based on the highest existing
// numeric code (not the doc count) so it never collides when tickets are
// deleted — and the caller retries on the rare concurrent-insert clash.
async function nextTicketCode() {
  const agg = await Ticket.aggregate([
    { $match: { code: { $regex: /^T-\d+$/ } } },
    { $addFields: { num: { $toInt: { $arrayElemAt: [{ $split: ["$code", "-"] }, 1] } } } },
    { $group: { _id: null, max: { $max: "$num" } } },
  ]);
  const max = agg[0]?.max || 1000;
  return `T-${max + 1}`;
}

// Create a ticket, retrying on a duplicate-code race (E11000 on `code`).
async function createTicketWithCode(data) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await Ticket.create({ ...data, code: await nextTicketCode() });
    } catch (err) {
      if (err?.code === 11000 && err?.keyPattern?.code) continue; // collided — try again
      throw err;
    }
  }
  // Last resort — make the code unique with a short random suffix.
  return Ticket.create({ ...data, code: `T-${Date.now().toString().slice(-6)}` });
}

/* ============================================================
   USER-FACING
   ============================================================ */

// List my tickets
router.get("/tickets", ah(async (req, res) => {
  const tickets = await Ticket.find({ owner: req.user._id })
    .sort({ lastMessageAt: -1, createdAt: -1 });
  res.json({ tickets });
}));

// Fetch a single ticket (owner only)
router.get("/tickets/:id", ah(async (req, res) => {
  const t = await Ticket.findOne({ _id: req.params.id, owner: req.user._id });
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  // Any admin replies are now considered read by the user.
  if (t.unreadForUser > 0) { t.unreadForUser = 0; await t.save(); }
  res.json({ ticket: t });
}));

// Create a new ticket. Body: { subject, description, category, priority }
router.post("/tickets", ah(async (req, res) => {
  const { subject, description = "", category = "General", priority = "medium" } = req.body || {};
  if (!subject?.trim()) return res.status(400).json({ error: "Subject is required" });

  const ticket = await createTicketWithCode({
    owner: req.user._id,
    user: req.user.name,
    userEmail: req.user.email || "",
    subject: subject.trim(),
    description: String(description || "").trim(),
    category,
    priority,
    status: "open",
    messages: description ? [{
      author: req.user._id,
      authorName: req.user.name,
      role: "user",
      body: String(description).trim(),
    }] : [],
    lastMessageAt: description ? new Date() : null,
    unreadForAdmin: description ? 1 : 0,
  });

  emitToRole?.("admin", "support.ticket.created", { ticket });
  res.status(201).json({ ticket });
}));

// Reply to my own ticket (append a user message)
router.post("/tickets/:id/reply", ah(async (req, res) => {
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: "Message body required" });

  const t = await Ticket.findOne({ _id: req.params.id, owner: req.user._id });
  if (!t) return res.status(404).json({ error: "Ticket not found" });

  t.messages.push({
    author: req.user._id,
    authorName: req.user.name,
    role: "user",
    body: body.trim(),
  });
  t.lastMessageAt = new Date();
  t.unreadForAdmin += 1;
  if (t.status === "resolved") t.status = "open"; // reopen on new user reply
  await t.save();

  emitToRole?.("admin", "support.ticket.replied", { ticketId: t._id.toString(), message: t.messages.at(-1) });
  res.json({ ticket: t });
}));

/* ============================================================
   FAQS + DOCS — read by users, written by admins
   ============================================================ */

router.get("/faqs", ah(async (_req, res) => {
  const faqs = await SupportFaq.find({ published: true }).sort({ category: 1, order: 1, createdAt: 1 });
  res.json({ faqs });
}));

router.get("/docs", ah(async (_req, res) => {
  const docs = await SupportDoc.find({ published: true }).sort({ category: 1, order: 1, createdAt: 1 });
  res.json({ docs });
}));

/* ============================================================
   ADMIN ROUTES — full CRUD
   ============================================================ */

// All tickets
router.get("/admin/tickets", adminOnly, ah(async (_req, res) => {
  const tickets = await Ticket.find()
    .sort({ lastMessageAt: -1, createdAt: -1 });
  res.json({ tickets });
}));

router.get("/admin/tickets/:id", adminOnly, ah(async (req, res) => {
  const t = await Ticket.findById(req.params.id);
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  if (t.unreadForAdmin > 0) { t.unreadForAdmin = 0; await t.save(); }
  res.json({ ticket: t });
}));

router.post("/admin/tickets/:id/reply", adminOnly, ah(async (req, res) => {
  const { body } = req.body || {};
  if (!body?.trim()) return res.status(400).json({ error: "Message body required" });

  const t = await Ticket.findById(req.params.id);
  if (!t) return res.status(404).json({ error: "Ticket not found" });

  t.messages.push({
    author: req.user._id,
    authorName: req.user.name,
    role: "admin",
    body: body.trim(),
  });
  t.lastMessageAt = new Date();
  t.unreadForUser += 1;
  if (t.status === "open") t.status = "in_progress";
  await t.save();

  if (t.owner) emitToUser?.(t.owner, "support.ticket.replied", { ticketId: t._id.toString(), message: t.messages.at(-1) });
  res.json({ ticket: t });
}));

router.put("/admin/tickets/:id", adminOnly, ah(async (req, res) => {
  const { status, priority, category } = req.body || {};
  const update = {};
  if (status)   update.status = status;
  if (priority) update.priority = priority;
  if (category) update.category = category;

  const t = await Ticket.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!t) return res.status(404).json({ error: "Ticket not found" });
  if (t.owner) emitToUser?.(t.owner, "support.ticket.updated", { ticket: t });
  res.json({ ticket: t });
}));

router.delete("/admin/tickets/:id", adminOnly, ah(async (req, res) => {
  const r = await Ticket.deleteOne({ _id: req.params.id });
  if (!r.deletedCount) return res.status(404).json({ error: "Ticket not found" });
  res.json({ deleted: req.params.id });
}));

// FAQ management
router.get("/admin/faqs", adminOnly, ah(async (_req, res) => {
  const faqs = await SupportFaq.find().sort({ category: 1, order: 1, createdAt: 1 });
  res.json({ faqs });
}));

router.post("/admin/faqs", adminOnly, ah(async (req, res) => {
  const faq = await SupportFaq.create(req.body || {});
  res.status(201).json({ faq });
}));

router.put("/admin/faqs/:id", adminOnly, ah(async (req, res) => {
  const faq = await SupportFaq.findByIdAndUpdate(req.params.id, req.body || {}, { new: true, runValidators: true });
  if (!faq) return res.status(404).json({ error: "FAQ not found" });
  res.json({ faq });
}));

router.delete("/admin/faqs/:id", adminOnly, ah(async (req, res) => {
  const r = await SupportFaq.deleteOne({ _id: req.params.id });
  if (!r.deletedCount) return res.status(404).json({ error: "FAQ not found" });
  res.json({ deleted: req.params.id });
}));

// Docs management
router.get("/admin/docs", adminOnly, ah(async (_req, res) => {
  const docs = await SupportDoc.find().sort({ category: 1, order: 1, createdAt: 1 });
  res.json({ docs });
}));

router.post("/admin/docs", adminOnly, ah(async (req, res) => {
  const doc = await SupportDoc.create(req.body || {});
  res.status(201).json({ doc });
}));

router.put("/admin/docs/:id", adminOnly, ah(async (req, res) => {
  const doc = await SupportDoc.findByIdAndUpdate(req.params.id, req.body || {}, { new: true, runValidators: true });
  if (!doc) return res.status(404).json({ error: "Doc not found" });
  res.json({ doc });
}));

router.delete("/admin/docs/:id", adminOnly, ah(async (req, res) => {
  const r = await SupportDoc.deleteOne({ _id: req.params.id });
  if (!r.deletedCount) return res.status(404).json({ error: "Doc not found" });
  res.json({ deleted: req.params.id });
}));

module.exports = router;
