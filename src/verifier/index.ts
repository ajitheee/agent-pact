import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { config, LIMITS } from '../config.js';
import { AgentError, errMsg } from '../errors.js';
import { runInBlaxel } from './blaxel.js';
import { RUNNER_PY } from './runner.js';

const addFormats = createRequire(import.meta.url)('ajv-formats') as (ajv: Ajv) => Ajv;

export type VerifierSpec =
  | { type: 'json_schema'; schema: Record<string, unknown> }
  | { type: 'python'; code: string };

export interface Verdict {
  passed: boolean;
  reasons: string[]; // empty on pass; at most 5 on fail
  ms: number;
  sandbox: 'in-process' | 'local' | 'blaxel'; // where the check ran
}

const WRAP_HINT = 'verifier must be {"type":"json_schema","schema":{...}} or {"type":"python","code":"def verify(payload): ..."}';
const JSON_TYPES = new Set(['array', 'object', 'string', 'number', 'integer', 'boolean', 'null']);

/**
 * Runs acceptance checks inside this service, never on the worker, so a worker cannot self-certify.
 * JSON Schema is in-process and side-effect free; Python runs in a Blaxel sandbox (or a local sandboxed subprocess).
 */
export class Verifiers {
  private readonly ajv = {
    draft7: addFormats(new Ajv({ allErrors: true, strict: false, addUsedSchema: false })) as Ajv,
    draft2019: addFormats(new Ajv2019({ allErrors: true, strict: false, addUsedSchema: false }) as unknown as Ajv),
    draft2020: addFormats(new Ajv2020({ allErrors: true, strict: false, addUsedSchema: false }) as unknown as Ajv),
  };
  private readonly compiled = new Map<string, ValidateFunction>();

  /** Validate a poster-supplied verifier at post time so mistakes surface before money moves. */
  async prepare(input: unknown): Promise<VerifierSpec> {
    const v = (input ?? {}) as Record<string, unknown>;
    if (v.type === 'json_schema') {
      let schema = v.schema;
      if (typeof schema === 'string') {
        try { schema = JSON.parse(schema); } catch { /* reported below */ }
      }
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new AgentError('invalid_verifier', { verifier_type: 'json_schema', detail: 'schema must be a JSON Schema object' }, WRAP_HINT);
      }
      try {
        this.validator(schema as Record<string, unknown>);
      } catch (e) {
        throw new AgentError('invalid_verifier', { verifier_type: 'json_schema', detail: (e as Error).message }, 'Fix the schema; it must compile as JSON Schema (draft-07, 2019-09 or 2020-12).');
      }
      return { type: 'json_schema', schema: schema as Record<string, unknown> };
    }
    if (v.type === 'python') {
      if (typeof v.code !== 'string' || !v.code.trim()) {
        throw new AgentError('invalid_verifier', { verifier_type: 'python', detail: 'code must be a non-empty string' }, WRAP_HINT);
      }
      if (v.code.length > LIMITS.maxPythonChars) {
        throw new AgentError('invalid_verifier', { verifier_type: 'python', detail: `code is ${v.code.length} chars; max ${LIMITS.maxPythonChars}` }, `Shorten code to <= ${LIMITS.maxPythonChars} characters.`);
      }
      const result = await runPython({ mode: 'check', code: v.code });
      if (result.error || !result.reply?.ok) {
        throw new AgentError('invalid_verifier', { verifier_type: 'python', detail: result.error ?? result.reply?.error }, 'Define def verify(payload): that asserts or returns True/False.');
      }
      return { type: 'python', code: v.code };
    }
    const looksLikeSchema = typeof v.type === 'string' && JSON_TYPES.has(v.type);
    throw new AgentError(
      'invalid_verifier',
      { got_type: v.type ?? null },
      looksLikeSchema ? `That looks like a bare JSON Schema. Wrap it: {"type":"json_schema","schema":<your schema>}` : WRAP_HINT,
    );
  }

  async run(spec: VerifierSpec, payload: unknown): Promise<Verdict> {
    const started = Date.now();
    if (spec.type === 'json_schema') {
      const validate = this.validator(spec.schema);
      const passed = validate(payload) as boolean;
      return { passed, reasons: passed ? [] : formatAjvErrors(validate.errors ?? []), ms: Date.now() - started, sandbox: 'in-process' };
    }
    const result = await runPython({ mode: 'verify', code: spec.code, payload });
    const ms = Date.now() - started;
    const sandbox = result.sandbox;
    if (result.error) return { passed: false, reasons: [result.error], ms, sandbox };
    const reply = result.reply!;
    if (!reply.ok) return { passed: false, reasons: [reply.error ?? 'verifier failed to load'], ms, sandbox };
    return { passed: reply.passed === true, reasons: reply.passed ? [] : [reply.reason ?? 'verify() rejected the payload'], ms, sandbox };
  }

  private validator(schema: Record<string, unknown>): ValidateFunction {
    const key = JSON.stringify(schema);
    let validate = this.compiled.get(key);
    if (!validate) {
      const draft = String(schema.$schema ?? '');
      const ajv = draft.includes('2020-12') ? this.ajv.draft2020 : draft.includes('2019-09') ? this.ajv.draft2019 : this.ajv.draft7;
      const { $schema: _ignored, ...rest } = schema; // dialect already chosen; avoids unknown-metaschema errors
      validate = ajv.compile(rest);
      this.compiled.set(key, validate);
    }
    return validate;
  }
}

/** LLMs often stringify JSON. Parse a string payload when it looks like JSON and the schema doesn't want a string. */
export function coercePayload(payload: unknown, spec: VerifierSpec): unknown {
  if (typeof payload !== 'string') return payload;
  if (spec.type === 'json_schema' && spec.schema.type === 'string') return payload;
  const trimmed = payload.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return payload;
  try {
    return JSON.parse(trimmed);
  } catch {
    return payload;
  }
}

function formatAjvErrors(errors: ErrorObject[]): string[] {
  const lines = errors.slice(0, 5).map((e) => {
    const where = e.instancePath || '(root)';
    const extra = e.keyword === 'additionalProperties' ? ` (${(e.params as { additionalProperty: string }).additionalProperty})` : '';
    return `${where} ${e.message}${extra}`;
  });
  if (errors.length > 5) lines.push(`…and ${errors.length - 5} more`);
  return lines;
}

interface RunnerReply {
  ok: boolean;
  passed?: boolean;
  reason?: string | null;
  error?: string;
}

/** Blaxel when configured; the local subprocess if Blaxel is unset or unreachable. */
async function runPython(request: Record<string, unknown>): Promise<{ reply?: RunnerReply; error?: string; sandbox: 'local' | 'blaxel' }> {
  if (config.verifierSandbox === 'blaxel') {
    try {
      return { ...(await runInBlaxel(request, config.verifierTimeoutMs)), sandbox: 'blaxel' };
    } catch (e) {
      console.error(`[verifier] Blaxel unavailable (${errMsg(e)}); using the local sandbox`);
    }
  }
  return { ...(await runLocalPython(request)), sandbox: 'local' };
}

async function runLocalPython(request: Record<string, unknown>): Promise<{ reply?: RunnerReply; error?: string }> {
  const timeoutMs = config.verifierTimeoutMs;
  const cwd = await mkdtemp(join(tmpdir(), 'escrow-verifier-'));
  const pyArgs = ['-I', '-S', '-X', 'utf8', '-c', RUNNER_PY];
  const [cmd, args] = config.verifierUnshare
    ? ['unshare', ['--net', '--map-root-user', config.pythonBin, ...pyArgs]]
    : [config.pythonBin, pyArgs];
  // Bare environment: no API keys or tokens from this process leak into poster code.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  if (process.platform === 'win32') {
    env.SYSTEMROOT = process.env.SYSTEMROOT ?? 'C:\\Windows';
    env.PATHEXT = process.env.PATHEXT ?? '.EXE';
  }
  const body = JSON.stringify({ cpu_seconds: Math.ceil(timeoutMs / 1000), memory_mb: 512, ...request });

  try {
    return await new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, env, windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ error: `verifier timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout.on('data', (d) => { if (out.length < 65_536) out += d; });
      child.stderr.on('data', (d) => { if (err.length < 8_192) err += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ error: `could not start ${config.pythonBin}: ${e.message}` });
      });
      child.on('close', () => {
        clearTimeout(timer);
        const last = out.trim().split('\n').pop() ?? '';
        try {
          resolve({ reply: JSON.parse(last) as RunnerReply });
        } catch {
          const tail = err.trim().split('\n').pop();
          resolve({ error: `verifier crashed${tail ? `: ${tail}` : ''}` });
        }
      });
      child.stdin.on('error', () => {}); // EPIPE if python exits before reading
      child.stdin.end(body);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
