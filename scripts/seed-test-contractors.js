/**
 * Idempotently creates two test contractor accounts for end-to-end testing.
 * Documented credentials are in docs/ACCESS.md.
 *
 * Usage: npm run seed:test-contractors
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TEST_CONTRACTORS = [
  {
    email: 'test-contractor-1@scopilot.test',
    password: 'TestPass123!',
    business_name: 'Test Concrete Co',
    owner_name: 'Test Owner One',
    phone: '5550000001',
    trade_type: 'concrete',
    service_area: 'Denver Metro',
    unique_slug: 'test-concrete-co-concrete',
    founding_member: true,
    plan: 'founding',
  },
  {
    email: 'test-contractor-2@scopilot.test',
    password: 'TestPass456!',
    business_name: 'Test Excavation LLC',
    owner_name: 'Test Owner Two',
    phone: '5550000002',
    trade_type: 'excavation',
    service_area: 'Denver Metro',
    unique_slug: 'test-excavation-llc-excavation',
    founding_member: false,
    plan: 'standard',
  },
];

async function seedTestContractors() {
  const SALT_ROUNDS = 12;

  for (const contractor of TEST_CONTRACTORS) {
    const existing = await pool.query(
      `SELECT id FROM contractors WHERE email = $1`,
      [contractor.email]
    );

    if (existing.rows.length > 0) {
      console.log(`[skip] ${contractor.email} already exists (id=${existing.rows[0].id})`);
      continue;
    }

    const password_hash = await bcrypt.hash(contractor.password, SALT_ROUNDS);

    // Ensure slug is unique by appending -test suffix if taken
    let slug = contractor.unique_slug;
    const slugCheck = await pool.query(
      `SELECT id FROM contractors WHERE unique_slug = $1`,
      [slug]
    );
    if (slugCheck.rows.length > 0) {
      slug = `${slug}-test`;
    }

    const result = await pool.query(
      `INSERT INTO contractors
         (business_name, owner_name, email, password_hash, phone, trade_type, service_area, unique_slug, founding_member, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, email, unique_slug`,
      [
        contractor.business_name,
        contractor.owner_name,
        contractor.email,
        password_hash,
        contractor.phone,
        contractor.trade_type,
        contractor.service_area,
        slug,
        contractor.founding_member,
        contractor.plan,
      ]
    );

    console.log(`[created] ${result.rows[0].email} (id=${result.rows[0].id}, slug=${result.rows[0].unique_slug})`);
  }

  console.log('\nDone. Credentials:');
  for (const c of TEST_CONTRACTORS) {
    console.log(`  ${c.email} / ${c.password}  (${c.founding_member ? 'founding' : 'standard'})`);
  }

  await pool.end();
}

seedTestContractors().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
