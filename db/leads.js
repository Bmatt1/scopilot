/**
 * Owns: all DB queries for leads and lead_photos tables.
 * Does NOT own: HTTP handling, email sending, file uploads — those stay in routes/services.
 */
const pool = require('./index');

async function createLead(data) {
  const {
    address, latitude, longitude, project_area_geojson, sq_footage,
    project_type, trade_inputs,
    tear_out, reinforcement, finish_type, has_drainage,
    notes, homeowner_name, homeowner_email, homeowner_phone,
    estimate_low, estimate_high, contractor_email, contractor_id,
    zip_code, routed_to_contractor_id
  } = data;

  const result = await pool.query(
    `INSERT INTO leads
      (address, latitude, longitude, project_area_geojson, sq_footage,
       project_type, trade_inputs,
       tear_out, reinforcement, finish_type, has_drainage,
       notes, homeowner_name, homeowner_email, homeowner_phone,
       estimate_low, estimate_high, contractor_email, contractor_id,
       zip_code, routed_to_contractor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [address, latitude, longitude, project_area_geojson, sq_footage,
     project_type, JSON.stringify(trade_inputs || {}),
     tear_out, reinforcement, finish_type, has_drainage,
     notes, homeowner_name, homeowner_email, homeowner_phone,
     estimate_low, estimate_high, contractor_email, contractor_id || null,
     zip_code || null, routed_to_contractor_id || null]
  );
  return result.rows[0];
}

async function addLeadPhoto(leadId, photoUrl) {
  const result = await pool.query(
    `INSERT INTO lead_photos (lead_id, photo_url) VALUES ($1, $2) RETURNING *`,
    [leadId, photoUrl]
  );
  return result.rows[0];
}

async function getLeads({ status, contractorId, limit = 50, offset = 0 } = {}) {
  let query = `
    SELECT l.*,
      COALESCE(
        json_agg(lp.photo_url ORDER BY lp.created_at) FILTER (WHERE lp.photo_url IS NOT NULL),
        '[]'
      ) AS photos
    FROM leads l
    LEFT JOIN lead_photos lp ON lp.lead_id = l.id
  `;
  const params = [];
  const conditions = [];
  if (status) {
    params.push(status);
    conditions.push(`l.status = $${params.length}`);
  }
  if (contractorId) {
    params.push(contractorId);
    conditions.push(`l.contractor_id = $${params.length}`);
  }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  params.push(limit, offset);
  query += ` GROUP BY l.id ORDER BY l.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const result = await pool.query(query, params);
  return result.rows;
}

async function getLeadById(id) {
  const result = await pool.query(
    `SELECT l.*,
      COALESCE(
        json_agg(lp.photo_url ORDER BY lp.created_at) FILTER (WHERE lp.photo_url IS NOT NULL),
        '[]'
      ) AS photos
     FROM leads l
     LEFT JOIN lead_photos lp ON lp.lead_id = l.id
     WHERE l.id = $1
     GROUP BY l.id`,
    [id]
  );
  return result.rows[0] || null;
}

async function updateLeadStatus(id, status) {
  const result = await pool.query(
    `UPDATE leads SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

/**
 * Mark a lead as passed. Sets lead_status='passed', passed_at, passed_by_contractor_id,
 * board_visible_at. Verifies the contractor is the routed owner before updating.
 * Returns the updated row, or null if not found / not authorized.
 */
async function passLead(leadId, contractorId) {
  const result = await pool.query(
    `UPDATE leads
     SET lead_status = 'passed',
         passed_at = NOW(),
         passed_by_contractor_id = $2,
         board_visible_at = NOW()
     WHERE id = $1
       AND routed_to_contractor_id = $2
       AND (lead_status IS NULL OR lead_status = 'routed')
     RETURNING *`,
    [leadId, contractorId]
  );
  return result.rows[0] || null;
}

/**
 * Log a pass reason to lead_pass_reasons.
 */
async function insertPassReason(leadId, contractorId, reason) {
  const result = await pool.query(
    `INSERT INTO lead_pass_reasons (lead_id, contractor_id, reason)
     VALUES ($1, $2, $3) RETURNING *`,
    [leadId, contractorId, reason || null]
  );
  return result.rows[0];
}

/**
 * Atomically claim a lead from the board. Returns the claimed lead row on success,
 * null if already claimed by someone else.
 */
async function claimLeadFromBoard(leadId, contractorId) {
  const result = await pool.query(
    `UPDATE leads
     SET claimed_from_board_by = $1,
         claimed_from_board_at = NOW(),
         lead_status = 'claimed_from_board'
     WHERE id = $2
       AND claimed_from_board_by IS NULL
       AND (
         routed_to_contractor_id IS NULL
         OR lead_status = 'passed'
       )
     RETURNING *`,
    [contractorId, leadId]
  );
  return result.rows[0] || null;
}

/**
 * Get the count of contractors who passed on a specific lead.
 */
async function getPassCount(leadId) {
  const result = await pool.query(
    `SELECT COUNT(*) AS cnt FROM lead_pass_reasons WHERE lead_id = $1`,
    [leadId]
  );
  return parseInt(result.rows[0].cnt, 10);
}

/**
 * Set first_response_at on a lead — only writes if not already set.
 * Called on pass, status update to 'contacted', or explicit contact action.
 */
async function setFirstResponseAt(leadId) {
  const result = await pool.query(
    `UPDATE leads
     SET first_response_at = NOW()
     WHERE id = $1 AND first_response_at IS NULL
     RETURNING id, first_response_at`,
    [leadId]
  );
  return result.rows[0] || null;
}

/**
 * Admin-level: all leads with contractor name, photos, full detail.
 * Used by the admin panel lead overview.
 */
async function getAllLeadsForAdmin({ limit = 200, offset = 0 } = {}) {
  const result = await pool.query(`
    SELECT
      l.id,
      l.created_at,
      l.homeowner_name,
      l.homeowner_email,
      l.homeowner_phone,
      l.address,
      l.zip_code,
      l.project_type,
      l.sq_footage,
      l.estimate_low,
      l.estimate_high,
      l.trade_inputs,
      l.notes,
      l.project_area_geojson,
      l.lead_status,
      l.contractor_id,
      l.routed_to_contractor_id,
      l.passed_at,
      l.passed_by_contractor_id,
      l.board_visible_at,
      l.claimed_from_board_at,
      l.claimed_from_board_by,
      l.first_response_at,
      l.homeowner_rating,
      c.business_name AS contractor_name,
      c.email AS contractor_email,
      COALESCE(
        json_agg(lp.photo_url ORDER BY lp.created_at) FILTER (WHERE lp.photo_url IS NOT NULL),
        '[]'
      ) AS photos
    FROM leads l
    LEFT JOIN contractors c ON c.id = l.contractor_id
    LEFT JOIN lead_photos lp ON lp.lead_id = l.id
    GROUP BY l.id, c.id
    ORDER BY l.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return result.rows;
}

/**
 * Lead count breakdown by lead_status for admin analytics.
 */
async function getLeadStatusCounts() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE lead_status IS NULL OR lead_status = 'routed') AS routed,
      COUNT(*) FILTER (WHERE lead_status = 'passed') AS passed,
      COUNT(*) FILTER (WHERE lead_status = 'claimed_from_board') AS claimed_from_board,
      COUNT(*) FILTER (WHERE lead_status = 'expired') AS expired,
      COUNT(*) AS total
    FROM leads
  `);
  return result.rows[0];
}

module.exports = {
  createLead,
  addLeadPhoto,
  getLeads,
  getLeadById,
  updateLeadStatus,
  passLead,
  insertPassReason,
  claimLeadFromBoard,
  getPassCount,
  setFirstResponseAt,
  getAllLeadsForAdmin,
  getLeadStatusCounts,
};