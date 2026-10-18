import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { loadScenario } from '../clients/scenarios.js';
import { Verifiers, type VerifierSpec } from '../src/verifier/index.js';

// The CI-fix check (clients/scenarios/ci-fix/verify.py) through the real sandbox: the delivered pricing.py runs in
// its own child process via run_submission, so it can't rewrite the checks, escape the sandbox or game the suite.
describe('sandboxed submissions (ci-fix)', () => {
  const verifiers = new Verifiers();
  const scenario = loadScenario('ci-fix');
  const original = readFileSync('clients/scenarios/ci-fix/repo/pricing.py', 'utf8');
  let spec: VerifierSpec;
  before(async () => {
    spec = await verifiers.prepare(scenario.verifier);
  });
  const run = (code: string) => verifiers.run(spec, { files: { 'pricing.py': code } });

  it("fails the unfixed code on main: CI is red", async () => {
    const verdict = await run(original);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reasons[0], /^FAILED test_|raised KeyError/);
  });

  it("passes worker A's fix, and fails Mallory's test-gaming one on a hidden cart", async () => {
    assert.deepEqual([(await verifiers.run(spec, scenario.good)).passed], [true]);
    const gamed = await verifiers.run(spec, scenario.bad);
    assert.equal(gamed.passed, false);
    assert.match(gamed.reasons[0], /^hidden test: random cart #\d+ \(.*\): got subtotal \d+/);
  });

  it("can't reach the verifier: rewriting the runner only changes the submission's own process", async () => {
    const forge = `${original}\nimport sys\nsys.modules["__main__"].normalize = lambda result: (True, None)\n`;
    const verdict = await run(forge);
    assert.equal(verdict.passed, false);
  });

  it('keeps the submission sandboxed: no subprocesses, no file writes, no garbage-collector walks', async () => {
    assert.match((await run(`import subprocess\n${original}`)).reasons[0], /importing subprocess is not allowed/);
    assert.match((await run(`open("x.txt", "w")\n${original}`)).reasons[0], /writing files is not allowed/);
    assert.match((await run(`import gc\ngc.get_objects()\n${original}`)).reasons[0], /gc\.get_objects is not allowed/);
  });

  it('fails a delivery that is missing, does not run, or has the wrong shape', async () => {
    assert.match((await run('def other(): pass')).reasons[0], /_ci\(.*\) raised NameError/);
    assert.match((await run('def quote(:')).reasons[0], /does not run: SyntaxError/);
    assert.match((await verifiers.run(spec, { code: original })).reasons[0], /deliver \{"files"/);
  });
});
