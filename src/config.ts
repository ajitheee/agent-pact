export const config = {
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.ESCROW_DB ?? 'escrow.db',
  stripeKey: process.env.STRIPE_SECRET_KEY ?? '',
  // Test-mode card the platform authorizes on the poster's behalf.
  stripePaymentMethod: process.env.STRIPE_PAYMENT_METHOD ?? 'pm_card_visa',
  pythonBin: process.env.PYTHON_BIN ?? (process.platform === 'win32' ? 'python' : 'python3'),
  verifierTimeoutMs: Number(process.env.VERIFIER_TIMEOUT_MS ?? 5000),
  // Linux only: run the Python verifier inside `unshare --net` so it has no network at all.
  verifierUnshare: process.env.VERIFIER_UNSHARE === '1',
  // Where Python verifiers run: a Blaxel sandbox when BL_API_KEY is set, else a local subprocess.
  // Under `node --test` it stays local unless VERIFIER_SANDBOX says otherwise, so unit tests never reach Blaxel.
  verifierSandbox: (process.env.VERIFIER_SANDBOX ??
    (process.env.BL_API_KEY && !process.env.NODE_TEST_CONTEXT ? 'blaxel' : 'local')) as 'blaxel' | 'local',
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 2000),
  // Primitive email transport. Both must be set to turn it on.
  primitiveApiKey: process.env.PRIMITIVE_API_KEY ?? '',
  primitiveApiBase: process.env.PRIMITIVE_API_BASE ?? 'https://api.primitive.dev/v1',
  escrowEmail: (process.env.ESCROW_EMAIL ?? '').trim().toLowerCase(),
  // Set EMAIL_INBOUND=0 to only send the thread and ignore replies.
  emailInbound: process.env.EMAIL_INBOUND !== '0',
};

export const LIMITS = {
  minPrice: 50, // Stripe's minimum USD charge, in cents
  maxBudget: 100_000,
  maxSpecChars: 8_000,
  maxPayloadBytes: 256 * 1024,
  maxPythonChars: 20_000,
  maxAllowedFiles: 100,
  minDeadlineSeconds: 30,
  maxDeadlineSeconds: 7 * 86_400, // card authorizations lapse after ~7 days
};
