const express = require('express');
const router = express.Router();
const Autopilot = require('../models/Autopilot');
const { runAutopilot } = require('../services/autopilotRunner');

const MAX_LOGS = 50;

// Persist a single inbound call onto the Autopilot doc so the builder's Logs
// panel can show what arrived (headers / query params / body) per invocation,
// plus a per-node execution trace from running the workflow.
async function recordCall(req, res) {
  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing key' });
  const ap = await Autopilot.findOne({ key, status: 'active' });
  if (!ap) return res.status(404).json({ error: 'Webhook not found' });

  const body = req.body && Object.keys(req.body).length ? req.body : {};
  const query = req.query || {};

  // Execute the workflow and capture the per-node trace.
  let steps = [];
  try {
    const result = await runAutopilot(ap, { body, query, headers: req.headers });
    steps = result.steps;
  } catch (err) {
    steps = [{ status: 'error', title: 'Workflow run', type: 'runner', message: err.message, input: null, output: null }];
    console.warn(`[autopilot] run failed for ${ap._id}: ${err.message}`);
  }

  const entry = {
    ts: new Date(),
    ip: req.ip,
    method: req.method,
    headers: req.headers || {},
    query,
    body,
    steps,
  };

  ap.calls = [entry, ...(ap.calls || [])].slice(0, MAX_LOGS);
  ap.callCount = (ap.callCount || 0) + 1;
  ap.lastCalledAt = entry.ts;
  await ap.save();

  console.log(`[autopilot] webhook ${ap._id} call #${ap.callCount} via ${req.method} — ${steps.length} node(s) executed`);

  res.json({ ok: true, received: true, callCount: ap.callCount, executed: steps.length });
}

// Accept both POST (Postman / server-to-server, JSON body) and GET (quick
// browser test where data arrives as query params).
router.post('/:key', express.json({ limit: '5mb' }), (req, res, next) => recordCall(req, res).catch(next));
router.get('/:key', (req, res, next) => recordCall(req, res).catch(next));

module.exports = router;
