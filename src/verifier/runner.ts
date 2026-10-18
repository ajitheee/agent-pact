// Python verifier sandbox runner, passed to `python -c` so it survives bundling (no file path to resolve).
// Kept as raw source: edit it as Python. It must not contain backticks or ${.
export const RUNNER_PY = String.raw`"""Verifier sandbox runner.

Reads one JSON request on stdin:
  {"mode": "check" | "verify", "code": str, "payload": any, "cpu_seconds": int, "memory_mb": int}
and writes one JSON line on stdout:
  check  -> {"ok": true} or {"ok": false, "error": str}
  verify -> {"ok": true, "passed": bool, "reason": str | null}

Isolation layers (hackathon-grade, not a hard boundary): a separate process the parent kills on
a wall-clock timeout; -I isolated mode with a bare environment and a throwaway cwd; POSIX rlimits
on CPU and memory; and an audit hook refusing network, subprocess, filesystem-mutation and ctypes
operations. Production would wrap this in a container or nsjail.

Verifiers can call run_submission(code, function, inputs) to test code a worker delivered. The
submission runs in a child process (this runner again, in "submission" mode, with the same limits),
so it never shares memory with the verifier and can't rewrite its checks or forge its verdict:
the verifier only sees the JSON values the function returned.
"""

import io
import json
import os
import sys

BLOCKED_EVENTS = (
    "socket.", "subprocess.", "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork",
    "os.forkpty", "os.kill", "os.killpg", "os.remove", "os.rename", "os.rmdir", "os.mkdir",
    "os.unlink", "os.chmod", "os.chown", "os.truncate", "os.symlink", "os.link", "os.putenv",
    "os.unsetenv", "os.startfile", "shutil.", "ctypes.", "winreg.", "_winapi.", "urllib.",
    "http.client.", "ftplib.", "smtplib.", "webbrowser.", "pty.",
    # The garbage collector would reach the hook itself; rlimits must stay where they were set.
    "gc.", "resource.setrlimit", "resource.prlimit",
)
# subprocess is imported only by run_submission, so a submission can neither import it nor find it loaded.
BLOCKED_IMPORTS = frozenset({"ctypes", "_ctypes", "subprocess", "_posixsubprocess", "_winapi", "multiprocessing"})
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
CHILD_ENV = {k: v for k, v in os.environ.items() if k in ("PATH", "SYSTEMROOT", "PATHEXT")}
SPAWNING = [False]  # set only while run_submission starts its child process


def make_guard(spawning=None):
    """The audit hook. Its lists are bound here, so code that rebinds the module globals can't loosen it.
    Only the verifier's own process passes spawning; a submission's hook has no off switch."""
    blocked_events, blocked_imports, write_flags = BLOCKED_EVENTS, BLOCKED_IMPORTS, WRITE_FLAGS

    def guard(event, args):
        if spawning is not None and spawning[0]:
            return
        if event == "import":
            if args[0].split(".")[0] in blocked_imports:
                raise ImportError(f"sandbox: importing {args[0]} is not allowed")
        elif event == "open":
            _, mode, flags = args
            writing = any(c in mode for c in "wax+") if isinstance(mode, str) else bool(flags & write_flags)
            if writing:
                raise PermissionError("sandbox: writing files is not allowed")
        elif event.startswith(blocked_events):
            raise PermissionError(f"sandbox: {event} is not allowed")

    return guard


def limit_resources(cpu_seconds, memory_mb):
    try:
        import resource
    except ImportError:
        return  # Windows: the parent's wall-clock timeout is the only limit
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    memory = memory_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))


def describe(exc):
    text = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    return text[:500]


def normalize(result):
    """verify() may return None/True (pass), False, (bool, reason), or {"passed": bool, "reason": str}."""
    if result is None or result is True:
        return True, None
    if result is False:
        return False, "verify() returned False"
    if isinstance(result, (tuple, list)) and len(result) == 2 and isinstance(result[0], bool):
        return result[0], None if result[1] is None else str(result[1])[:500]
    if isinstance(result, dict) and ("passed" in result or "pass" in result):
        passed = bool(result.get("passed", result.get("pass")))
        reason = result.get("reason")
        return passed, None if reason is None else str(reason)[:500]
    return bool(result), None if result else f"verify() returned {result!r}"[:500]


def run_submission(code, function, inputs, timeout=3):
    """Call function(x) for each input, with the worker's code in its own sandboxed process.

    Returns the list of results. Raises AssertionError (a failed verdict) if the code doesn't define
    the function, raises, times out or returns something that isn't JSON."""
    inputs = list(inputs)
    request = json.dumps({"mode": "submission", "code": code, "function": function, "inputs": inputs})
    SPAWNING[0] = True
    try:
        import subprocess

        try:
            # sys.orig_argv re-runs this runner exactly as it was started (a file in Blaxel, -c locally).
            child = subprocess.run([sys.executable, *sys.orig_argv[1:]], input=request, capture_output=True,
                                   encoding="utf-8", timeout=timeout, env=CHILD_ENV)
        except subprocess.TimeoutExpired:
            raise AssertionError(f"the submitted code took longer than {timeout}s") from None
    finally:
        SPAWNING[0] = False
    try:
        result = json.loads(child.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        raise AssertionError("the submitted code crashed before returning anything") from None
    if not isinstance(result, dict) or not result.get("ok"):
        raise AssertionError(str(result.get("error") if isinstance(result, dict) else result)[:300])
    results = result.get("results")
    if not isinstance(results, list) or len(results) != len(inputs):
        raise AssertionError("the submitted code did not return one result per input")
    return results


def submission(request, reply):
    """Child side of run_submission: untrusted code, same sandbox, and only its return values go back."""
    namespace = {"__name__": "submission"}
    function = request["function"]
    try:
        exec(compile(request["code"], "<submission>", "exec"), namespace)
    except BaseException as exc:
        return reply(ok=False, error=f"the submitted code does not run: {describe(exc)}")
    fn = namespace.get(function)
    if not callable(fn):
        return reply(ok=False, error=f"the submitted code does not define {function}()")
    results = []
    for value in request["inputs"]:
        try:
            results.append(fn(value))
        except BaseException as exc:
            return reply(ok=False, error=f"{function}({value!r}) raised {describe(exc)}")
    try:
        reply(ok=True, results=results)
    except (TypeError, ValueError):
        reply(ok=False, error=f"{function}() returned a value that isn't plain JSON")


def main():
    out = sys.stdout

    def reply(**fields):
        out.write(json.dumps(fields) + "\n")
        out.flush()

    request = json.loads(sys.stdin.read())
    limit_resources(request.get("cpu_seconds", 5), request.get("memory_mb", 512))
    is_submission = request["mode"] == "submission"
    sys.addaudithook(make_guard(None if is_submission else SPAWNING))
    sys.stdout = sys.stderr = io.StringIO()  # verifier prints must not corrupt the reply
    if is_submission:
        return submission(request, reply)

    namespace = {"__name__": "verifier", "run_submission": run_submission}
    try:
        exec(compile(request["code"], "<verifier>", "exec"), namespace)
    except BaseException as exc:
        return reply(ok=False, error=describe(exc))
    verify = namespace.get("verify")
    if not callable(verify):
        return reply(ok=False, error="code must define a function verify(payload)")
    if request["mode"] == "check":
        return reply(ok=True)

    try:
        passed, reason = normalize(verify(request["payload"]))
    except AssertionError as exc:
        passed, reason = False, (str(exc) or "assertion failed")[:500]
    except BaseException as exc:
        passed, reason = False, describe(exc)
    reply(ok=True, passed=passed, reason=reason)


main()
`;
