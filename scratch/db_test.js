const { Pool } = require('pg');
require('dotenv').config();

const config = {
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '5432'),
};

async function testConnection(useSSL) {
  console.log(`Testing with SSL: ${useSSL}`);
  const pool = new Pool({
    ...config,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  });

  try {
    const client = await pool.connect();
    console.log(`✅ Success with SSL: ${useSSL}`);
    const res = await client.query('SELECT NOW()');
    console.log('Time:', res.rows[0]);
    client.release();
    await pool.end();
    return true;
  } catch (err) {
    console.error(`❌ Failed with SSL: ${useSSL}`);
    console.error('Error Code:', err.code);
    console.error('Error Message:', err.message);
    await pool.end();
    return false;
  }
}

async function run() {
  console.log('Starting Diagnostics...');
  console.log('Host:', config.host);
  console.log('User:', config.user);
  console.log('DB:', config.database);
  
  const successSSL = await testConnection(true);
  if (!successSSL) {
    await testConnection(false);
  }
}

run();
