const { Pool } = require('pg');
const { logger } = require('./logger');
require('dotenv').config();

// pg Pool = connection pooling out of the box.
// max: 20 means up to 20 simultaneous PG connections.
// Each concurrent HTTP request grabs one from the pool,
// runs its transaction, then releases it back.
const pool = new Pool({
  host:                   process.env.DB_HOST     || 'localhost',
  port:                   parseInt(process.env.DB_PORT) || 5432,
  database:               process.env.DB_NAME     || 'wallet_db',
  user:                   process.env.DB_USER     || 'postgres',
  password:               process.env.DB_PASSWORD || 'postgres_secret',
  max:                    20,    // max connections in pool
  idleTimeoutMillis:      30000, // close idle connections after 30s
  connectionTimeoutMillis:2000,  // fail fast if no connection available in 2s
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool unexpected error', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New PostgreSQL connection established');
});

module.exports = { pool };
