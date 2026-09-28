const Joi = require('joi');

// ─── Schemas ──────────────────────────────────────────────────────

const createUserSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  email:    Joi.string().email().required(),
});

const createWalletSchema = Joi.object({
  userId:         Joi.string().uuid().required(),
  currency:       Joi.string().length(3).uppercase().default('USD'),
  initialBalance: Joi.number().min(0).precision(2).default(0),
});

const transferSchema = Joi.object({
  senderWalletId:   Joi.string().uuid().required(),
  receiverWalletId: Joi.string().uuid().required(),
  amount:           Joi.number().positive().precision(2).max(1_000_000).required()
    .messages({ 'number.max': 'Single transfer limit is 1,000,000' }),
})
// Custom cross-field rule: can't send money to yourself
.custom((value, helpers) => {
  if (value.senderWalletId === value.receiverWalletId) {
    return helpers.error('any.invalid');
  }
  return value;
})
.messages({ 'any.invalid': 'senderWalletId and receiverWalletId must be different' });

// ─── Middleware factory ───────────────────────────────────────────

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly:   false, // Return ALL validation errors, not just the first
      stripUnknown: true,  // Drop any unknown fields before they reach the service
    });

    if (error) {
      return res.status(400).json({
        success: false,
        code:    'ValidationError',
        errors:  error.details.map(d => d.message),
      });
    }

    req.body = value; // Replace with the validated + coerced value
    next();
  };
}

module.exports = { validate, createUserSchema, createWalletSchema, transferSchema };
