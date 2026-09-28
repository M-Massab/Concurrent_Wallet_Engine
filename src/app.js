require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { logger } = require('./config/logger');
const routes     = require('./routes/index');

const app = express();

// ─── Security middleware ───────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: '10kb' })); // Reject oversized payloads

// Rate-limiting: 60 requests per minute per IP.
// A legitimate payment client doesn't need more than that.
app.use('/api', rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { success: false, error: 'Too many requests — slow down' },
}));

// ─── Routes ───────────────────────────────────────────────────────
app.use('/api', routes);

// ─── 404 handler ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global error handler ─────────────────────────────────────────
// Catches any error thrown from controllers/services.
// Maps our AppError codes to HTTP status codes.
// Never leaks stack traces to clients in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status  = err.status || 500;
  const code    = err.code   || 'InternalError';
  const message = err.message || 'An unexpected error occurred';

  if (status >= 500) {
    logger.error('Unhandled server error', {
      code, message, stack: err.stack,
      path: req.path, method: req.method,
    });
  }

  res.status(status).json({
    success: false,
    code,
    error: status >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'  // Never expose internals in prod
      : message,
  });
});

// ─── Start ────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  logger.info(`Wallet API listening`, { port: PORT, env: process.env.NODE_ENV || 'development' });
});

module.exports = app;
