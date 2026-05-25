/**
 * Owns: contractor-facing lead dashboard endpoints — list leads, view lead detail, update status, pass.
 * Does NOT own: homeowner submission flow, photo uploads, opportunity board claim (routes/opportunities.js).
 */
const express = require('express');
const router = express.Router();
const { getLeads, getLeadById, updateLeadStatus, passLead, insertPassReason, setFirstResponseAt } = require('../db/leads');
const { getContractorsNearZip } = require('../db/opportunities');
const { logLeadEvent } = require('../db/analytics');
const { insertEvents } = require('../db/events');
const { sendPassNotificationEmails } = require('../services/email');
const { requireAuth } = require('../lib/require-auth');

// GET /api/leads — list all leads (newest first)
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const leads = await getLeads({ status, limit: parseInt(limit), offset: parseInt(offset) });
    res.json({ leads });
  } catch (err) {
    console.error('leads list error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// GET /api/leads/:id — single lead detail with photos
router.get('/:id', async (req, res) => {
  try {
    const lead = await getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Track lead view event (fire-and-forget)
    logLeadEvent({
      leadId: lead.id,
      contractorId: lead.contractor_id,
      eventType: 'viewed'
    }).catch(err => console.error('Lead event tracking error:', err.message));

    res.json({ lead });
  } catch (err) {
    console.error('lead detail error:', err);
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

// PATCH /api/leads/:id/status — update lead status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['new', 'contacted', 'quoted', 'won', 'lost'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const lead = await updateLeadStatus(parseInt(req.params.id), status);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // First contact action sets SLA response time (fire-and-forget)
    if (status === 'contacted') {
      setFirstResponseAt(lead.id)
        .catch(err => console.error('[leads] first_response_at error:', err.message));
    }

    // Track status change as lead event (legacy lead_events table)
    logLeadEvent({
      leadId: lead.id,
      contractorId: lead.contractor_id,
      eventType: status,
      metadata: { previous_status: req.body.previous_status || null }
    }).catch(err => console.error('Lead event tracking error:', err.message));

    // Track in unified events table for funnel analysis
    insertEvents([{
      event_type: 'lead_status_changed',
      contractor_id: lead.contractor_id,
      session_id: null,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'] || '',
      referrer: null,
      properties: { lead_id: lead.id, new_status: status, previous_status: req.body.previous_status || null }
    }]).catch(err => console.error('[leads] status tracking error:', err.message));

    res.json({ lead });
  } catch (err) {
    console.error('status update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /api/leads/:id/pass — contractor passes on an assigned lead
// Body: { reason? } — reason is one of the dropdown options or free text
router.post('/:id/pass', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  if (!leadId) return res.status(400).json({ error: 'Invalid lead id' });

  const contractorId = req.session.contractorId;
  const { reason } = req.body;

  try {
    const passed = await passLead(leadId, contractorId);
    if (!passed) {
      return res.status(404).json({
        error: 'Lead not found, not assigned to you, or already passed.',
        code: 'NOT_FOUND_OR_UNAUTHORIZED',
      });
    }

    // Passing counts as a response action for SLA — if they haven't contacted yet,
    // this is the first acknowledgment (fire-and-forget)
    setFirstResponseAt(leadId)
      .catch(err => console.error('[leads] pass first_response_at error:', err.message));

    // Log pass reason (fire-and-forget)
    insertPassReason(leadId, contractorId, reason || null)
      .catch(err => console.error('[leads] pass reason insert error:', err.message));

    // Track event (fire-and-forget)
    insertEvents([{
      event_type: 'lead_passed',
      contractor_id: contractorId,
      session_id: null,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'] || '',
      referrer: null,
      properties: { lead_id: leadId, zip_code: passed.zip_code, reason: reason || null }
    }]).catch(err => console.error('[leads] pass event error:', err.message));

    // Notify neighboring contractors (fire-and-forget — don't block response)
    if (passed.zip_code) {
      getContractorsNearZip(passed.zip_code)
        .then(neighbors => {
          const targets = neighbors.filter(n => n.id !== contractorId);
          if (targets.length) {
            return sendPassNotificationEmails(passed, targets);
          }
        })
        .catch(err => console.error('[leads] pass neighbor email error:', err.message));
    }

    res.json({ success: true, lead: passed });
  } catch (err) {
    console.error('pass lead error:', err);
    res.status(500).json({ error: 'Failed to pass lead' });
  }
});

module.exports = router;
