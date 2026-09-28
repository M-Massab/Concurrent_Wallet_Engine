const Redis = require('ioredis');
const { logger } = require('./logger');
require('dotenv').config();

const redis = new Redis({
  host:                 process.env.REDIS_HOST     || 'localhost',
  port:                 parseInt(process.env.REDIS_PORT) || 6379,
  password:             process.env.REDIS_PASSWORD || undefined,
  // Retry with backoff — don't hammer Redis if it's restarting
  retryStrategy: (times) => {
    if (times > 10) {
      logger.error('Redis: Max retries reached, giving up');
      return null;
    }
    return Math.min(times * 100, 3000); // 100ms, 200ms, ... up to 3s
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck:     true,
  lazyConnect:          false,
});

redis.on('ready',        () => logger.info('Redis: Connected and ready'));
redis.on('error',  (err) => logger.error('Redis error', { error: err.message }));
redis.on('reconnecting', () => logger.warn('Redis: Reconnecting...'));

module.exports = { redis };
