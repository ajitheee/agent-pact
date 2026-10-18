// Python verifiers in a Blaxel sandbox (blaxel.ai): a microVM per workspace sandbox, so poster-supplied
// code never runs on the escrow server itself. One persistent sandbox is reused; it scales to zero when idle.
// Auth comes from BL_WORKSPACE + BL_API_KEY in the environment.
import { newId } from '../ids.js';
import { RUNNER_PY } from './runner.js';

const SANDBOX = process.env.BLAXEL_SANDBOX ?? 'escrow-verifier';
const RUNNER_PATH = '/opt/escrow/runner.py';

type Sandbox = Awaited<ReturnType<typeof import('@blaxel/core').SandboxInstance.createIfNotExists>>;
let ready: Promise<Sandbox> | undefined;

/** Create (or reattach to) the verifier sandbox and install the runner, once per process. */
function sandbox(): Promise<Sandbox> {
  ready ??= (async () => {
    const { SandboxInstance } = await import('@blaxel/core');
    const box = await SandboxInstance.createIfNotExists({
      name: SANDBOX,
      image: 'blaxel/py-app:latest', // Python 3.12
      memory: 2048,
      region: process.env.BL_REGION ?? 'us-was-1', // near Supabase us-east-1
      labels: { project: 'agent-task-escrow', role: 'verifier' },
    });
    await box.fs.write(RUNNER_PATH, RUNNER_PY);
    return box;
  })().catch((e) => {
    ready = undefined; // retry on the next verification
    throw e;
  });
  return ready;
}

/** Same contract as the local runner: the runner's one-line JSON reply, or an error string. */
export async function runInBlaxel(request: Record<string, unknown>, timeoutMs: number): Promise<{ reply?: any; error?: string }> {
  const box = await sandbox();
  const reqPath = `/tmp/escrow-${newId('req', 10)}.json`;
  await box.fs.write(reqPath, JSON.stringify(request));
  const result = (await box.process.exec({
    command: `sh -c 'python3 -I -S -X utf8 ${RUNNER_PATH} < ${reqPath}; rc=$?; rm -f ${reqPath}; exit $rc'`,
    waitForCompletion: true,
    timeout: Math.ceil(timeoutMs / 1000) + 2,
  })) as { status?: string; stdout?: string; stderr?: string; logs?: string; exitCode?: number };

  if (result.status === 'killed') return { error: `verifier timed out after ${timeoutMs}ms` };
  const out = (result.stdout ?? result.logs ?? '').trim().split('\n').pop() ?? '';
  try {
    return { reply: JSON.parse(out) };
  } catch {
    const tail = (result.stderr ?? '').trim().split('\n').pop();
    return { error: `verifier crashed${tail ? `: ${tail}` : ''}` };
  }
}
