/**
 * WALLET SERVICE — Core Business Logic
 * ======================================
 * This file is where all three engineering challenges are solved.
 * Read the transfer() function top-to-bottom for the full picture.
 */

const { pool }   = require('../config/database');
const { redis }  = require('../config/redis');
const { acquireLock, releaseLock, getWalletPairLockKey } = require('./lockService');
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../config/logger');

const IDEMPOTENCY_TTL_SECONDS = 86400; // Cache idempotency results for 24 hours

// ═══════════════════════════════════════════════════════════════════
// TRANSFER — The main event
// ═══════════════════════════════════════════════════════════════════
/**
 * Transfers money from one wallet to another.
 *
 * CHALLENGE 1 — DOUBLE SPENDING
 *   Scenario: User hits "Send $10" twice at the exact same millisecond.
 *   Solution: Two-layer locking:
 *     Layer 1 (App level): Redis distributed lock — only one request enters the
 *                          critical section at a time.
 *     Layer 2 (DB level):  SELECT ... FOR UPDATE — row-level exclusive lock in
 *                          PostgreSQL. Any request that bypasses Redis (e.g., via
 *                          a second app server) still can't read stale balance data.
 *     Layer 3 (Constraint):CHECK (balance >= 0) — absolute DB-level safety net.
 *
 * CHALLENGE 2 — IDEMPOTENCY
 *   Scenario: Network drops. Client retries the same payment.
 *   Solution: Two-layer idempotency:
 *     Layer 1 (Fast path): Redis cache — O(1) lookup, no DB hit.
 *     Layer 2 (Safe path): DB check INSIDE the transaction — handles the edge case
 *                          where two retries hit simultaneously after a Redis miss.
 *                          The UNIQUE constraint on idempotency_key is the failsafe.
 *
 * CHALLENGE 3 — ACID COMPLIANCE
 *   Scenario: DB crashes after debiting sender but before crediting receiver.
 *   Solution: PostgreSQL transaction with BEGIN/COMMIT/ROLLBACK.
 *     Debit + Credit + Transaction record are ONE atomic unit.
 *     PostgreSQL's WAL (Write-Ahead Log) guarantees that a partial commit
 *     is rolled back on crash recovery — money is never lost or created.
 */
async function transfer({ senderWalletId, receiverWalletId, amount, idempotencyKey }) {

  // ───────────────────────────────────────────────────────────────────
  // STEP 1 │ IDEMPOTENCY FAST PATH (Redis)
  // ───────────────────────────────────────────────────────────────────
  // On a payment retry, we want to return the original result immediately
  // without touching the database at all. Redis gives us sub-millisecond lookup.
  const cached = await getFromIdempotencyCache(idempotencyKey);
  if (cached) {
    logger.info('Idempotency hit — returning cached result', { idempotencyKey });
    return { ...cached, fromCache: true };
  }

  // ───────────────────────────────────────────────────────────────────
  // STEP 2 │ DISTRIBUTED LOCK (Redis)
  // ───────────────────────────────────────────────────────────────────
  // Prevent two concurrent requests for the same wallet pair from both
  // passing the idempotency cache miss and racing into the DB together.
  // Lock key is wallet-pair-sorted so Transfer(A→B) and Transfer(B→A)
  // share the same lock (prevents a different class of deadlock at app level).
  const lockResource = getWalletPairLockKey(senderWalletId, receiverWalletId);
  const lock = await acquireLock(lockResource);

  // Grab a DB client from the pool — this client will own our transaction.
  const client = await pool.connect();

  try {
    // ─────────────────────────────────────────────────────────────────
    // STEP 3 │ BEGIN TRANSACTION
    // ─────────────────────────────────────────────────────────────────
    // Everything from here to COMMIT is atomic. If ANYTHING throws,
    // the ROLLBACK in the catch block undoes all DB changes.
    // READ COMMITTED is the default PG isolation level. Combined with
    // SELECT FOR UPDATE below, it's exactly what we need.
    await client.query('BEGIN');

    // ─────────────────────────────────────────────────────────────────
    // STEP 4 │ IDEMPOTENCY SAFE PATH (Database, inside transaction)
    // ─────────────────────────────────────────────────────────────────
    // Edge case: Two retries arrive simultaneously, BOTH miss the Redis
    // cache (e.g., Redis just restarted). Both enter the lock... wait,
    // they can't — only one holds the Redis lock at a time. But if we're
    // running multiple app servers with Redis, this is the final check.
    const existing = await client.query(
      'SELECT * FROM transactions WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      const result = existing.rows[0];
      await saveToIdempotencyCache(idempotencyKey, result); // Warm up cache for next time
      logger.info('Idempotency hit — returning DB result', { idempotencyKey });
      return { ...result, fromCache: true };
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 5 │ PESSIMISTIC ROW LOCKS (SELECT FOR UPDATE)
    // ─────────────────────────────────────────────────────────────────
    // This is the DB-level double-spend prevention.
    //
    // SELECT FOR UPDATE places an EXCLUSIVE LOCK on these two rows.
    // Any other transaction trying to read OR write these wallet rows
    // will BLOCK until our transaction COMMITs or ROLLBACKs.
    //
    // DEADLOCK PREVENTION via sorted lock acquisition:
    //   Thread A: Transfer Wallet_1 → Wallet_2
    //   Thread B: Transfer Wallet_2 → Wallet_1
    //   Without sorting: A locks Wallet_1 then waits for Wallet_2.
    //                    B locks Wallet_2 then waits for Wallet_1. → DEADLOCK!
    //   With sorting:    Both sort their IDs → both try to lock Wallet_1 first.
    //                    One wins, the other waits. → No deadlock.
    //
    // We do two separate queries (not IN (...)) to GUARANTEE sorted acquisition.
    const [firstId, secondId] = [senderWalletId, receiverWalletId].sort();

    const { rows: [firstWallet] } = await client.query(
      `SELECT id, user_id, balance, currency, is_active, version
       FROM wallets WHERE id = $1 FOR UPDATE`,
      [firstId]
    );

    const { rows: [secondWallet] } = await client.query(
      `SELECT id, user_id, balance, currency, is_active, version
       FROM wallets WHERE id = $1 FOR UPDATE`,
      [secondId]
    );

    if (!firstWallet || !secondWallet) {
      await client.query('ROLLBACK');
      throw new AppError('WalletNotFound', 'One or both wallets do not exist', 404);
    }

    // Identify which wallet is sender and which is receiver
    const senderWallet   = firstWallet.id === senderWalletId   ? firstWallet  : secondWallet;
    const receiverWallet = firstWallet.id === receiverWalletId ? firstWallet  : secondWallet;

    // ─────────────────────────────────────────────────────────────────
    // STEP 6 │ BUSINESS VALIDATIONS (using the now-locked data)
    // ─────────────────────────────────────────────────────────────────
    // We validate AFTER locking. If we validated before locking,
    // the balance could change between our check and our update.
    if (!senderWallet.is_active || !receiverWallet.is_active) {
      await client.query('ROLLBACK');
      throw new AppError('WalletInactive', 'One or both wallets are inactive', 422);
    }

    if (senderWallet.currency !== receiverWallet.currency) {
      await client.query('ROLLBACK');
      throw new AppError('CurrencyMismatch',
        `Cannot transfer between ${senderWallet.currency} and ${receiverWallet.currency} wallets`, 422);
    }

    const senderBalance = parseFloat(senderWallet.balance);
    if (senderBalance < amount) {
      await client.query('ROLLBACK');
      throw new AppError('InsufficientFunds',
        `Insufficient balance. Available: ${senderBalance}, Required: ${amount}`, 422);
    }

    // ─────────────────────────────────────────────────────────────────
    // STEP 7 │ DEBIT SENDER
    // ─────────────────────────────────────────────────────────────────
    // The DB constraint CHECK (balance >= 0) means that even if our
    // application-level check above somehow passed with stale data,
    // this UPDATE would fail before creating an overdraft.
    await client.query(
      `UPDATE wallets
       SET    balance = balance - $1, version = version + 1
       WHERE  id = $2`,
      [amount, senderWalletId]
    );

    // ─────────────────────────────────────────────────────────────────
    // STEP 8 │ CREDIT RECEIVER
    // ─────────────────────────────────────────────────────────────────
    // This is the critical moment. If the server crashes RIGHT HERE —
    // after debiting sender but before crediting receiver — the
    // ROLLBACK in the catch block (or PostgreSQL's crash recovery via WAL)
    // will undo the debit. No money is lost. This is ACID's Atomicity.
    await client.query(
      `UPDATE wallets
       SET    balance = balance + $1, version = version + 1
       WHERE  id = $2`,
      [amount, receiverWalletId]
    );

    // ─────────────────────────────────────────────────────────────────
    // STEP 9 │ RECORD THE TRANSACTION (Audit log + Idempotency store)
    // ─────────────────────────────────────────────────────────────────
    // The UNIQUE constraint on idempotency_key here is the absolute
    // last resort. If somehow two identical requests both reach this
    // INSERT (e.g., split-brain scenario), PostgreSQL will reject the
    // second one with a unique violation. We catch that upstream.
    const txId = uuidv4();
    const { rows: [transaction] } = await client.query(
      `INSERT INTO transactions
         (id, idempotency_key, sender_wallet_id, receiver_wallet_id, amount, currency, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', NOW())
       RETURNING *`,
      [txId, idempotencyKey, senderWalletId, receiverWalletId, amount, senderWallet.currency]
    );

    // ─────────────────────────────────────────────────────────────────
    // STEP 10 │ COMMIT
    // ─────────────────────────────────────────────────────────────────
    // This single instruction makes ALL of the above permanent atomically:
    //   • Sender's balance decreased
    //   • Receiver's balance increased
    //   • Transaction record created
    // Either ALL of these persist, or NONE of them do. That's ACID.
    await client.query('COMMIT');

    logger.info('Transfer committed', {
      transactionId: txId,
      senderWalletId,
      receiverWalletId,
      amount,
      currency: senderWallet.currency
    });

    // ─────────────────────────────────────────────────────────────────
    // STEP 11 │ CACHE RESULT (Post-commit, best-effort)
    // ─────────────────────────────────────────────────────────────────
    // IMPORTANT: We cache ONLY after a successful commit.
    // If we cached before commit and then rolled back, retries would get
    // a "success" response for a transaction that never happened.
    // If this Redis write fails, the next retry will hit the DB (Step 4).
    await saveToIdempotencyCache(idempotencyKey, transaction);

    return transaction;

  } catch (err) {
    // Any error in steps 3-10 lands here. We ROLLBACK everything.
    // PostgreSQL will undo the debit even if the credit already ran.
    try {
      await client.query('ROLLBACK');
      logger.debug('Transaction rolled back', { idempotencyKey });
    } catch (rollbackErr) {
      logger.error('ROLLBACK FAILED — this is serious', { error: rollbackErr.message });
    }

    logger.error('Transfer failed', {
      idempotencyKey,
      senderWalletId,
      receiverWalletId,
      amount,
      error: err.message
    });

    throw err; // Re-throw for controller to handle
  } finally {
    client.release();                // Always return connection to pool
    await releaseLock(lock);        // Always release the distributed lock
  }
}

// ═══════════════════════════════════════════════════════════════════
// WALLET CRUD
// ═══════════════════════════════════════════════════════════════════

async function createWallet({ userId, currency = 'USD', initialBalance = 0 }) {
  const { rows: [wallet] } = await pool.query(
    `INSERT INTO wallets (id, user_id, balance, currency)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, balance, currency, is_active, created_at`,
    [uuidv4(), userId, initialBalance, currency.toUpperCase()]
  );
  return wallet;
}

async function getWallet(walletId) {
  const { rows: [wallet] } = await pool.query(
    `SELECT id, user_id, balance, currency, is_active, version, updated_at
     FROM wallets WHERE id = $1`,
    [walletId]
  );
  if (!wallet) throw new AppError('WalletNotFound', `Wallet ${walletId} not found`, 404);
  return wallet;
}

async function getTransaction(transactionId) {
  const { rows: [tx] } = await pool.query(
    'SELECT * FROM transactions WHERE id = $1',
    [transactionId]
  );
  if (!tx) throw new AppError('NotFound', `Transaction ${transactionId} not found`, 404);
  return tx;
}

async function createUser({ username, email }) {
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (id, username, email) VALUES ($1, $2, $3) RETURNING *`,
    [uuidv4(), username, email]
  );
  return user;
}

// ═══════════════════════════════════════════════════════════════════
// IDEMPOTENCY CACHE HELPERS
// ═══════════════════════════════════════════════════════════════════

async function getFromIdempotencyCache(key) {
  try {
    const raw = await redis.get(`idempotency:${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    // Redis is down — degrade gracefully, fall through to DB check
    logger.warn('Redis idempotency read failed, falling back to DB', { error: err.message });
    return null;
  }
}

async function saveToIdempotencyCache(key, value) {
  try {
    await redis.setex(`idempotency:${key}`, IDEMPOTENCY_TTL_SECONDS, JSON.stringify(value));
  } catch (err) {
    // Non-fatal — next call will hit the DB (Step 4)
    logger.warn('Redis idempotency write failed', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOM ERROR CLASS
// ═══════════════════════════════════════════════════════════════════

class AppError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name   = code;
    this.code   = code;
    this.status = status;
  }
}

module.exports = { transfer, createWallet, getWallet, getTransaction, createUser, AppError };
