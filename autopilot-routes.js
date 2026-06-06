const express = require('express');
const crypto = require('crypto');
const Autopilot = require('./models/Autopilot');
const { tenantId } = require('./middleware/tenant');
const router = express.Router();

// Create a new autopilot webhook
router.post('/', async (req, res, next) => {
  try {
    const orgId = tenantId(req) || undefined;
    const name = String(req.body?.name || 'Autopilot');
    const key = crypto.randomBytes(16).toString('hex');
    const ap = await Autopilot.create({ name, organization: orgId, createdBy: req.user._id, key, config: req.body?.config || {} });
    const base = process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get('host')}`;
    const webhookUrl = `${base.replace(/\/$/, '')}/webhooks/autopilot/${key}`;
    res.status(201).json({ id: ap._id.toString(), name: ap.name, webhookUrl, key });
  } catch (err) { next(err); }
});

// List autopilots for current organization or user
router.get('/', async (req, res, next) => {
  try {
    const orgId = tenantId(req) || undefined;
    const filter = orgId ? { organization: orgId } : { createdBy: req.user._id };
    const list = await Autopilot.find(filter).sort({ createdAt: -1 }).lean();
    const base = process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get('host')}`;
    res.json({ autopilots: list.map(a => ({
      id: a._id.toString(),
      name: a.name,
      status: a.status,
      createdAt: a.createdAt,
      callCount: a.callCount || 0,
      lastCalledAt: a.lastCalledAt || null,
      webhookUrl: `${base.replace(/\/$/, '')}/webhooks/autopilot/${a.key}`,
    })) });
  } catch (err) { next(err); }
});

// Helper: confirm the caller owns this autopilot (org match, creator, or admin).
function canAccess(ap, req) {
  const orgId = tenantId(req) || undefined;
  return String(ap.organization) === String(orgId)
    || String(ap.createdBy) === String(req.user._id)
    || req.user.role === 'admin';
}

function webhookUrlFor(ap, req) {
  const base = process.env.PUBLIC_API_BASE || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/webhooks/autopilot/${ap.key}`;
}

// Fetch a single autopilot with its saved flow config (for the builder).
router.get('/:id', async (req, res, next) => {
  try {
    const ap = await Autopilot.findById(req.params.id).lean();
    if (!ap) return res.status(404).json({ error: 'Not found' });
    if (!canAccess(ap, req)) return res.status(403).json({ error: 'Access denied' });
    res.json({
      id: ap._id.toString(),
      name: ap.name,
      status: ap.status,
      config: ap.config || {},
      callCount: ap.callCount || 0,
      lastCalledAt: ap.lastCalledAt || null,
      webhookUrl: webhookUrlFor(ap, req),
    });
  } catch (err) { next(err); }
});

// Save name / status / flow config from the builder.
router.put('/:id', async (req, res, next) => {
  try {
    const ap = await Autopilot.findById(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Not found' });
    if (!canAccess(ap, req)) return res.status(403).json({ error: 'Access denied' });

    if (typeof req.body?.name === 'string') ap.name = req.body.name.trim() || ap.name;
    if (req.body?.status && ['active', 'disabled'].includes(req.body.status)) ap.status = req.body.status;
    if (req.body?.config !== undefined) { ap.config = req.body.config; ap.markModified('config'); }
    await ap.save();

    res.json({
      id: ap._id.toString(),
      name: ap.name,
      status: ap.status,
      config: ap.config || {},
      webhookUrl: webhookUrlFor(ap, req),
    });
  } catch (err) { next(err); }
});

// Recent inbound calls for one webhook — what arrived (headers/query/body).
router.get('/:id/logs', async (req, res, next) => {
  try {
    const ap = await Autopilot.findById(req.params.id).lean();
    if (!ap) return res.status(404).json({ error: 'Not found' });
    if (!canAccess(ap, req)) return res.status(403).json({ error: 'Access denied' });
    res.json({
      id: ap._id.toString(),
      name: ap.name,
      callCount: ap.callCount || 0,
      lastCalledAt: ap.lastCalledAt || null,
      calls: ap.calls || [],
    });
  } catch (err) { next(err); }
});

// Clear the stored call logs (keeps the lifetime callCount).
router.delete('/:id/logs', async (req, res, next) => {
  try {
    const ap = await Autopilot.findById(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Not found' });
    if (!canAccess(ap, req)) return res.status(403).json({ error: 'Access denied' });
    ap.calls = [];
    await ap.save();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Delete an autopilot. Hard-delete so it's actually gone after a refresh —
// a soft-delete via status:'disabled' would clash with "Draft" (also disabled)
// and the deleted workflow would reappear in the list.
router.delete('/:id', async (req, res, next) => {
  try {
    const ap = await Autopilot.findById(req.params.id);
    if (!ap) return res.status(404).json({ error: 'Not found' });
    if (!canAccess(ap, req)) return res.status(403).json({ error: 'Access denied' });
    await ap.deleteOne();
    res.json({ success: true, id: req.params.id });
  } catch (err) { next(err); }
});

module.exports = router;
