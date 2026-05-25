/**
 * Nightly cleanup of auth_logs older than 30 days.
 * Runs via polsia.toml [[crons]] — never inline in server.js.
 */
require('dotenv').config();

const pool = require('../db/index');

async function run() {
  console.log('[cleanup-auth-logs] Starting:', new Date().toISOString());

  try {
    const result = await pool.query(
      `DELETE FROM auth_logs WHERE timestamp < NOW() - INTERVAL '30 days'`
    );
    const count = result.rowCount || 0;
    console.log(`[cleanup-auth-logs] Deleted ${count} old auth log rows`);
  } catch (err) {
    console.error('[cleanup-auth-logs] Failed:', err.message);
    process.exit(1);
  }

  process.exit(0);
}

run().catch(err => {
  console.error('[cleanup-auth-logs] Fatal:', err);
  process.exit(1);
});