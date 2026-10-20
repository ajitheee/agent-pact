import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      // Source data embedded in the check ("""…""" blocks; internal snippets use '''…''') must match the task text
      // exactly, and so must the files of the repo the task hands over.
      const blocks = s.verifier.type === 'python' ? [...s.verifier.code.matchAll(/"""([\s\S]*?)"""/g)].map((m) => m[1]).filter((b) => b.includes('\n')) : [];
      const repo = join('clients/scenarios', s.name, 'repo');
      const files = existsSync(repo) ? readdirSync(repo).map((f) => readFileSync(join(repo, f), 'utf8')) : [];
      for (const text of [...blocks, ...files]) assert.ok(s.spec.includes(text.trim()), `${s.name}: spec.txt doesn't contain: ${text.trim().slice(0, 60)}…`);
      // A task delivered as files posts its file scope, so no file the check never reads can ride along.
      if ((s.good as { files?: unknown }).files) assert.ok(s.verifier.allowed_files?.length, `${s.name}: delivered as files, so scenario.json needs allowed_files`);
    });
  }
});
