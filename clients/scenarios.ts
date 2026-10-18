// Demo scenarios: ready-made tasks across the kinds of work the escrow can check today. Each folder in
// clients/scenarios/ holds one task:
//   scenario.json   title, kind, capability, what the check does, and Mallory's failure (bad_reason, a regex)
//   spec.txt        the task text the poster posts
//   verify.py       a Python check (first line "# scenario: <name>"), or schema.json, a JSON Schema titled "scenario:<name>"
//   good/ | good.py | good.json   worker A's correct delivery (a folder means {"files": {...}}, .py means {"code": <file>})
//   bad/ | bad.py | bad.json      Mallory's delivery
//   show.py         optional: prints the output the poster received, from the delivered payload on stdin
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'clients/scenarios';

export interface Scenario {
  name: string;
  order: number;
  title: string;
  kind: 'code' | 'data' | 'back-office';
  need: string;
  capability: string;
  /** Budget in US cents, and the scripted workers' bids. */
  budget: number;
  prices: { 'worker-a': number; mallory: number };
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

/** Mallory bids under worker A, so she is hired first and caught. Otherwise worker A, the lowest bid, is hired and
 *  paid outright and Mallory never gets the job. The scenarios mix both, so price never looks like quality. */
export const malloryUndercuts = (s: Pick<Scenario, 'prices'>) => s.prices.mallory < s.prices['worker-a'];

export function loadScenario(name: string): Scenario {
  const dir = join(ROOT, name);
  if (!existsSync(join(dir, 'scenario.json'))) throw new Error(`no scenario "${name}"; choose one of: ${scenarioNames().join(', ')}`);
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  // A delivery is a folder of files ({"files": {name: text}}), a Python file ({"code": text}) or JSON.
  const delivery = (stem: string) =>
    existsSync(join(dir, stem))
      ? { files: Object.fromEntries(readdirSync(join(dir, stem)).map((f) => [f, read(join(stem, f))])) }
      : existsSync(join(dir, `${stem}.py`))
        ? { code: read(`${stem}.py`) }
        : JSON.parse(read(`${stem}.json`));
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
