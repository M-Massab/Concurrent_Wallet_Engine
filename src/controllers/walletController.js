/**
 * WALLET CONTROLLER
 * =================
 * Deliberately thin. Its only job:
 *   1. Extract data from the HTTP request
 *   2. Call the service
 *   3. Shape the HTTP response
 *
 * ALL business logic lives in walletService.js, not here.
 * This makes the service testable without spinning up Express.
 */

const walletService = require('../services/walletService');
const { logger }    = require('../config/logger');

// ─── Users ────────────────────────────────────────────────────────

async function createUser(req, res, next) {
  try {
    const user = await walletService.createUser(req.body);
    res.status(201).json({ success: true, data: user });
  } catch (err) { next(err); }
}

// ─── Wallets ──────────────────────────────────────────────────────

async function createWallet(req, res, next) {
  try {
    const wallet = await walletService.createWallet(req.body);
    res.status(201).json({ success: true, data: wallet });
  } catch (err) { next(err); }
}

async function getWallet(req, res, next) {
  try {
    const wallet = await walletService.getWallet(req.params.walletId);
    res.json({ success: true, data: wallet });
  } catch (err) { next(err); }
}

// ─── Transfers ────────────────────────────────────────────────────

async function transfer(req, res, next) {
  try {
    // The Idempotency-Key header is REQUIRED for transfers.
    // Without it we can't deduplicate retries — reject early.
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        code:    'MissingIdempotencyKey',
        error:   'Header "Idempotency-Key" is required for transfer requests. ' +
                 'Generate a UUID per payment attempt and reuse it on retries.'
      });
    }

    const { senderWalletId, receiverWalletId, amount } = req.body;

    const result = await walletService.transfer({
      senderWalletId,
      receiverWalletId,
      amount:         parseFloat(amount),
      idempotencyKey,
    });

    // 201 for a new transfer, 200 for a cached/duplicate idempotent response
    const statusCode = result.fromCache ? 200 : 201;
    res.status(statusCode).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ─── Transactions ─────────────────────────────────────────────────

async function getTransaction(req, res, next) {
  try {
    const tx = await walletService.getTransaction(req.params.transactionId);
    res.json({ success: true, data: tx });
  } catch (err) { next(err); }
}

module.exports = { createUser, createWallet, getWallet, transfer, getTransaction };
