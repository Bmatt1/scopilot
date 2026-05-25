/**
 * Owns: opportunity board endpoints — list board leads, claim a lead.
 * Does NOT own: lead pass action (routes/leads.js), territory claims (routes/territory.js).
 */
const express = require('express');
const router = express.Router();
const { getBoardLeads } = require('../db/opportunities');
const { claimLeadFromBoard, getLeadById, insertPassReason } = require('../db/leads');
const { getClaimsByContractor } = require('../db/territory');
const { insertEvents } = require('../db/events');
const { requireAuth } = require('../lib/require-auth');

// GET /api/opportunities — list opportunity board leads
// Query params: trade (project_type filter), filter=nearby|all
router.get('/', requireAuth, async (req, res) => {
  try {
    const { trade, filter = 'all', limit = 50, offset = 0 } = req.query;
    let zipCodes;

    // "nearby" filter: restrict to zips claimed by this contractor + adjacent
    if (filter === 'nearby') {
      const claims = await getClaimsByContractor(req.session.contractorId);
      const myZips = claims.map(c => c.zip_code).filter(Boolean);
      if (myZips.length > 0) {
        // Include claimed zips ± 5 (numeric adjacency, same logic as getContractorsNearZip)
        const expanded = new Set();
        for (const z of myZips) {
          const n = parseInt(z, 10);
          if (!isNaN(n)) {
            for (let i = n - 5; i <= n + 5; i++) {
              expanded.add(String(i).padStart(5, '0'));
            }
          }
        }
        zipCodes = [...expanded];
      }
    }

    const leads = await getBoardLeads({
      tradeType: trade || undefined,
      zipCodes,
      limit: Math.min(parseInt(limit) || 50, 100),
      offset: parseInt(offset) || 0,
    });

    res.json({ leads });
  } catch (err) {
    console.error('opportunities list error:', err);
    res.status(500).json({ error: 'Failed to fetch opportunity board' });
  }
});

// POST /api/opportunities/:id/claim — atomically claim a lead from the board
router.post('/:id/claim', requireAuth, async (req, res) => {
  const leadId = parseInt(req.params.id, 10);
  if (!leadId) return res.status(400).json({ error: 'Invalid lead id' });

  const contractorId = req.session.contractorId;

  try {
    const claimed = await claimLeadFromBoard(leadId, contractorId);

    if (!claimed) {
      // Either already claimed or not on the board
      return res.status(409).json({
        error: 'Just claimed by another contractor.',
        code: 'ALREADY_CLAIMED',
      });
    }

    // Return full lead details (contact info now revealed)
    const full = await getLeadById(leadId);

    // Track event (fire-and-forget)
    insertEvents([{
      event_type: 'lead_claimed_from_board',
      contractor_id: contractorId,
      session_id: null,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
      user_agent: req.headers['user-agent'] || '',
      referrer: null,
      properties: { lead_id: leadId, zip_code: claimed.zip_code }
    }]).catch(err => console.error('[opportunities] claim event error:', err.message));

    res.json({ success: true, lead: full });
  } catch (err) {
    console.error('claim from board error:', err);
    res.status(500).json({ error: 'Failed to claim lead' });
  }
});

module.exports = router;
