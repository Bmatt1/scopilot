/**
 * Add an `is_admin` boolean to contractors so admin-panel access can be
 * granted to a logged-in contractor instead of (or in addition to) the
 * URL-key password gate.
 *
 * Bootstrap: flips `concretemattingly@gmail.com` to is_admin=true so the
 * operator can immediately reach /admin via their normal contractor login.
 * Add or remove admins later by setting is_admin directly in the DB.
 *
 * Safe to re-run: ADD COLUMN IF NOT EXISTS + UPDATE is a no-op once applied.
 */
module.exports = {
  name: 'contractor_is_admin',
  up: async (client) => {
    await client.query(`
      ALTER TABLE contractors
      ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false
    `);
    await client.query(`
      UPDATE contractors
      SET is_admin = true
      WHERE LOWER(email) = LOWER($1)
    `, ['concretemattingly@gmail.com']);
  },
};
