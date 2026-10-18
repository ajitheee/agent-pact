// Demo scenarios: ready-made tasks across the kinds of work the escrow can check today. Each folder in
// clients/scenarios/ holds one task:
//   scenario.json   title, kind, capability, what the check does, and Mallory's failure (bad_reason, a regex)
//   spec.txt        the task text the poster posts
//   verify.py       a Python check (first line "# scenario: <name>"), or schema.json, a JSON Schema titled "scenario:<name>"
//   good.py|json    worker A's correct delivery (.py means {"code": <file>})
//   bad.py|json     Mallory's delivery
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'clients/scenarios';

export interface Scenario {
  name: string;
  order: number;
  title: string;
  kind: 'code' | 'data' | 'leads';
  need: string;
  capability: string;
  check: string;
  strength: string;
  mallory: string;
  badReason: string;
  spec: string;
  verifier: { type: 'python'; code: string } | { type: 'json_schema'; schema: Record<string, unknown> };
  /** The file the poster reads and posts verbatim as the verifier. */
  verifierFile: string;
  good: unknown;
  bad: unknown;
}

export function loadScenario(name: string): Scenario {
  const dir = join(ROOT, name);
  if (!existsSync(join(dir, 'scenario.json'))) throw new Error(`no scenario "${name}"; choose one of: ${scenarioNames().join(', ')}`);
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const delivery = (stem: string) => (existsSync(join(dir, `${stem}.py`)) ? { code: read(`${stem}.py`) } : JSON.parse(read(`${stem}.json`)));
  const meta = JSON.parse(read('scenario.json'));
  const python = existsSync(join(dir, 'verify.py'));
  return {
    name,
    ...meta,
    badReason: meta.bad_reason,
    spec: read('spec.txt').trim(),
    verifier: python ? { type: 'python', code: read('verify.py') } : { type: 'json_schema', schema: JSON.parse(read('schema.json')) },
    verifierFile: join(dir, python ? 'verify.py' : 'schema.json').replaceAll('\\', '/'),
    good: delivery('good'),
    bad: delivery('bad'),
  };
}

export function scenarioNames(): string[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, 'scenario.json')))
    .map((d) => ({ name: d.name, order: JSON.parse(readFileSync(join(ROOT, d.name, 'scenario.json'), 'utf8')).order ?? 99 }))
    .sort((a, b) => a.order - b.order)
    .map((d) => d.name);
}

export const loadScenarios = () => scenarioNames().map(loadScenario);

/**
 * The scenario a task's verifier belongs to, by its marker: "# scenario: <name>" in Python, or a JSON Schema
 * titled "scenario:<name>". A marker survives an agent reformatting the code when it posts it.
 */
export function scenarioOf(verifier: { type: string; code?: string; schema?: { title?: unknown } }): string | undefined {
  const name = verifier.type === 'python' ? /^#\s*scenario:\s*([\w-]+)/m.exec(verifier.code ?? '')?.[1] : /^scenario:([\w-]+)$/.exec(String(verifier.schema?.title ?? ''))?.[1];
  return name && scenarioNames().includes(name) ? name : undefined;
}
