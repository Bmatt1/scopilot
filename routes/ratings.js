/**
 * Owns: homeowner rating submission — GET /rate/:token (page), POST /api/ratings/:token (submit).
 * Does NOT own: SLA computation, contractor notifications, territory status — those are in db/sla.js and jobs/.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const { recordRating, getLeadByRatingToken } = require('../db/sla');

// POST /api/ratings/:token — submit a 1–5 rating
// Called when homeowner clicks a star link (redirect with ?r=<rating>) OR direct POST
router.post('/:token', async (req, res) => {
  const { token } = req.params;
  const rating = parseInt(req.body.rating || req.query.r, 10);

  if (!token || token.length < 10) {
    return res.status(400).json({ error: 'Invalid rating token' });
  }
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be 1–5' });
  }

  try {
    const lead = await recordRating(token, rating);
    if (!lead) {
      // Either token not found or already rated — still return 200 to avoid confusion
      return res.json({ success: true, already_rated: true });
    }
    res.json({ success: true, rating });
  } catch (err) {
    console.error('[ratings] submit error:', err.message);
    res.status(500).json({ error: 'Failed to record rating' });
  }
});

module.exports = router;
