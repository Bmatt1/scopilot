/**
 * Add subscription-tracking columns to contractors.
 *
 * - stripe_subscription_id: the Stripe subscription this contractor is on.
 *   Needed when we want to look them up from incoming webhook events, and
 *   when calling Stripe's customer portal in the future.
 * - plan_period_end: timestamp when the current plan period expires. Set
 *   from Stripe's `current_period_end` on webhook events. Useful for
 *   surfacing "renews on X" in the admin panel and for grace-period logic
 *   if a subscription gets canceled but should keep access until period end.
 *
 * The existing `stripe_customer_id` column (used by the founding flow) is
 * reused for subscriptions too — every contractor maps 1:1 to a Stripe
 * customer regardless of which kind of payment they made.
 *
 * Safe to re-run: every ALTER uses IF NOT EXISTS.
 */
module.exports = {
  name: 'contractors_subscription_columns',
  up: async (client) => {
    await client.query(`
      ALTER TABLE contractors
      ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)
    `);
    await client.query(`
      ALTER TABLE contractors
      ADD COLUMN IF NOT EXISTS plan_period_end TIMESTAMPTZ
    `);
    // Lookup by subscription id (needed by webhook handler — given the
    // subscription id from a Stripe event, find which contractor it belongs to).
    await client.query(`
      CREATE INDEX IF NOT EXISTS contractors_stripe_subscription_id_idx
      ON contractors (stripe_subscription_id)
    `);
  },
};
