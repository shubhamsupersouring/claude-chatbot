const { Pool } = require('pg');
require('dotenv').config();

const pgPool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Testing Query...');
    const res = await pgPool.query("SELECT * FROM job_interactions WHERE status = 'hired' LIMIT 10");
    console.log('Results:', res.rows.length);
    console.log('Fist Row:', res.rows[0]);
    await pgPool.end();
  } catch (err) {
    console.error('Query Error:', err.message);
    await pgPool.end();
  }
}

run();
