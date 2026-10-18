// Prove the Python verifier runs in Blaxel: `npm run blaxel:smoke` (needs BL_WORKSPACE + BL_API_KEY in .env).
// Runs the CI-fix scenario's suite on worker A's fix (should pass) and on Mallory's test-gaming one (should fail).
// Each submission runs in its own child process inside the sandbox.
import { loadScenario } from '../clients/scenarios.js';
import { config } from '../src/config.js';
import { Verifiers } from '../src/verifier/index.js';

if (config.verifierSandbox !== 'blaxel') {
  console.error('BL_API_KEY is not set (or VERIFIER_SANDBOX=local): nothing to test against Blaxel.');
  process.exit(1);
}
const verifiers = new Verifiers();
const t0 = Date.now();
const scenario = loadScenario('ci-fix');
const spec = await verifiers.prepare(scenario.verifier);
console.log(`verifier accepted at post time (${Date.now() - t0}ms, includes creating or resuming the sandbox)`);
for (const [label, payload] of [['worker A', scenario.good], ['mallory', scenario.bad]] as const) {
  const v = await verifiers.run(spec, payload);
  console.log(`${label.padEnd(9)} → ${v.passed ? 'PASS' : `FAIL: ${v.reasons[0]}`} · ran in ${v.sandbox} · ${v.ms}ms`);
}
