/**
 * Owns: all DB queries for territory_claims table.
 * Does NOT own: HTTP handling, Stripe subscriptions, email — those stay in routes/services.
 */
const pool = require('./index');

// Max zips a contractor may hold (plan limit: 3 total, 1 free)
const MAX_ZIPS_PER_CONTRACTOR = 3;
const FREE_ZIP_COUNT = 1;
const ADDITIONAL_ZIP_PRICE_CENTS = 7900; // $79/mo

/**
 * Get all active territory claims for a contractor.
 */
async function getClaimsByContractor(contractorId) {
  const result = await pool.query(
    `SELECT * FROM territory_claims
     WHERE contractor_id = $1 AND status != 'released'
     ORDER BY claimed_at ASC`,
    [contractorId]
  );
  return result.rows;
}

/**
 * Check if a zip code has an active claim. Returns the claim row or null.
 */
async function getActiveClaimForZip(zipCode) {
  const result = await pool.query(
    `SELECT tc.*, c.business_name
     FROM territory_claims tc
     JOIN contractors c ON c.id = tc.contractor_id
     WHERE tc.zip_code = $1 AND tc.status = 'active'`,
    [zipCode]
  );
  return result.rows[0] || null;
}

/**
 * Create a new territory claim for a contractor.
 * Throws if zip already active or contractor is at cap.
 */
async function createClaim({ contractorId, zipCode, isIncludedInPlan, monthlyPriceCents, stripeSubscriptionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check cap — count non-released claims
    const capCheck = await client.query(
      `SELECT COUNT(*) AS cnt FROM territory_claims
       WHERE contractor_id = $1 AND status != 'released'`,
      [contractorId]
    );
    if (parseInt(capCheck.rows[0].cnt, 10) >= MAX_ZIPS_PER_CONTRACTOR) {
      throw new Error('CAP_REACHED');
    }

    // Attempt insert — unique index will throw if zip already active
    const result = await client.query(
      `INSERT INTO territory_claims
         (contractor_id, zip_code, status, monthly_price_cents, is_included_in_plan, stripe_subscription_id)
       VALUES ($1, $2, 'active', $3, $4, $5)
       RETURNING *`,
      [contractorId, zipCode, monthlyPriceCents || 0, isIncludedInPlan || false, stripeSubscriptionId || null]
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    // Unique index violation → zip already claimed
    if (err.code === '23505') throw new Error('ZIP_TAKEN');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release a claim — marks status='released'. Returns the updated row.
 * Verifies contractor_id ownership before releasing.
 */
async function releaseClaim(claimId, contractorId) {
  const result = await pool.query(
    `UPDATE territory_claims
     SET status = 'released'
     WHERE id = $1 AND contractor_id = $2 AND status = 'active'
     RETURNING *`,
    [claimId, contractorId]
  );
  return result.rows[0] || null;
}

/**
 * Get a single claim by id (any status).
 */
async function getClaimById(claimId) {
  const result = await pool.query(
    `SELECT * FROM territory_claims WHERE id = $1`,
    [claimId]
  );
  return result.rows[0] || null;
}

/**
 * Count active (non-released) claims for a contractor.
 * Used to determine whether next zip is free or paid.
 */
async function countActiveClaims(contractorId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM territory_claims
     WHERE contractor_id = $1 AND status != 'released'`,
    [contractorId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Admin-level: all territory claims with contractor names and lead counts per zip.
 */
async function getAllClaimsForMap() {
  const result = await pool.query(`
    SELECT
      tc.id AS claim_id,
      tc.zip_code,
      tc.status,
      tc.monthly_price_cents,
      tc.is_included_in_plan,
      tc.claimed_at,
      c.id AS contractor_id,
      c.business_name AS contractor_name,
      c.unique_slug AS contractor_slug,
      c.is_suspended,
      COALESCE((
        SELECT COUNT(*)
        FROM leads l
        WHERE l.zip_code = tc.zip_code
          AND l.routed_to_contractor_id = c.id
      ), 0)::int AS leads_received
    FROM territory_claims tc
    JOIN contractors c ON c.id = tc.contractor_id
    WHERE tc.status != 'released'
    ORDER BY tc.claimed_at DESC
  `);
  return result.rows;
}

/**
 * Get all active claimed ZIP codes (used for adjacency exclusion in territory checker).
 */
async function getActiveClaimedZips() {
  const result = await pool.query(`SELECT zip_code FROM territory_claims WHERE status = 'active'`);
  return result.rows.map(r => r.zip_code);
}

/**
 * Get recently-checked ZIPs (candidate seeding for adjacent open ZIP suggestions).
 */
async function getRecentlyCheckedZips(excludeZip, limit = 200) {
  const result = await pool.query(
    `SELECT DISTINCT zip FROM territory_checks WHERE zip != $1 LIMIT $2`,
    [excludeZip, limit]
  );
  return result.rows.map(r => r.zip);
}

/**
 * Log a public ZIP availability check for market analytics.
 */
async function logTerritoryCheck({ zip, ipHash, userAgent, claimedAtCheck }) {
  await pool.query(
    `INSERT INTO territory_checks (zip, ip_hash, user_agent, claimed_at_check)
     VALUES ($1, $2, $3, $4)`,
    [zip, ipHash || null, userAgent || null, !!claimedAtCheck]
  );
}

/**
 * Add an email to the waitlist for a claimed ZIP.
 * Returns { inserted: true } or { inserted: false } (duplicate).
 */
async function addToWaitlist({ zip, email, ipHash }) {
  try {
    await pool.query(
      `INSERT INTO territory_waitlist (zip, email, ip_hash)
       VALUES ($1, $2, $3)`,
      [zip, email.toLowerCase().trim(), ipHash || null]
    );
    return { inserted: true };
  } catch (err) {
    // Unique constraint (zip + email already exists)
    if (err.code === '23505') return { inserted: false };
    throw err;
  }
}

/**
 * Most-queried unclaimed ZIPs — used to inform market expansion priorities.
 * Returns top N ZIPs by check count, excluding those with active claims.
 */
async function getTopQueriedOpenZips(limit = 20) {
  const result = await pool.query(
    `SELECT tc.zip, COUNT(*) AS checks
     FROM territory_checks tc
     LEFT JOIN territory_claims tcc ON tcc.zip_code = tc.zip AND tcc.status = 'active'
     WHERE tcc.zip_code IS NULL
     GROUP BY tc.zip
     ORDER BY checks DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  getClaimsByContractor,
  getActiveClaimForZip,
  createClaim,
  releaseClaim,
  getClaimById,
  countActiveClaims,
  getAllClaimsForMap,
  getActiveClaimedZips,
  getRecentlyCheckedZips,
  logTerritoryCheck,
  addToWaitlist,
  getTopQueriedOpenZips,
  MAX_ZIPS_PER_CONTRACTOR,
  FREE_ZIP_COUNT,
  ADDITIONAL_ZIP_PRICE_CENTS,
};
