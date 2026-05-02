// Public routes — no auth required. Used by /book/:id and /form/:id pages.

const express = require("express");
const BookingType  = require("./models/BookingType");
const Availability = require("./models/Availability");
const Booking      = require("./models/Booking");
const CalendarEvent = require("./models/CalendarEvent");
const Plan         = require("./models/Plan");

const router = express.Router();

// Mirror of pricing-routes' DURATIONS — public-facing /pricing page fetches
// the same shape so the marketing and dashboard stay in lock-step.
const DURATIONS = [
  { id: "monthly",  label: "Monthly",  discount: 0,    multiplier: 1,  months: 1  },
  { id: "quarter",  label: "3 Months", discount: 0.05, multiplier: 3,  months: 3  },
  { id: "half",     label: "6 Months", discount: 0.10, multiplier: 6,  months: 6  },
  { id: "yearly",   label: "Yearly",   discount: 0.15, multiplier: 12, months: 12, bestValue: true },
];

// GET /api/public/plans — same payload as /api/pricing/plans but public,
// so the marketing landing page can show live plan data.
router.get("/plans", async (_req, res, next) => {
  try {
    const plans = await Plan.find().sort({ price: 1 });
    res.json({ plans, durations: DURATIONS });
  } catch (err) { next(err); }
});

// GET booking type + the host's availability + already-booked slots for that type.
router.get("/booking/:bookingTypeId", async (req, res, next) => {
  try {
    const bt = await BookingType.findById(req.params.bookingTypeId);
    if (!bt) return res.status(404).json({ error: "Booking link not found" });

    const [avail, taken] = await Promise.all([
      Availability.findOne({ user: bt.user }),
      Booking.find({ bookingType: bt._id, status: "confirmed" }).select("slot"),
    ]);

    res.json({
      bookingType: bt.toJSON(),
      hostId: bt.user.toString(),
      availability: avail ? avail.toJSON() : null,
      bookedSlots: taken.map((b) => new Date(b.slot).toISOString()),
    });
  } catch (err) { next(err); }
});

// POST a booking from the public page.
router.post("/booking/:bookingTypeId", async (req, res, next) => {
  try {
    const { slot, name, email, phone = "", notes = "" } = req.body || {};
    if (!slot || !name || !email) {
      return res.status(400).json({ error: "slot, name, and email are required" });
    }
    const bt = await BookingType.findById(req.params.bookingTypeId);
    if (!bt) return res.status(404).json({ error: "Booking link not found" });

    const slotDate = new Date(slot);
    if (Number.isNaN(slotDate.getTime())) return res.status(400).json({ error: "Invalid slot" });
    if (slotDate < new Date()) return res.status(400).json({ error: "Slot is in the past" });

    let booking;
    try {
      booking = await Booking.create({
        bookingType: bt._id,
        host: bt.user,
        slot: slotDate,
        duration: bt.duration,
        name, email, phone, notes,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: "That slot was just taken — please pick another." });
      }
      throw err;
    }

    // Mirror the booking into the host's calendar so it shows up in Month/Week/Agenda.
    await CalendarEvent.create({
      user: bt.user,
      type: "meeting",
      title: `${bt.name} — ${name}`,
      start: slotDate,
      end: new Date(slotDate.getTime() + bt.duration * 60000),
      attendees: [email],
      location: bt.location,
      notes: notes ? `${notes}\n\n— Booked via public link by ${name} (${email}${phone ? ", " + phone : ""})` : `Booked via public link by ${name} (${email})`,
    });

    res.status(201).json({ booking, bookingType: bt.toJSON() });
  } catch (err) { next(err); }
});

module.exports = router;
