import json
import os
import tempfile
import unittest
from pathlib import Path

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import workspace  # noqa: E402
from host import HostError, dispatch, _workflow_event_from_system  # noqa: E402


class HostTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        os.environ["AIOS_WORKSPACE_ROOT"] = self.tempdir.name
        Path(self.tempdir.name, "context").mkdir(parents=True, exist_ok=True)
        Path(self.tempdir.name, "module-installs", "context-os-v1").mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_settings_round_trip(self):
        dispatch("set_setting", {"key": "claude_path", "value": "/tmp/claude"})
        result = dispatch("get_setting", {"key": "claude_path"})
        self.assertEqual(result["value"], "/tmp/claude")

    def test_unknown_command_is_blocked(self):
        with self.assertRaises(HostError):
            dispatch("run_bash", {"command": "echo unsafe"})

    def test_complete_onboarding_writes_context(self):
        dispatch("complete_onboarding", {"answers": {"role": "Founder", "offer": "AIOS implementation"}})
        personal = Path(self.tempdir.name, "context", "personal-info.md").read_text()
        business = Path(self.tempdir.name, "context", "business-info.md").read_text()
        self.assertIn("Founder", personal)
        self.assertIn("AIOS implementation", business)

    def test_safe_path_blocks_escape(self):
        with self.assertRaises(ValueError):
            workspace.read_file("../secret.txt")

    def test_dispatch_handlers_all_resolve(self):
        """Force the dispatch handlers dict to build and verify every
        entry resolves to a callable. Catches the class of bug where an
        edit deletes / renames a referenced function (e.g. voice_click)
        but leaves the dispatch entry that references it — every IPC then
        fails with NameError at runtime and the app appears completely
        broken. Without this test, that bug ships to users."""
        # Trigger the handlers dict build by calling dispatch with a
        # sentinel command. The dict is built BEFORE the unknown-command
        # check, so any NameError on a bound function fires here.
        with self.assertRaises(HostError) as ctx:
            dispatch("__validate_handlers__", {})
        # Should fail with UNKNOWN_COMMAND, not NameError or any other
        # binding error. If a referenced function doesn't exist, the
        # dispatch dict construction raises NameError before getting to
        # this check.
        self.assertEqual(ctx.exception.code, "UNKNOWN_COMMAND")

    def test_workflow_event_started(self):
        ev = _workflow_event_from_system({
            "type": "system", "subtype": "task_started",
            "workflow_name": "trivia-lookups",
            "description": "Three tiny lookups in parallel",
            "task_type": "local_workflow",
        })
        self.assertIsNotNone(ev)
        self.assertEqual(ev["state"], "started")
        self.assertEqual(ev["name"], "trivia-lookups")
        self.assertIn("trivia-lookups", ev["label"])

    def test_workflow_event_progress_counts_running_agents(self):
        # Shape captured live off CLI 2.1.156: workflow_progress is a cumulative
        # log; the same agent reappears as its state advances (last wins).
        ev = _workflow_event_from_system({
            "type": "system", "subtype": "task_progress",
            "description": "Lookup: number-of-continents",
            "workflow_progress": [
                {"type": "workflow_phase", "index": 1, "title": "Lookup"},
                {"type": "workflow_agent", "index": 1, "label": "capital-of-france", "phaseIndex": 1, "phaseTitle": "Lookup", "state": "start"},
                {"type": "workflow_agent", "index": 2, "label": "symbol-for-gold", "phaseIndex": 1, "phaseTitle": "Lookup", "state": "progress"},
                {"type": "workflow_agent", "index": 3, "label": "number-of-continents", "phaseIndex": 1, "phaseTitle": "Lookup", "state": "start"},
                # number-of-continents finishes — later entry must win.
                {"type": "workflow_agent", "index": 3, "label": "number-of-continents", "phaseIndex": 1, "phaseTitle": "Lookup", "state": "done"},
            ],
        })
        self.assertIsNotNone(ev)
        self.assertEqual(ev["state"], "running")
        self.assertEqual(ev["phase"], "Lookup")
        self.assertEqual(ev["total"], 3)
        self.assertEqual(ev["running"], 2)  # france(start) + gold(progress); continents done
        self.assertIn("Lookup", ev["label"])
        self.assertIn("2 agents running", ev["label"])

    def test_workflow_event_completed(self):
        ev = _workflow_event_from_system({
            "type": "system", "subtype": "task_notification", "status": "completed",
            "summary": 'Dynamic workflow "trivia-lookups" completed',
            "usage": {"total_tokens": 23651, "tool_uses": 3, "duration_ms": 4629},
        })
        self.assertIsNotNone(ev)
        self.assertEqual(ev["state"], "completed")
        self.assertEqual(ev["tokens"], 23651)
        self.assertEqual(ev["durationMs"], 4629)

    def test_workflow_event_ignores_non_workflow_system(self):
        self.assertIsNone(_workflow_event_from_system({"type": "system", "subtype": "status", "status": "requesting"}))
        self.assertIsNone(_workflow_event_from_system({"type": "system", "subtype": "init", "session_id": "x"}))
        self.assertIsNone(_workflow_event_from_system({"type": "system", "subtype": "task_progress"}))  # no workflow_progress


if __name__ == "__main__":
    unittest.main()
