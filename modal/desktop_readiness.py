"""Read-only, bounded X11 readiness checks before any billable model request.

Window identity plus non-black pixels is insufficient: require recognizable
Blender menu/setup text from a local OCR pass on the actual root capture.
No focus changes, key presses, native-file writes, or model API calls occur here.
"""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import time


class StartupUnready(RuntimeError):
    pass


def configure_isolated_x11(environment, *, xauthority="/tmp/draft.Xauthority",
                           runtime_dir="/tmp/draft-runtime"):
    """Force GUI children onto the owned Xvfb display, independent of host hints."""
    # Blender treats an empty value as the explicit opt-out that forces X11.
    environment["WAYLAND_DISPLAY"] = ""
    environment["XDG_SESSION_TYPE"] = "x11"
    environment["GDK_BACKEND"] = "x11"
    environment["DISPLAY"] = ":99"
    environment["XAUTHORITY"] = xauthority
    environment["XDG_RUNTIME_DIR"] = runtime_dir


def prepare_isolated_x11_runtime(environment):
    """Create the private runtime directory required by Blender's Wayland probe."""
    runtime = Path(environment["XDG_RUNTIME_DIR"])
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    runtime.chmod(0o700)
    return runtime


def receipt_error(error: Exception) -> str:
    """Return an operator-useful error without persisting credential fragments."""
    message = str(error)
    # Provider SDKs sometimes redact an API key only partially. A receipt is
    # durable Volume evidence, so replace the entire displayed key token.
    message = re.sub(r"\bsk-[A-Za-z0-9*_\-]+", "sk-[REDACTED]", message)
    return message[:1500]


def terminal_failure(error: Exception) -> dict[str, str]:
    """Return a terminal receipt patch without allowing error handling to mask its cause."""
    if isinstance(error, StartupUnready):
        return {
            "status": "blocked",
            "stop_reason": "startup_unready",
            "error": receipt_error(error),
            "desktop_readiness_report": "startup-readiness.json",
        }
    return {
        "status": "failed",
        "stop_reason": "runtime_error",
        "error": receipt_error(error),
    }


def recognizable_blender_ui(text):
    words = set(re.findall(r"[a-z]+", text.lower()))
    return (len(words & {"file", "edit", "render", "window", "help"}) >= 3
            or ("quick" in words and "setup" in words
                and len(words & {"language", "theme", "keymap", "select"}) >= 2))


def window_geometry(info):
    fields = {}
    for key, pattern in {
        "x": r"Absolute upper-left X:\s*(-?\d+)",
        "y": r"Absolute upper-left Y:\s*(-?\d+)",
        "width": r"Width:\s*(\d+)", "height": r"Height:\s*(\d+)",
    }.items():
        match = re.search(pattern, info)
        if not match:
            return None
        fields[key] = int(match.group(1))
    return fields if "Map State: IsViewable" in info else None


def healthy_observation(observation):
    """Conservative gate; a live process or successful scrot alone cannot pass."""
    return (bool(observation.get("processes"))
            and all(p.get("exit_code") is None for p in observation["processes"])
            and observation.get("x_ready") is True
            and observation.get("window_identity_verified") is True
            and observation.get("onscreen") is True
            and observation.get("nonblank") is True
            and recognizable_blender_ui(observation.get("ui_text", "")))


def bounded_poll(probe, *, deadline, record, ready, clock=time.monotonic, sleep=time.sleep):
    """Shared live polling seam; every subprocess in probe shares this deadline."""
    while clock() < deadline:
        observation = probe(deadline)
        record(observation)
        if any(p.get("exit_code") is not None for p in observation.get("processes", [])):
            raise StartupUnready("Isolated desktop process exited; see startup-readiness.json")
        if clock() < deadline and ready(observation):
            return observation
        remaining = deadline - clock()
        if remaining > 0:
            sleep(min(1, remaining))
    raise StartupUnready("Desktop readiness deadline expired; see startup-readiness.json")


class DesktopProbe:
    def __init__(self, root, processes, *, clock=time.monotonic):
        self.root, self.processes, self.clock = Path(root), processes, clock
        self.started = clock()
        self.observations = []
        report = self.root / "startup-readiness.json"
        if report.is_file():
            self.observations = json.loads(report.read_text()).get("observations", [])
        # All children and captures inherit this exact environment. Do not log
        # auth contents or API credentials.
        self.env = os.environ.copy()

    def command(self, argv, deadline, *, data=None):
        remaining = deadline - self.clock()
        if remaining <= 0:
            raise StartupUnready("Desktop readiness deadline expired")
        return subprocess.run(argv, input=data, capture_output=True, check=True,
                              timeout=min(5, remaining), env=self.env).stdout

    def record(self, observation):
        self.observations.append(observation)
        (self.root / "startup-readiness.json").write_text(json.dumps({
            "display": self.env.get("DISPLAY"),
            "xauthority_path": self.env.get("XAUTHORITY"),
            "observations": self.observations,
        }, indent=2))

    def sample(self, deadline, *, blender_pid=None):
        observation = {"elapsed_seconds": round(self.clock() - self.started, 3),
                       "monotonic_seconds": self.clock(),
                       "processes": [{"pid": p.pid, "exit_code": p.poll()} for p in self.processes]}
        if any(p["exit_code"] is not None for p in observation["processes"]):
            return observation
        try:
            self.command(["xdpyinfo"], deadline)
            observation["x_ready"] = True
            if blender_pid is None:
                return observation
            # This private Xvfb display contains only the owned desktop. Blender
            # may omit or rewrite _NET_WM_PID, so identity is a unique visible
            # Blender-class window rather than launcher-PID equality.
            ids = self.command(["xdotool", "search", "--onlyvisible", "--class",
                                "[Bb]lender"], deadline).decode().split()
            observation["candidate_windows"] = ids
            if len(ids) != 1:
                observation["window_identity_verified"] = False
                observation["window_identity_ambiguous"] = len(ids) > 1
                return observation
            window = ids[0]
            props = self.command(["xprop", "-id", window, "_NET_WM_PID", "WM_CLASS", "WM_NAME"], deadline).decode(errors="replace")
            observation["window_id"] = window
            observation["window_properties"] = props[:2000]
            observation["window_pid_matches_launcher"] = (
                re.search(r"_NET_WM_PID\([^)]*\)\s*=\s*" + str(blender_pid) + r"\b", props) is not None)
            observation["window_identity_verified"] = (
                re.search(r'WM_CLASS\([^)]*\).*"[Bb]lender"', props) is not None)
            info = self.command(["xwininfo", "-id", window], deadline).decode(errors="replace")
            geometry = window_geometry(info)
            observation["geometry"] = geometry
            if not geometry or not observation["window_identity_verified"]:
                return observation
            observation["active_window"] = self.command(["xprop", "-root", "_NET_ACTIVE_WINDOW"], deadline).decode(errors="replace").strip()
            observation["display_power"] = self.command(["xset", "q"], deadline).decode(errors="replace")[-1600:]
            shot = self.root / f"startup-{len(self.observations):03d}.png"
            self.command(["scrot", "-o", str(shot)], deadline)
            from PIL import Image, ImageStat
            with Image.open(shot) as image:
                w, h = image.size
                x, y, width, height = (geometry[k] for k in ("x", "y", "width", "height"))
                observation["capture_size"] = [w, h]
                observation["capture"] = shot.name
                observation["onscreen"] = (width >= 320 and height >= 200 and x >= 0 and y >= 0
                                             and x + width <= w and y + height <= h)
                if not observation["onscreen"]:
                    return observation
                crop = image.crop((x, y, x + width, y + height)).convert("RGB")
                stats = ImageStat.Stat(crop.convert("L"))
                observation["pixel_mean"] = stats.mean[0]
                observation["pixel_stddev"] = stats.stddev[0]
                observation["nonblank"] = stats.mean[0] > 8 and stats.stddev[0] > 4
                if not observation["nonblank"]:
                    return observation
                buffer = io.BytesIO()
                crop.save(buffer, format="PNG")
            observation["ui_text"] = self.command(["tesseract", "stdin", "stdout", "--psm", "11"],
                                                   deadline, data=buffer.getvalue()).decode(errors="replace")[:6000]
            # A process may have died during capture/OCR: check again before admission.
            observation["processes"] = [{"pid": p.pid, "exit_code": p.poll()} for p in self.processes]
        except (OSError, subprocess.SubprocessError, StartupUnready) as error:
            observation["probe_error"] = str(error)[:600]
        return observation


def wait_for_x(root, processes, deadline):
    probe = DesktopProbe(root, processes)
    bounded_poll(probe.sample, deadline=deadline, record=probe.record,
                 ready=lambda observation: observation.get("x_ready") is True)


def wait_for_desktop(root, processes, deadline):
    probe = DesktopProbe(root, processes)
    ready = bounded_poll(lambda end: probe.sample(end, blender_pid=processes[-1].pid),
                         deadline=deadline, record=probe.record, ready=healthy_observation)
    return (Path(root) / ready["capture"]).read_bytes(), ready
