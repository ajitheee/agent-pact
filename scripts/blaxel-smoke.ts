// Prove the Python verifier runs in Blaxel: `npm run blaxel:smoke` (needs BL_WORKSPACE + BL_API_KEY in .env).
// Runs the poster's slugify tests on worker A's code (should pass) and on Mallory's (should fail). Each submission
// runs in its own child process inside the sandbox.
import { readFileSync } from 'node:fs';
import { brokenSlugify, slugifyDeliverable } from '../clients/slugify.js';
import { config } from '../src/config.js';
import { Verifiers } from '../src/verifier/index.js';

if (config.verifierSandbox !== 'blaxel') {
  console.error('BL_API_KEY is not set (or VERIFIER_SANDBOX=local): nothing to test against Blaxel.');
  process.exit(1);
}
const verifiers = new Verifiers();
const t0 = Date.now();
const spec = await verifiers.prepare({ type: 'python', code: readFileSync('clients/verifiers/slugify.py', 'utf8') });
console.log(`verifier accepted at post time (${Date.now() - t0}ms, includes creating or resuming the sandbox)`);
for (const [label, payload] of [['worker A', slugifyDeliverable()], ['mallory', brokenSlugify()]] as const) {
  const v = await verifiers.run(spec, payload);
  console.log(`${label.padEnd(9)} → ${v.passed ? 'PASS' : `FAIL: ${v.reasons[0]}`} · ran in ${v.sandbox} · ${v.ms}ms`);
}
