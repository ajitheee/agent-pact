import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadScenarios, scenarioOf } from '../clients/scenarios.js';
import { Verifiers } from '../src/verifier/index.js';

// Every demo scenario, through the real sandbox: worker A's delivery passes and Mallory's fails for the
// reason the scenario promises, so a rehearsal can't surprise anyone on stage.
describe('demo scenarios', () => {
  const verifiers = new Verifiers();

  for (const s of loadScenarios()) {
    it(`${s.name}: worker A passes, Mallory fails (${s.mallory.split(':')[0]})`, async () => {
      const spec = await verifiers.prepare(s.verifier);
      const good = await verifiers.run(spec, s.good);
      assert.deepEqual([good.passed, good.reasons], [true, []], `${s.name}: worker A should pass`);
      const bad = await verifiers.run(spec, s.bad);
      assert.equal(bad.passed, false, `${s.name}: Mallory should fail`);
      assert.match(bad.reasons[0], new RegExp(s.badReason));
    });

    it(`${s.name}: the task text and the check use the same data, and the check is recognizable`, () => {
      assert.equal(scenarioOf(s.verifier), s.name);
      if (s.verifier.type !== 'python') return;
      // Data scenarios embed their source table in the check; it must match the task text exactly.
      const table = /"""([\s\S]*?)"""/.exec(s.verifier.code)?.[1];
      if (table && table.includes('\n')) assert.ok(s.spec.includes(table.trim()), `${s.name}: spec.txt and verify.py disagree on the data`);
    });
  }
});
