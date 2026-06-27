const express = require("express");
const CalendarEvent = require("./models/CalendarEvent");
const Availability  = require("./models/Availability");
const BookingType   = require("./models/BookingType");
const Booking       = require("./models/Booking");
const GoogleAccount = require("./models/GoogleAccount");
const googleSvc     = require("./services/google");
const { tenantId }  = require("./middleware/tenant");

const router = express.Router();

// Tenant scope for EVERY calendar query/write. A user's events, availability,
// booking types, bookings and Google connection are isolated PER ORGANIZATION
// (tenantId = active org id, or the user id when no org is selected).
function scope(req, extra = {}) {
  return { user: req.user._id, organization: tenantId(req), ...extra };
}

// ---------- GOOGLE CALENDAR / MEET (Calendly-style sync) ----------
router.get("/google/status", async (req, res, next) => {
  try {
    const acc = await GoogleAccount.findOne(scope(req));
    res.json({
      configured: googleSvc.isConfigured(),
      connected: !!acc,
      email: acc?.email || "",
      connectedAt: acc?.createdAt || null,
    });
  } catch (err) { next(err); }
});

// Returns the Google consent URL. The frontend redirects the browser to it.
router.get("/google/connect", (req, res, next) => {
  try {
    if (!googleSvc.isConfigured()) {
      return res.status(400).json({ error: "Google isn't configured on the server. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env." });
    }
    const state = googleSvc.makeState(req.user._id, req.tenantId || null);
    res.json({ url: googleSvc.authUrl(state) });
  } catch (err) { next(err); }
});

router.post("/google/disconnect", async (req, res, next) => {
  try {
    await GoogleAccount.deleteOne(scope(req));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- EVENTS ----------
router.get("/events", async (req, res, next) => {
  try {
    const { from, to, type } = req.query;
    const filter = scope(req);
    if (type && type !== "all") filter.type = type;
    if (from || to) {
      filter.start = {};
      if (from) filter.start.$gte = new Date(from);
      if (to)   filter.start.$lte = new Date(to);
    }
    const events = await CalendarEvent.find(filter).sort({ start: 1 });
    res.json({ events });
  } catch (err) { next(err); }
});

router.post("/events", async (req, res, next) => {
  try {
    const { title, type = "meeting", start, end, attendees = [], location = "", notes = "", leadId } = req.body || {};
    if (!title || !start || !end) return res.status(400).json({ error: "title, start, end required" });
    const event = await CalendarEvent.create({
      ...scope(req), title, type, start, end, attendees, location, notes,
      leadId: leadId || null,
    });
    res.status(201).json({ event });
  } catch (err) { next(err); }
});

router.put("/events/:id", async (req, res, next) => {
  try {
    const { _id, id, user, ...rest } = req.body || {};
    const event = await CalendarEvent.findOneAndUpdate(
      scope(req, { _id: req.params.id }), rest, { new: true, runValidators: true }
    );
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json({ event });
  } catch (err) { next(err); }
});

router.delete("/events/:id", async (req, res, next) => {
  try {
    const r = await CalendarEvent.deleteOne(scope(req, { _id: req.params.id }));
    if (!r.deletedCount) return res.status(404).json({ error: "Event not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- AVAILABILITY ----------
const DEFAULT_AVAIL = {
  timezone: "Asia/Kolkata",
  slots: [
    { day: 0, enabled: false, start: "10:00", end: "17:00" },
    { day: 1, enabled: true,  start: "10:00", end: "17:00" },
    { day: 2, enabled: true,  start: "10:00", end: "17:00" },
    { day: 3, enabled: true,  start: "10:00", end: "17:00" },
    { day: 4, enabled: true,  start: "10:00", end: "17:00" },
    { day: 5, enabled: true,  start: "10:00", end: "17:00" },
    { day: 6, enabled: false, start: "10:00", end: "14:00" },
  ],
  buffer: 15,
  minNotice: 60,
};

router.get("/availability", async (req, res, next) => {
  try {
    let doc = await Availability.findOne(scope(req));
    if (!doc) doc = await Availability.create({ ...scope(req), ...DEFAULT_AVAIL });
    res.json({ availability: doc });
  } catch (err) { next(err); }
});

router.put("/availability", async (req, res, next) => {
  try {
    const { _id, id, user, ...rest } = req.body || {};
    const doc = await Availability.findOneAndUpdate(
      scope(req), { ...rest, ...scope(req) },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json({ availability: doc });
  } catch (err) { next(err); }
});

// ---------- BOOKING TYPES ----------
router.get("/booking-types", async (req, res, next) => {
  try {
    const types = await BookingType.find(scope(req)).sort({ createdAt: 1 });
    res.json({ bookingTypes: types });
  } catch (err) { next(err); }
});

router.post("/booking-types", async (req, res, next) => {
  try {
    const { name, duration = 30, location = "Google Meet", description = "", color = "#7c3aed", slug = "" } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const bt = await BookingType.create({ ...scope(req), name, duration, location, description, color, slug });
    res.status(201).json({ bookingType: bt });
  } catch (err) { next(err); }
});

router.put("/booking-types/:id", async (req, res, next) => {
  try {
    const { _id, id, user, ...rest } = req.body || {};
    const bt = await BookingType.findOneAndUpdate(
      scope(req, { _id: req.params.id }), rest, { new: true, runValidators: true }
    );
    if (!bt) return res.status(404).json({ error: "Booking type not found" });
    res.json({ bookingType: bt });
  } catch (err) { next(err); }
});

router.delete("/booking-types/:id", async (req, res, next) => {
  try {
    const r = await BookingType.deleteOne(scope(req, { _id: req.params.id }));
    if (!r.deletedCount) return res.status(404).json({ error: "Booking type not found" });
    res.json({ deleted: req.params.id });
  } catch (err) { next(err); }
});

// ---------- BOOKINGS (host view) ----------
router.get("/bookings", async (req, res, next) => {
  try {
    const list = await Booking.find({ host: req.user._id, organization: tenantId(req) })
      .populate("bookingType", "name color duration")
      .sort({ slot: -1 });
    res.json({ bookings: list });
  } catch (err) { next(err); }
});

module.exports = router;
