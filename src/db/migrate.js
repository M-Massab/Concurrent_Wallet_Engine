const fs     = require('fs');
const path   = require('path');
const { pool }   = require('../config/database');
const { logger } = require('../config/logger');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('Database migration completed successfully');
  } catch (err) {
    logger.error('Database migration FAILED', { error: err.message });
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
