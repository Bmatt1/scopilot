/**
 * Owns: SLA computation queries — contractor response-time stats, rating averages,
 *       territory status transitions (active → at_risk → suspended → released).
 * Does NOT own: HTTP handling, email delivery, cron scheduling — those live in
 *               routes/territory.js, services/email.js, and jobs/.
 */
const pool = require('./index');

// SLA thresholds (overridable via env)
const SLA_RESPONSE_HOURS  = parseInt(process.env.SLA_RESPONSE_HOURS  || '48', 10);
const SLA_BREACH_STREAK   = parseInt(process.env.SLA_BREACH_STREAK   || '3',  10);
const SLA_RATING_MIN      = parseInt(process.env.SLA_RATING_MIN      || '75', 10); // % of 4+ star
const ROLLING_LEAD_WINDOW = 10;  // rolling window for rating + response stats

/**
 * Compute SLA stats for a single contractor from their last N routed leads.
 * Returns:
 *   {
 *     contractor_id, business_name, email,
 *     rolling_avg_response_hours,   // null if no data
 *     rolling_rating_pct,           // % of 4+ star in last N rated leads (null if <2 rated)
 *     breach_streak,                // consecutive leads with response > SLA_RESPONSE_HOURS
 *     leads_evaluated,
 *     at_risk_reason                // null | 'response_time' | 'rating'
 *   }
 */
async function getContractorSlaStats(contractorId) {
  // Last ROLLING_LEAD_WINDOW routed leads for this contractor
  const leadsRes = await pool.query(
    `SELECT l.id, l.created_at, l.first_response_at, l.homeowner_rating
     FROM leads l
     WHERE l.routed_to_contractor_id = $1
     ORDER BY l.created_at DESC
     LIMIT $2`,
    [contractorId, ROLLING_LEAD_WINDOW]
  );
  const leads = leadsRes.rows;

  if (leads.length === 0) {
    return null;
  }

  // Rolling response time (hours) for leads that have a first_response_at
  const respondedLeads = leads.filter(l => l.first_response_at);
  let rollingAvgResponseHours = null;
  if (respondedLeads.length > 0) {
    const totalHours = respondedLeads.reduce((sum, l) => {
      const diff = (new Date(l.first_response_at) - new Date(l.created_at)) / 3600000;
      return sum + diff;
    }, 0);
    rollingAvgResponseHours = Math.round(totalHours / respondedLeads.length);
  }

  // Rating % (4+ stars) among rated leads
  const ratedLeads = leads.filter(l => l.homeowner_rating !== null);
  let rollingRatingPct = null;
  if (ratedLeads.length >= 2) {
    const goodCount = ratedLeads.filter(l => l.homeowner_rating >= 4).length;
    rollingRatingPct = Math.round((goodCount / ratedLeads.length) * 100);
  }

  // Breach streak = consecutive leads (most recent first) where response > SLA threshold
  // A lead with no response_at counts as a breach only if it's old enough
  let breachStreak = 0;
  for (const lead of leads) {
    const ageHours = (Date.now() - new Date(lead.created_at)) / 3600000;
    let isBreached = false;
    if (lead.first_response_at) {
      const respHours = (new Date(lead.first_response_at) - new Date(lead.created_at)) / 3600000;
      isBreached = respHours > SLA_RESPONSE_HOURS;
    } else if (ageHours > SLA_RESPONSE_HOURS) {
      // No response and window expired = breach
      isBreached = true;
    }
    if (isBreached) {
      breachStreak++;
    } else {
      break; // streak ends on first non-breach
    }
  }

  // Determine at_risk reason
  let atRiskReason = null;
  if (breachStreak >= SLA_BREACH_STREAK) atRiskReason = 'response_time';
  if (rollingRatingPct !== null && rollingRatingPct < SLA_RATING_MIN) {
    atRiskReason = atRiskReason ? 'response_time_and_rating' : 'rating';
  }

  return {
    contractor_id: contractorId,
    rolling_avg_response_hours: rollingAvgResponseHours,
    rolling_rating_pct: rollingRatingPct,
    breach_streak: breachStreak,
    leads_evaluated: leads.length,
    at_risk_reason: atRiskReason,
    sla_response_hours: SLA_RESPONSE_HOURS,
    sla_rating_min: SLA_RATING_MIN,
    sla_breach_streak: SLA_BREACH_STREAK,
  };
}

/**
 * Get all contractors who have at least one active or at_risk territory claim.
 * Returns [{contractor_id, business_name, email, current_sla_status, claim_ids[]}]
 */
async function getContractorsWithActiveTerritories() {
  const res = await pool.query(
    `SELECT DISTINCT ON (c.id)
       c.id AS contractor_id, c.business_name, c.email,
       ARRAY_AGG(tc.id) OVER (PARTITION BY c.id) AS claim_ids,
       ARRAY_AGG(tc.zip_code) OVER (PARTITION BY c.id) AS zip_codes,
       ARRAY_AGG(tc.status) OVER (PARTITION BY c.id) AS statuses
     FROM contractors c
     JOIN territory_claims tc ON tc.contractor_id = c.id
     WHERE tc.status IN ('active', 'at_risk')
     ORDER BY c.id`
  );
  return res.rows;
}

/**
 * Transition territory claims for a contractor based on SLA evaluation.
 * active → at_risk (first breach)
 * at_risk → suspended (second consecutive breach window)
 * suspended → released (auto-release zips)
 *
 * Returns an array of affected claim rows (with old_status + new_status).
 */
async function transitionTerritoryStatus(contractorId, newStatus) {
  const validTransitions = {
    at_risk: ['active'],       // active → at_risk
    suspended: ['at_risk'],    // at_risk → suspended
    released: ['suspended'],   // suspended → released
  };
  const allowedFrom = validTransitions[newStatus];
  if (!allowedFrom) throw new Error(`Invalid SLA transition target: ${newStatus}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE territory_claims
       SET status = $1
       WHERE contractor_id = $2
         AND status = ANY($3::text[])
       RETURNING *, $4::text AS old_status`,
      [newStatus, contractorId, allowedFrom, allowedFrom[0]]
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get contractor SLA state from territory_claims (last_sla_checked, consecutive_breach_windows).
 * These fields track the nightly evaluation state across runs.
 */
async function getSlaEvaluationState(contractorId) {
  const res = await pool.query(
    `SELECT
       contractor_id,
       COUNT(*) FILTER (WHERE status IN ('active','at_risk')) AS active_count,
       BOOL_OR(status = 'at_risk') AS is_at_risk,
       BOOL_OR(status = 'suspended') AS is_suspended
     FROM territory_claims
     WHERE contractor_id = $1
     GROUP BY contractor_id`,
    [contractorId]
  );
  return res.rows[0] || null;
}

/**
 * Record a homeowner rating on a lead by its opaque rating_token.
 * Returns the updated lead row, or null if token not found or already rated.
 */
async function recordRating(ratingToken, rating) {
  const result = await pool.query(
    `UPDATE leads
     SET homeowner_rating = $1
     WHERE rating_token = $2
       AND homeowner_rating IS NULL
     RETURNING *`,
    [rating, ratingToken]
  );
  return result.rows[0] || null;
}

/**
 * Get a lead by its rating token (for displaying the rating page).
 */
async function getLeadByRatingToken(ratingToken) {
  const result = await pool.query(
    `SELECT id, address, project_type, homeowner_name, homeowner_rating,
            routed_to_contractor_id, created_at
     FROM leads
     WHERE rating_token = $1`,
    [ratingToken]
  );
  return result.rows[0] || null;
}

/**
 * Get leads that need a rating email (7+ days old, routed, no rating email sent yet,
 * no rating yet, has homeowner_email, has rating_token).
 */
async function getLeadsForRatingEmail() {
  const result = await pool.query(
    `SELECT l.*, c.business_name AS contractor_business_name
     FROM leads l
     LEFT JOIN contractors c ON c.id = l.routed_to_contractor_id
     WHERE l.created_at < NOW() - INTERVAL '7 days'
       AND l.homeowner_email IS NOT NULL
       AND l.rating_token IS NOT NULL
       AND l.rating_email_sent_at IS NULL
       AND l.homeowner_rating IS NULL
     ORDER BY l.created_at ASC
     LIMIT 50`
  );
  return result.rows;
}

/**
 * Mark rating email as sent for a lead.
 */
async function markRatingEmailSent(leadId) {
  await pool.query(
    `UPDATE leads SET rating_email_sent_at = NOW() WHERE id = $1`,
    [leadId]
  );
}

/**
 * Assign a rating token to leads that don't have one yet.
 * Called on lead creation or retroactively by the rating-email job.
 * Returns the generated token.
 */
async function ensureRatingToken(leadId) {
  // Try to get existing token first
  const existing = await pool.query(
    `SELECT rating_token FROM leads WHERE id = $1`,
    [leadId]
  );
  if (existing.rows[0]?.rating_token) return existing.rows[0].rating_token;

  // Generate a secure opaque token
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const res = await pool.query(
    `UPDATE leads SET rating_token = $1 WHERE id = $2 AND rating_token IS NULL RETURNING rating_token`,
    [token, leadId]
  );
  return res.rows[0]?.rating_token || token;
}

module.exports = {
  getContractorSlaStats,
  getContractorsWithActiveTerritories,
  transitionTerritoryStatus,
  getSlaEvaluationState,
  recordRating,
  getLeadByRatingToken,
  getLeadsForRatingEmail,
  markRatingEmailSent,
  ensureRatingToken,
  SLA_RESPONSE_HOURS,
  SLA_BREACH_STREAK,
  SLA_RATING_MIN,
};
