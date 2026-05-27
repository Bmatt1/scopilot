/**
 * Backfill contractors.plan = 'free' for any row where plan is NULL, and set
 * 'free' as the column default so future INSERTs that omit plan still land
 * in a sensible state.
 *
 * Context: prior to plan-based caps shipping, `createContractor()` did not
 * pass a plan, so standard signups had plan = NULL. Now caps look up the
 * plan column to decide how many zips a contractor can hold, so NULL is
 * ambiguous. We treat any NULL as 'free' (board access only, zero zips)
 * which forces the contractor to upgrade through the pricing page before
 * claiming a territory.
 *
 * Operator-gifted (plan = 'legacy') and paid founding (plan = 'lifetime')
 * accounts are untouched — they already have an explicit plan value and
 * are uncapped via legacy_free / founding_member boolean flags anyway.
 *
 * Safe to re-run: the UPDATE is a no-op on rows that already have a plan;
 * the ALTER COLUMN SET DEFAULT is idempotent on the column.
 */
module.exports = {
  name: 'backfill_contractor_plan_default',
  up: async (client) => {
    await client.query(`
      UPDATE contractors
      SET plan = 'free'
      WHERE plan IS NULL
    `);

    await client.query(`
      ALTER TABLE contractors
      ALTER COLUMN plan SET DEFAULT 'free'
    `);
  },
};
