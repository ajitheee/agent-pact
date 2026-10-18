import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { brokenSlugify, slugifyDeliverable } from '../clients/slugify.js';
import { Verifiers, type VerifierSpec } from '../src/verifier/index.js';

// The poster's test suite (clients/verifiers/slugify.py), run through the real sandbox: the submitted
// code runs in its own child process via run_submission.
describe('slugify verifier', () => {
  const verifiers = new Verifiers();
  let spec: VerifierSpec;
  before(async () => {
    spec = await verifiers.prepare({ type: 'python', code: readFileSync('clients/verifiers/slugify.py', 'utf8') });
  });
  const run = (code: string) => verifiers.run(spec, { code });

  it("passes worker A's slugify", async () => {
    const verdict = await verifiers.run(spec, slugifyDeliverable());
    assert.deepEqual([verdict.passed, verdict.reasons], [true, []]);
  });

  it("fails Mallory's slugify on punctuation (the failure beat)", async () => {
    const verdict = await verifiers.run(spec, brokenSlugify());
    assert.equal(verdict.passed, false);
    assert.match(verdict.reasons[0], /slugify\('Hello, World!'\) returned 'hello,-world!', expected 'hello-world'/);
  });

  it('fails answers hardcoded from the public examples', async () => {
    const table = `ANSWERS = {"Hello, World!": "hello-world", "  Agents   hiring   agents  ": "agents-hiring-agents", "Déjà vu: a naïve café": "deja-vu-a-naive-cafe", "100% verified": "100-verified", "C++ & Rust": "c-rust", "already-a-slug": "already-a-slug", "MCP: the Model Context Protocol": "mcp-the-model-context-protocol", "---": "", "": ""}
def slugify(title):
    return ANSWERS.get(title, "")`;
    const verdict = await run(table);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reasons[0], /returned '', expected '[a-z0-9]/);
  });

  it("can't reach the verifier: rewriting the runner only changes the submission's own process", async () => {
    const forge = `import sys
sys.modules["__main__"].normalize = lambda result: (True, None)
def slugify(title):
    return "x"`;
    const verdict = await run(forge);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reasons[0], /returned 'x'/);
  });

  it('keeps the submission sandboxed: no subprocesses, no file writes, no garbage-collector walks', async () => {
    assert.match((await run('import subprocess\ndef slugify(t): return t')).reasons[0], /importing subprocess is not allowed/);
    assert.match((await run('open("x.txt", "w")\ndef slugify(t): return t')).reasons[0], /writing files is not allowed/);
    assert.match((await run('import gc\ngc.get_objects()\ndef slugify(t): return t')).reasons[0], /gc\.get_objects is not allowed/);
  });

  it('fails code that is missing, crashes, or returns non-strings', async () => {
    assert.match((await run('def other(t): return t')).reasons[0], /does not define slugify\(\)/);
    assert.match((await run('def slugify(t): return 1 / 0')).reasons[0], /raised ZeroDivisionError/);
    assert.match((await run('def slugify(t): return None')).reasons[0], /returned None, expected 'hello-world'/);
    assert.match((await verifiers.run(spec, 'def slugify(t): return t')).reasons[0], /deliver \{"code"/);
  });
});
