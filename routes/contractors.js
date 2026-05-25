/**
 * Owns: contractor-scoped lead endpoints — list own leads, view own lead.
 * Does NOT own: auth (handled by middleware in server.js), cross-contractor data access.
 */
const express = require('express');
const router = express.Router();
const { getLeads, getLeadById, updateLeadStatus } = require('../db/leads');
const { requireAuth: requireContractor } = require('../lib/require-auth');

// GET /api/contractors/me/leads — contractor's own leads
router.get('/me/leads', requireContractor, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const leads = await getLeads({
      contractorId: req.session.contractorId,
      status,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    res.json({ leads });
  } catch (err) {
    console.error('contractor leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// GET /api/contractors/me — contractor profile
router.get('/me', requireContractor, async (req, res) => {
  try {
    const { getContractorById } = require('../db/contractors');
    const contractor = await getContractorById(req.session.contractorId);
    if (!contractor) return res.status(404).json({ error: 'Not found' });
    res.json({ contractor });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// GET /api/contractors/me/leads/:id — contractor's own lead detail
router.get('/me/leads/:id', requireContractor, async (req, res) => {
  try {
    const lead = await getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    // Security: ensure this lead belongs to this contractor
    if (lead.contractor_id !== req.session.contractorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ lead });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

// PATCH /api/contractors/me/leads/:id/status
router.patch('/me/leads/:id/status', requireContractor, async (req, res) => {
  try {
    const lead = await getLeadById(parseInt(req.params.id));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.contractor_id !== req.session.contractorId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { status } = req.body;
    const allowed = ['new', 'contacted', 'quoted', 'won', 'lost'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
    }
    const updated = await updateLeadStatus(parseInt(req.params.id), status);
    res.json({ lead: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

module.exports = router;