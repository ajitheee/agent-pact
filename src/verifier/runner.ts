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
)
BLOCKED_IMPORTS = {"ctypes", "_ctypes"}
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def guard(event, args):
    if event == "import":
        if args[0].split(".")[0] in BLOCKED_IMPORTS:
            raise ImportError(f"sandbox: importing {args[0]} is not allowed")
    elif event == "open":
        _, mode, flags = args
        writing = any(c in mode for c in "wax+") if isinstance(mode, str) else bool(flags & WRITE_FLAGS)
        if writing:
            raise PermissionError("sandbox: writing files is not allowed")
    elif event.startswith(BLOCKED_EVENTS):
        raise PermissionError(f"sandbox: {event} is not allowed")


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


def main():
    out = sys.stdout

    def reply(**fields):
        out.write(json.dumps(fields) + "\n")
        out.flush()

    request = json.loads(sys.stdin.read())
    limit_resources(request.get("cpu_seconds", 5), request.get("memory_mb", 512))
    sys.addaudithook(guard)
    sys.stdout = sys.stderr = io.StringIO()  # verifier prints must not corrupt the reply

    namespace = {"__name__": "verifier"}
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
