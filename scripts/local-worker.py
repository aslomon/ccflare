#!/usr/bin/env python3
"""Run a scoped Claude Code worker through CCflare's local provider."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.request


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path)
    parser.add_argument("--prompt", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--model", default="qwen/qwen3.8-27b")
    parser.add_argument("--base-url", default="http://127.0.0.1:8081")
    parser.add_argument("--thinking", choices=["on", "off"], default="on")
    parser.add_argument("--effort", choices=["low", "medium", "high"], default="low")
    parser.add_argument("--timeout", type=int, default=3600)
    parser.add_argument("--read-only", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if not args.status and not all([args.dir, args.prompt, args.output]):
        parser.error("--dir, --prompt and --output are required for worker runs")
    if not 60 <= args.timeout <= 7200:
        parser.error("timeout must be between 60 and 7200 seconds")
    return args


def scoped_environment(args):
    values = {
        "ANTHROPIC_BASE_URL": args.base_url.rstrip("/") + "/v1/lmstudio",
        "ANTHROPIC_AUTH_TOKEN": "lmstudio",
        "ANTHROPIC_API_KEY": "lmstudio",
        "ANTHROPIC_MODEL": args.model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": args.model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": args.model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": args.model,
        "CLAUDE_CODE_SUBAGENT_MODEL": args.model,
        "ANTHROPIC_CUSTOM_HEADERS": "x-ccflare-local-thinking: " + args.thinking,
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "100000",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "100000",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096",
        "API_TIMEOUT_MS": str(args.timeout * 1000),
        "CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS": str(args.timeout * 1000),
        "CLAUDE_STREAM_IDLE_TIMEOUT_MS": str(args.timeout * 1000),
        "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS": str(args.timeout * 1000),
        "CLAUDE_CODE_MAX_RETRIES": "0",
        "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES": "0",
        "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }
    return values


def command(args, values):
    result = ["claude", "-p", "--model", args.model, "--effort", args.effort,
              "--fallback-model", args.model, "--setting-sources", "project,local",
              "--permission-mode", "dontAsk" if args.read_only else "auto", "--output-format", "stream-json",
              "--verbose", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
              "--settings", json.dumps({"env": values, "alwaysThinkingEnabled": args.thinking == "on"})]
    if args.read_only:
        result += ["--tools", "Read,Glob,Grep", "--allowedTools", "Read", "Glob", "Grep"]
    return result


def reserve_slot(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for index in range(2):
        handle = (directory / f"worker-{index}.lock").open("a+")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except BlockingIOError:
            handle.close()
    raise RuntimeError("Both local workers are occupied; keep this package pending.")


def preflight(args):
    url = args.base_url.rstrip("/") + "/v1/lmstudio/v1/models"
    with urllib.request.urlopen(url, timeout=15) as response:
        data = json.load(response)
    if not any(item.get("id") == args.model for item in data.get("data", [])):
        raise RuntimeError("Local model is unavailable; keep this package pending.")


def stop_worker(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait()
        return
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass  # Escalate the owned group below, including surviving tool children.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=5)


def read_result(path):
    result = None
    truncated = False
    for line in path.read_text(errors="replace").splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            truncated = True
            continue
        if isinstance(value, dict) and value.get("type") == "result":
            result = value
    return result, truncated


def write_report(args, code, started, timed_out, failure):
    result, truncated = read_result(args.output / "events.jsonl")
    ok = code == 0 and result is not None and not result.get("is_error", True)
    ok = ok and not timed_out and not failure and not truncated
    summary = {"ok": ok, "exitCode": code, "seconds": round(time.monotonic() - started, 2),
               "model": args.model, "thinking": args.thinking, "effort": args.effort, "contextWindow": 100000,
               "timedOut": timed_out, "failure": failure, "truncatedStream": truncated,
               "note": "Use CCflare for measured usage and cost; CLI estimates are not billing."}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    if result:
        (args.output / "report.md").write_text(str(result.get("result", "")) + "\n")
    print(json.dumps(summary))
    return 0 if ok else 1


def run(args, prompt, values, lock_fd):
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    started = time.monotonic()
    env = os.environ.copy()
    for key in ["CLAUDECODE", "MAX_THINKING_TOKENS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]:
        env.pop(key, None)
    env.update(values)
    timed_out, failure, code = False, None, 1
    with (args.output / "events.jsonl").open("w") as events, (args.output / "stderr.log").open("w") as errors:
        process = None
        try:
            process = subprocess.Popen(command(args, values), cwd=args.dir, env=env, pass_fds=(lock_fd,),
                                       stdin=subprocess.PIPE, stdout=events, stderr=errors, start_new_session=True)
            process.communicate(prompt.encode(), timeout=args.timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        except OSError as error:
            failure = str(error)
        finally:
            if process:
                stop_worker(process)
                code = process.returncode
    return write_report(args, code, started, timed_out, failure)


def interrupted(_signal, _frame):
    raise InterruptedError("Worker interrupted")


def main():
    for name in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]:
        signal.signal(name, interrupted)
    args = arguments()
    if args.status:
        slots = []
        try:
            preflight(args)
            for _ in range(2):
                try:
                    slots.append(reserve_slot(Path.home() / ".cache" / "ccflare-local-workers"))
                except RuntimeError:
                    break
            print(json.dumps({"available": bool(slots), "freeWorkerSlots": len(slots), "model": args.model, "contextWindow": 100000, "apiCostUsd": 0}))
        finally:
            for slot in slots:
                slot.close()
        return 0
    prompt = args.prompt.read_text()
    if not args.dir.is_dir() or not prompt.strip() or len(prompt.encode()) > 120000:
        raise RuntimeError("Existing work directory and non-empty brief <=120000 bytes required.")
    values = scoped_environment(args)
    if args.dry_run:
        print(json.dumps({"command": command(args, values), "cwd": str(args.dir), "contextWindow": 100000, "maxWorkers": 2}))
        return 0
    slot = reserve_slot(Path.home() / ".cache" / "ccflare-local-workers")
    with slot:
        preflight(args)
        return run(args, prompt, values, slot.fileno())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Local worker failed: {error}", file=sys.stderr)
        sys.exit(1)
