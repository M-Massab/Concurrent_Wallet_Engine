const { Router } = require('express');
const ctrl   = require('../controllers/walletController');
const { validate, createUserSchema, createWalletSchema, transferSchema } = require('../middleware/validation');

const router = Router();

// ─── Health ───────────────────────────────────────────────────────
router.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Users ────────────────────────────────────────────────────────
// POST /api/users
router.post('/users', validate(createUserSchema), ctrl.createUser);

// ─── Wallets ──────────────────────────────────────────────────────
// POST /api/wallets
router.post('/wallets', validate(createWalletSchema), ctrl.createWallet);

// GET  /api/wallets/:walletId
router.get('/wallets/:walletId', ctrl.getWallet);

// ─── Transfers ────────────────────────────────────────────────────
// POST /api/transfers  (Idempotency-Key header required)
router.post('/transfers', validate(transferSchema), ctrl.transfer);

// ─── Transactions (audit log) ─────────────────────────────────────
// GET  /api/transactions/:transactionId
router.get('/transactions/:transactionId', ctrl.getTransaction);

module.exports = router;
