/**
 * Owns: queries for the opportunity board — unclaimed + passed leads visible to contractors.
 * Does NOT own: HTTP handling, email sending, territory claim logic.
 */
const pool = require('./index');

/**
 * Fetch leads visible on the opportunity board:
 *   (a) no routed_to_contractor_id (unclaimed zip), not yet claimed from board
 *   (b) lead_status = 'passed' and not yet claimed from board
 *
 * Optional filters:
 *   - tradeType: filter by project_type
 *   - zipCodes: array of zip codes to filter to (for "My nearby zips" chip)
 *
 * Contact fields (homeowner_name, homeowner_email, homeowner_phone) are intentionally
 * excluded here — revealed only after claim via getLeadById.
 */
async function getBoardLeads({ tradeType, zipCodes, limit = 50, offset = 0 } = {}) {
  const params = [];
  const conditions = [
    `l.claimed_from_board_by IS NULL`,
    `(l.routed_to_contractor_id IS NULL OR l.lead_status = 'passed')`
  ];

  if (tradeType) {
    params.push(tradeType);
    conditions.push(`l.project_type = $${params.length}`);
  }

  if (zipCodes && zipCodes.length > 0) {
    params.push(zipCodes);
    conditions.push(`l.zip_code = ANY($${params.length})`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  params.push(limit, offset);

  const result = await pool.query(
    `SELECT
       l.id,
       l.zip_code,
       l.project_type,
       l.sq_footage,
       l.estimate_low,
       l.estimate_high,
       l.latitude,
       l.longitude,
       l.project_area_geojson,
       l.lead_status,
       l.board_visible_at,
       l.created_at,
       l.routed_to_contractor_id,
       l.passed_at,
       COALESCE(pr.pass_count, 0) AS pass_count,
       COALESCE(
         json_agg(lp.photo_url ORDER BY lp.created_at) FILTER (WHERE lp.photo_url IS NOT NULL),
         '[]'
       ) AS photos
     FROM leads l
     LEFT JOIN lead_photos lp ON lp.lead_id = l.id
     LEFT JOIN (
       SELECT lead_id, COUNT(*) AS pass_count FROM lead_pass_reasons GROUP BY lead_id
     ) pr ON pr.lead_id = l.id
     ${where}
     GROUP BY l.id, pr.pass_count
     ORDER BY COALESCE(l.board_visible_at, l.created_at) DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

/**
 * Get contractors with active territory claims in a given zip code or its
 * adjacent zips (simple adjacency: zips within ±5 of the numeric zip value).
 * Used to notify neighbors when a lead is passed.
 */
async function getContractorsNearZip(zipCode) {
  const zipNum = parseInt(zipCode, 10);
  if (isNaN(zipNum)) return [];

  // Adjacent = numeric neighbors within ±5. Crude but works for contiguous US.
  const result = await pool.query(
    `SELECT DISTINCT c.id, c.email, c.business_name, tc.zip_code AS claimed_zip
     FROM territory_claims tc
     JOIN contractors c ON c.id = tc.contractor_id
     WHERE tc.status = 'active'
       AND ABS(tc.zip_code::INTEGER - $1) <= 5`,
    [zipNum]
  );
  return result.rows;
}

module.exports = { getBoardLeads, getContractorsNearZip };
