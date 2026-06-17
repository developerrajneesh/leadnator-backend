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

  // Persist the call entry up front so the workflow can append a per-node trace
  // as it runs — flows with real wait/delay steps complete over time.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = { runId, ts: new Date(), ip: req.ip, method: req.method, headers: req.headers || {}, query, body, steps: [] };
  ap.calls = [entry, ...(ap.calls || [])].slice(0, MAX_LOGS);
  ap.callCount = (ap.callCount || 0) + 1;
  ap.lastCalledAt = entry.ts;
  await ap.save();

  // Respond immediately — the workflow runs in the background (so waits don't
  // hold the HTTP connection). On a serverless host the background run may not
  // survive past the response; use a persistent server for wait/delay flows.
  res.json({ ok: true, received: true, callCount: ap.callCount });

  const persist = async (steps) => {
    try {
      await Autopilot.updateOne({ _id: ap._id, 'calls.runId': runId }, { $set: { 'calls.$.steps': steps } });
    } catch (e) { console.warn(`[autopilot] trace persist failed: ${e.message}`); }
  };

  try {
    const result = await runAutopilot(ap, { body, query, headers: req.headers }, persist);
    await persist(result.steps);
    console.log(`[autopilot] webhook ${ap._id} call #${ap.callCount} — ${result.steps.length} node(s) executed`);
  } catch (err) {
    console.warn(`[autopilot] run failed for ${ap._id}: ${err.message}`);
    await persist([{ status: 'error', title: 'Workflow run', type: 'runner', message: err.message, input: null, output: null }]);
  }
}

// Accept both POST (Postman / server-to-server, JSON body) and GET (quick
// browser test where data arrives as query params).
router.post('/:key', express.json({ limit: '5mb' }), (req, res, next) => recordCall(req, res).catch(next));
router.get('/:key', (req, res, next) => recordCall(req, res).catch(next));

module.exports = router;
