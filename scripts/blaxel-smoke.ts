// Prove the Python verifier runs in Blaxel: `npm run blaxel:smoke` (needs BL_WORKSPACE + BL_API_KEY in .env).
// Runs the poster's contacts verifier on worker A's data (should pass) and on Mallory's (should fail).
import { readFileSync } from 'node:fs';
import { contacts, garbage } from '../clients/contacts.js';
import { config } from '../src/config.js';
import { Verifiers } from '../src/verifier/index.js';

if (config.verifierSandbox !== 'blaxel') {
  console.error('BL_API_KEY is not set (or VERIFIER_SANDBOX=local): nothing to test against Blaxel.');
  process.exit(1);
}
const verifiers = new Verifiers();
const t0 = Date.now();
const spec = await verifiers.prepare({ type: 'python', code: readFileSync('clients/verifiers/contacts.py', 'utf8') });
console.log(`verifier accepted at post time (${Date.now() - t0}ms, includes creating or resuming the sandbox)`);
for (const [label, payload] of [['worker A', contacts()], ['mallory', garbage()]] as const) {
  const v = await verifiers.run(spec, payload);
  console.log(`${label.padEnd(9)} → ${v.passed ? 'PASS' : `FAIL: ${v.reasons[0]}`} · ran in ${v.sandbox} · ${v.ms}ms`);
}
