import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { contacts, deliverable, garbage } from '../clients/contacts.js';
import { Verifiers, type VerifierSpec } from '../src/verifier/index.js';

// The poster's verifier (clients/verifiers/contacts.py), run through the real sandbox.
describe('contacts verifier', () => {
  const verifiers = new Verifiers();
  let spec: VerifierSpec;
  before(async () => {
    spec = await verifiers.prepare({ type: 'python', code: readFileSync('clients/verifiers/contacts.py', 'utf8') });
  });
  const run = (payload: unknown) => verifiers.run(spec, payload);

  it("passes worker A's contacts", async () => {
    const verdict = await run(contacts());
    assert.deepEqual([verdict.passed, verdict.reasons], [true, []]);
    assert.equal((await run(deliverable({ type: 'python' }))).passed, true);
  });

  it('fails the placeholder rows that slipped past the old JSON Schema', async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({ email: `founder${i}@company${i}.dev` }));
    const verdict = await run(old);
    assert.equal(verdict.passed, false);
    assert.match(verdict.reasons[0], /row 0: name '' is not a real full name/);
  });

  it('fails free-mail addresses even with real-looking names (the Mallory beat)', async () => {
    const verdict = await run(garbage());
    assert.equal(verdict.passed, false);
    assert.match(verdict.reasons[0], /gmail\.com is free mail/);
  });

  it('fails placeholder domains, generated domains, mismatched names and duplicates', async () => {
    const swap = (i: number, row: object) => contacts().map((r, j) => (j === i ? { ...r, ...row } : r));
    assert.match((await run(swap(3, { email: 'tomas.novak@example.com' }))).reasons[0], /row 3: example\.com is a placeholder domain/);
    assert.match((await run(swap(4, { email: 'aisha@company4.dev' }))).reasons[0], /row 4: company4\.dev looks generated/);
    assert.match((await run(swap(5, { email: 'someone@ferrolabs.io' }))).reasons[0], /row 5: .* does not belong to 'Lena/);
    assert.match((await run(swap(6, { email: contacts()[0].email.replace('maya', 'marcus') }))).reasons[0], /row 6: duplicate company/);
    assert.match((await run(contacts(19))).reasons[0], /expected 20 contacts, got 19/);
  });
});
