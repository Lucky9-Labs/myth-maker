from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from desktop_readiness import DesktopProbe, StartupUnready, bounded_poll, healthy_observation, recognizable_blender_ui, terminal_failure, window_geometry


class DesktopReadinessTests(unittest.TestCase):
    def test_terminal_failure_preserves_the_original_runtime_or_startup_cause(self):
        startup = terminal_failure(StartupUnready("desktop did not become ready"))
        runtime = terminal_failure(RuntimeError("provider authentication failed"))
        self.assertEqual(startup, {
            "status": "blocked",
            "stop_reason": "startup_unready",
            "error": "desktop did not become ready",
            "desktop_readiness_report": "startup-readiness.json",
        })
        self.assertEqual(runtime, {
            "status": "failed",
            "stop_reason": "runtime_error",
            "error": "provider authentication failed",
        })

    def healthy(self):
        return {"processes": [{"pid": 1, "exit_code": None}, {"pid": 2, "exit_code": None}, {"pid": 3, "exit_code": None}],
                "x_ready": True, "window_identity_verified": True, "onscreen": True, "nonblank": True,
                "ui_text": "File Edit Render Window Help"}

    def poll(self, observations, limit=3):
        now = [0]
        records = []
        def probe(deadline):
            return observations[min(int(now[0]), len(observations) - 1)]
        def sleep(seconds):
            now[0] += seconds
        result = bounded_poll(probe, deadline=limit, record=records.append,
                              ready=healthy_observation, clock=lambda: now[0], sleep=sleep)
        return result, records, now[0]

    def test_rejects_dead_process_unmapped_black_unrecognized_and_offscreen(self):
        for key, value in (("processes", [{"pid": 1, "exit_code": 1}]), ("x_ready", False),
                           ("window_identity_verified", False), ("onscreen", False),
                           ("nonblank", False), ("ui_text", "some nonblack pixels")):
            with self.subTest(key=key):
                observation = self.healthy() | {key: value}
                self.assertFalse(healthy_observation(observation))
                with self.assertRaises(StartupUnready):
                    self.poll([observation])

    def test_delayed_visible_blender_passes_before_deadline(self):
        black = self.healthy() | {"nonblank": False}
        actual, records, elapsed = self.poll([black, black, self.healthy()])
        self.assertTrue(healthy_observation(actual))
        self.assertEqual(len(records), 3)
        self.assertEqual(elapsed, 2)

    def test_no_admission_when_probe_finishes_after_deadline(self):
        now = [0]
        def slow_probe(deadline):
            now[0] = deadline + 1
            return self.healthy()
        with self.assertRaises(StartupUnready):
            bounded_poll(slow_probe, deadline=3, record=lambda _: None, ready=healthy_observation,
                         clock=lambda: now[0], sleep=lambda _: None)

    def test_quick_setup_requires_multiple_recognizable_controls(self):
        self.assertTrue(recognizable_blender_ui("Quick Setup Language Theme Keymap"))
        self.assertFalse(recognizable_blender_ui("Blender"))
        self.assertFalse(recognizable_blender_ui("Quick Setup"))

    def test_geometry_requires_actual_viewable_state(self):
        info = "Absolute upper-left X: 12\nAbsolute upper-left Y: 24\nWidth: 1500\nHeight: 950\nMap State: IsViewable"
        self.assertEqual(window_geometry(info), {"x": 12, "y": 24, "width": 1500, "height": 950})
        self.assertIsNone(window_geometry(info.replace("IsViewable", "IsUnMapped")))
        self.assertIsNone(window_geometry("Map State: IsViewable"))

    def test_adapter_commands_share_environment_and_remaining_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            probe = DesktopProbe(directory, [], clock=lambda: 10)
            with patch("desktop_readiness.subprocess.run", return_value=SimpleNamespace(stdout=b"ok")) as run:
                self.assertEqual(probe.command(["xdpyinfo"], 11), b"ok")
                self.assertEqual(run.call_args.kwargs["timeout"], 1)
                self.assertEqual(run.call_args.kwargs["env"], probe.env)
                self.assertTrue(run.call_args.kwargs["check"])
                with self.assertRaises(StartupUnready):
                    probe.command(["xdpyinfo"], 10)
                self.assertEqual(run.call_count, 1)

    def test_adapter_wrong_pid_or_class_cannot_admit_desktop(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        for props in (b'_NET_WM_PID(CARDINAL) = 43\nWM_CLASS(STRING) = "Blender", "Blender"',
                      b'_NET_WM_PID(CARDINAL) = 42\nWM_CLASS(STRING) = "Other", "Other"'):
            with self.subTest(props=props), tempfile.TemporaryDirectory() as directory:
                probe = DesktopProbe(directory, [process], clock=lambda: 0)
                probe.command = Mock(side_effect=[b"X11", b"123", props, b"unmapped"])
                observation = probe.sample(60, blender_pid=42)
                self.assertFalse(observation["window_identity_verified"])
                self.assertFalse(healthy_observation(observation))
                self.assertEqual(probe.command.call_args_list[1].args[0],
                                 ["xdotool", "search", "--all", "--onlyvisible", "--pid", "42", "--class", "[Bb]lender"])

    def test_adapter_dead_process_does_not_run_capture_or_ocr(self):
        process = Mock(pid=42)
        process.poll.return_value = 1
        with tempfile.TemporaryDirectory() as directory:
            probe = DesktopProbe(directory, [process], clock=lambda: 0)
            probe.command = Mock()
            self.assertFalse(healthy_observation(probe.sample(60, blender_pid=42)))
            probe.command.assert_not_called()

    def test_adapter_preserves_x_phase_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            first = DesktopProbe(directory, [], clock=lambda: 0)
            first.record({"x_ready": False})
            second = DesktopProbe(directory, [], clock=lambda: 1)
            second.record({"x_ready": True})
            self.assertEqual(second.observations, [{"x_ready": False}, {"x_ready": True}])


if __name__ == "__main__":
    unittest.main()
