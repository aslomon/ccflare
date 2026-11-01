import importlib.util
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch, Mock
import sys
import json

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "local-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_two_process_slots_release_on_close(self):
        with tempfile.TemporaryDirectory() as root:
            first = worker.reserve_slot(Path(root))
            second = worker.reserve_slot(Path(root))
            with self.assertRaises(RuntimeError):
                worker.reserve_slot(Path(root))
            first.close()
            third = worker.reserve_slot(Path(root))
            third.close()
            second.close()

    def test_explicit_local_aliases_and_reasoning_without_bare(self):
        args = SimpleNamespace(base_url="http://127.0.0.1:8081", model="qwen/test", thinking="off", effort="low", timeout=3600, read_only=False)
        env = worker.scoped_environment(args)
        self.assertEqual(env["ANTHROPIC_CUSTOM_HEADERS"], "x-ccflare-local-thinking: off")
        self.assertEqual(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], "qwen/test")
        self.assertEqual(env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"], "100000")
        command = worker.command(args, env)
        self.assertNotIn("--bare", command)
        self.assertNotIn("--dangerously-skip-permissions", command)
        self.assertNotIn("--tools", command)
        args.read_only = True
        self.assertIn("Read,Glob,Grep", worker.command(args, env))

    def test_timeout_always_writes_failure_summary(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            args = SimpleNamespace(output=directory / "report", dir=directory, timeout=0.03,
                                   model="qwen/test", thinking="off", effort="low")
            with worker.reserve_slot(directory / "slots") as slot:
                with patch.object(worker, "command", return_value=[sys.executable, "-c", "import time; time.sleep(20)"]):
                    self.assertEqual(worker.run(args, "test", {}, slot.fileno()), 1)
            summary = json.loads((args.output / "summary.json").read_text())
            self.assertTrue(summary["timedOut"])
            self.assertFalse(summary["ok"])

    def test_missing_process_group_is_normal_cleanup(self):
        process = Mock()
        with patch.object(worker.os, "killpg", side_effect=ProcessLookupError):
            worker.stop_worker(process)
        process.wait.assert_called_once()

    def test_truncated_result_stream_fails_closed(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "events.jsonl"
            path.write_text('{"type":"result","is_error":false}\n{"type":')
            result, truncated = worker.read_result(path)
            self.assertFalse(result["is_error"])
            self.assertTrue(truncated)


if __name__ == "__main__":
    unittest.main()
