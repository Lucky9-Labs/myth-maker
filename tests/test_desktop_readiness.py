from pathlib import Path
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from desktop_readiness import DesktopProbe, StartupUnready, bounded_poll, configure_isolated_x11, healthy_observation, prepare_isolated_x11_runtime, recognizable_blender_ui, receipt_error, terminal_failure, window_geometry


class DesktopReadinessTests(unittest.TestCase):
    def test_isolated_x11_environment_cannot_inherit_wayland_selection(self):
        environment = {"WAYLAND_DISPLAY": "wayland-0", "XDG_SESSION_TYPE": "wayland", "KEEP": "yes"}
        configure_isolated_x11(environment, xauthority="/tmp/test.Xauthority",
                               runtime_dir="/tmp/test-runtime")
        self.assertEqual(environment["WAYLAND_DISPLAY"], "")
        self.assertEqual(environment["XDG_SESSION_TYPE"], "x11")
        self.assertEqual(environment["GDK_BACKEND"], "x11")
        self.assertEqual(environment["DISPLAY"], ":99")
        self.assertEqual(environment["XAUTHORITY"], "/tmp/test.Xauthority")
        self.assertEqual(environment["XDG_RUNTIME_DIR"], "/tmp/test-runtime")
        self.assertEqual(environment["KEEP"], "yes")

    def test_isolated_runtime_directory_exists_with_owner_only_permissions(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary) / "runtime"
            environment = {"XDG_RUNTIME_DIR": str(runtime)}
            self.assertEqual(prepare_isolated_x11_runtime(environment), runtime)
            self.assertTrue(runtime.is_dir())
            self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o700)

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

    def test_terminal_receipt_redacts_partially_masked_provider_key_fragments(self):
        message = receipt_error(RuntimeError("Incorrect API key provided: sk-abcde*****vwxyz."))
        self.assertEqual(message, "Incorrect API key provided: sk-[REDACTED].")

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

    def test_adapter_uses_unique_blender_class_without_requiring_launcher_pid(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        cases = (
            (b'_NET_WM_PID(CARDINAL) = 43\nWM_CLASS(STRING) = "Blender", "Blender"', True),
            (b'_NET_WM_PID(CARDINAL) = 42\nWM_CLASS(STRING) = "Other", "Other"', False),
        )
        for props, verified in cases:
            with self.subTest(props=props), tempfile.TemporaryDirectory() as directory:
                probe = DesktopProbe(directory, [process], clock=lambda: 0)
                probe.command = Mock(side_effect=[b"X11", b"123", props, b"unmapped"])
                observation = probe.sample(60, blender_pid=42)
                self.assertEqual(observation["window_identity_verified"], verified)
                self.assertEqual(observation["window_pid_matches_launcher"], b" = 42" in props)
                self.assertFalse(healthy_observation(observation))
                self.assertEqual(probe.command.call_args_list[1].args[0],
                                 ["xdotool", "search", "--onlyvisible", "--class", "[Bb]lender"])
                self.assertFalse(probe.command.call_args_list[1].kwargs["check"])

    def test_adapter_rejects_ambiguous_blender_class_windows(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory:
            probe = DesktopProbe(directory, [process], clock=lambda: 0)
            probe.command = Mock(side_effect=[b"X11", b"123 456", b"root tree", b"123 456",
                                                  b'WM_CLASS = "Blender"', b'WM_CLASS = "Blender"'])
            observation = probe.sample(60, blender_pid=42)
            self.assertEqual(observation["candidate_windows"], ["123", "456"])
            self.assertFalse(observation["window_identity_verified"])
            self.assertTrue(observation["window_identity_ambiguous"])
            self.assertFalse(healthy_observation(observation))

    def test_adapter_records_bounded_nonvisible_window_diagnostics_without_admission(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory:
            probe = DesktopProbe(directory, [process], clock=lambda: 0)
            probe.command = Mock(side_effect=[b"X11", b"", b"root tree", b"789",
                                                  b'_NET_WM_PID(CARDINAL) = 99\nWM_CLASS(STRING) = "Blender"'])
            observation = probe.sample(60, blender_pid=42)
            self.assertEqual(observation["candidate_windows"], [])
            self.assertEqual(observation["x11_root_tree"], "root tree")
            self.assertEqual(observation["nonvisible_blender_candidates"], ["789"])
            self.assertEqual(observation["nonvisible_blender_properties"][0]["window_id"], "789")
            self.assertFalse(observation["window_identity_verified"])
            self.assertTrue(observation["nonvisible_window_class_verified"])
            self.assertFalse(observation["nonvisible_window_pid_verified"])
            self.assertNotIn("window_map_requested", observation)
            self.assertFalse(healthy_observation(observation))

    def test_adapter_maps_one_owned_nonvisible_blender_window_but_waits_for_later_proof(self):
        process = Mock(pid=42)
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory:
            probe = DesktopProbe(directory, [process], clock=lambda: 0)
            probe.command = Mock(side_effect=[b"X11", b"", b"root tree", b"789",
                                                  b'_NET_WM_PID(CARDINAL) = 42\nWM_CLASS(STRING) = "Blender"', b""])
            observation = probe.sample(60, blender_pid=42)
            self.assertEqual(observation["window_map_requested"], "789")
            self.assertTrue(observation["nonvisible_window_class_verified"])
            self.assertTrue(observation["nonvisible_window_pid_verified"])
            self.assertFalse(healthy_observation(observation))
            self.assertEqual(probe.command.call_args_list[-1].args[0], ["xdotool", "windowmap", "789"])

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
