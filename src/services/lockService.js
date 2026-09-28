/**
 * DISTRIBUTED LOCK SERVICE (Simplified Redlock)
 * ================================================
 * Problem it solves: Two HTTP requests arrive at the EXACT same millisecond
 * for the same wallet. Before we even touch PostgreSQL, we want only ONE
 * of them to proceed. The other waits or fails fast.
 *
 * How it works:
 *   Redis SET key value PX ttl NX
 *     - NX: Only set if key does NOT exist (atomic test-and-set)
 *     - PX: Auto-expire in `ttl` milliseconds (prevents deadlocks if server crashes)
 *
 * Release uses a Lua script for atomic check-and-delete:
 *   - Without Lua: check(key) → delete(key) has a race between the two commands
 *   - With Lua: Redis executes the script atomically — no other command runs between check & delete
 *
 * DEADLOCK PREVENTION:
 *   We always generate the lock key by sorting both wallet IDs alphabetically.
 *   Transfer(A→B) and Transfer(B→A) both produce the SAME lock key.
 *   So they can't acquire different locks and wait on each other.
 */

const { redis } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../config/logger');

const DEFAULT_TTL_MS  = 8000; // Max time we hold the lock
const RETRY_DELAY_MS  = 50;   // Base retry wait
const MAX_RETRIES     = 15;   // Max attempts before failing

// Atomic check-and-delete (the only correct way to release a Redis lock)
const RELEASE_LUA = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

/**
 * Acquire an exclusive distributed lock.
 * Retries with exponential backoff + jitter to avoid thundering herd.
 *
 * @param {string} resource - Unique name for what we're locking
 * @param {number} ttl      - Lock expiry in ms (failsafe if server crashes)
 * @returns {{ key, value }} - Token needed to release the lock
 */
async function acquireLock(resource, ttl = DEFAULT_TTL_MS) {
  const lockKey   = `lock:wallet:${resource}`;
  const lockValue = uuidv4(); // Unique value so only we can release our own lock

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await redis.set(lockKey, lockValue, 'PX', ttl, 'NX');

    if (result === 'OK') {
      logger.debug(`Lock acquired on attempt ${attempt}`, { lockKey });
      return { key: lockKey, value: lockValue };
    }

    // Exponential backoff with jitter prevents all waiters retrying simultaneously
    const backoff = RETRY_DELAY_MS * Math.pow(1.5, attempt - 1);
    const jitter  = Math.random() * 30;
    const wait    = Math.min(backoff + jitter, 1000); // Cap at 1s per retry

    logger.debug(`Lock contended, retrying in ${wait.toFixed(0)}ms`, { lockKey, attempt });
    await sleep(wait);
  }

  // After all retries, give up — the system is under heavy load
  const err = new Error(`Could not acquire lock on "${resource}" after ${MAX_RETRIES} attempts`);
  err.name   = 'LockAcquisitionError';
  err.status = 429; // Too Many Requests — ask client to retry later
  throw err;
}

/**
 * Release the lock. The Lua script ensures:
 *   1. We only delete OUR lock (not one set by a different request after ours expired)
 *   2. The GET and DEL happen atomically — no race window
 */
async function releaseLock({ key, value }) {
  try {
    const released = await redis.eval(RELEASE_LUA, 1, key, value);
    if (released === 0) {
      // Lock expired before we released it — the TTL saved us from a deadlock,
      // but it means our transaction took longer than expected. Worth alerting on.
      logger.warn('Lock had already expired before explicit release', { key });
    } else {
      logger.debug('Lock released', { key });
    }
  } catch (err) {
    // Non-fatal: the TTL will auto-expire the lock. Log and move on.
    logger.error('Failed to release lock (will auto-expire)', { key, error: err.message });
  }
}

/**
 * Generate a canonical lock key for a wallet pair.
 * Sorting ensures Transfer(A→B) and Transfer(B→A) compete for the SAME lock.
 * Without this, they'd each hold one lock and wait for the other → classic deadlock.
 */
function getWalletPairLockKey(walletId1, walletId2) {
  return [walletId1, walletId2].sort().join('::');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { acquireLock, releaseLock, getWalletPairLockKey };
