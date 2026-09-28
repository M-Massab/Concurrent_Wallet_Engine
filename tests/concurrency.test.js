/**
 * CONCURRENCY STRESS TEST
 * ========================
 * Fires concurrent HTTP requests to prove all three guarantees hold:
 *
 *   Test 1 — IDEMPOTENCY
 *     10 parallel requests with the SAME Idempotency-Key.
 *     Expected: exactly ONE debit, all 10 requests return the same txId.
 *
 *   Test 2 — DOUBLE SPEND
 *     10 parallel requests with DIFFERENT keys but the same sender.
 *     Sender balance = $50, each request tries to send $10.
 *     Expected: exactly 5 succeed, the rest fail with InsufficientFunds.
 *     (not 10 debits that overdraft the account)
 *
 *   Test 3 — DEADLOCK
 *     Simultaneous A→B and B→A transfers.
 *     Expected: both complete without deadlock (thanks to sorted lock order).
 *
 * Run:  node tests/concurrency.test.js
 * Requires: API running on localhost:3000 with a fresh DB.
 */

const BASE = 'http://localhost:3000/api';
const { randomUUID } = require('crypto');

// ─── Helpers ──────────────────────────────────────────────────────

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

async function setup(username, initialBalance) {
  const user   = await post('/users',   { username, email: `${username}@test.com` });
  const wallet = await post('/wallets', { userId: user.body.data.id, initialBalance });
  return wallet.body.data.id;
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓  ${message}`);
}

// ─── Tests ────────────────────────────────────────────────────────

async function testIdempotency(senderWalletId, receiverWalletId) {
  console.log('\n[TEST 1] Idempotency — 10 concurrent requests, same Idempotency-Key');
  const key     = randomUUID();
  const payload = { senderWalletId, receiverWalletId, amount: 5 };
  const headers = { 'Idempotency-Key': key };

  // Fire 10 parallel requests with identical idempotency key
  const results = await Promise.all(
    Array.from({ length: 10 }, () => post('/transfers', payload, headers))
  );

  const successes = results.filter(r => r.status === 200 || r.status === 201);
  const txIds     = new Set(successes.map(r => r.body.data.id));

  assert(successes.length === 10, 'All 10 requests returned success (200/201)');
  assert(txIds.size === 1,        'All 10 responses share exactly ONE transaction ID');

  // Confirm the wallet was only debited once
  const wallet = await get(`/wallets/${senderWalletId}`);
  assert(
    parseFloat(wallet.body.data.balance) === 45,  // 50 - 5 (not 50 - 50)
    `Sender debited exactly once (balance = ${wallet.body.data.balance}, expected 45)`
  );
}

async function testDoubleSpend(senderWalletId, receiverWalletId) {
  console.log('\n[TEST 2] Double-spend — 10 concurrent $10 transfers, balance = $50');

  // 10 simultaneous transfers, each with a DIFFERENT idempotency key
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      post(
        '/transfers',
        { senderWalletId, receiverWalletId, amount: 10 },
        { 'Idempotency-Key': randomUUID() }
      )
    )
  );

  const succeeded = results.filter(r => r.status === 201 || r.status === 200);
  const failed    = results.filter(r => r.status === 422);

  assert(succeeded.length === 5, `Exactly 5 transfers succeeded (got ${succeeded.length})`);
  assert(failed.length    === 5, `Exactly 5 failed with InsufficientFunds (got ${failed.length})`);

  // Final balance must be exactly 0 — no overdraft, no phantom money
  const wallet = await get(`/wallets/${senderWalletId}`);
  assert(
    parseFloat(wallet.body.data.balance) === 0,
    `Final balance is 0 — no overdraft occurred (got ${wallet.body.data.balance})`
  );
}

async function testDeadlock(walletA, walletB) {
  console.log('\n[TEST 3] Deadlock prevention — simultaneous A→B and B→A');

  const [resultAtoB, resultBtoA] = await Promise.all([
    post('/transfers',
      { senderWalletId: walletA, receiverWalletId: walletB, amount: 5 },
      { 'Idempotency-Key': randomUUID() }
    ),
    post('/transfers',
      { senderWalletId: walletB, receiverWalletId: walletA, amount: 5 },
      { 'Idempotency-Key': randomUUID() }
    ),
  ]);

  assert(
    resultAtoB.status === 201,
    `A→B transfer succeeded (status ${resultAtoB.status})`
  );
  assert(
    resultBtoA.status === 201,
    `B→A transfer succeeded (status ${resultBtoA.status})`
  );

  // Both wallets should still have $45 (they each sent $5 and received $5)
  const [wA, wB] = await Promise.all([
    get(`/wallets/${walletA}`),
    get(`/wallets/${walletB}`),
  ]);
  assert(parseFloat(wA.body.data.balance) === 45, `Wallet A balance = ${wA.body.data.balance}`);
  assert(parseFloat(wB.body.data.balance) === 45, `Wallet B balance = ${wB.body.data.balance}`);
}

// ─── Runner ───────────────────────────────────────────────────────

async function run() {
  console.log('=== Digital Wallet Concurrency Test Suite ===');

  try {
    // Provision test wallets
    const [alice, bob, charlie, diana] = await Promise.all([
      setup('alice_test',   50),
      setup('bob_test',     50),
      setup('charlie_test', 50),
      setup('diana_test',   50),
    ]);

    await testIdempotency(alice, bob);
    await testDoubleSpend(charlie, diana);

    // Fresh wallets for deadlock test (both with $50)
    const [walletX, walletY] = await Promise.all([
      setup('xavier_test', 50),
      setup('yolanda_test', 50),
    ]);
    await testDeadlock(walletX, walletY);

    console.log('\n✅  All tests passed — system is thread-safe and ACID-compliant.\n');
  } catch (err) {
    console.error('\n❌ ', err.message, '\n');
    process.exit(1);
  }
}

run();
