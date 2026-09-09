"""GUI-only encounter-component draft validation and action guards."""
from __future__ import annotations

import re
import json


def classify_model_stop(report: str, has_native: bool) -> str:
    """Classify the end of a model turn independently from API response status."""
    markers = re.findall(r"^DRAFT_STATUS:\s*(PARTIAL|BLOCKED|READY_FOR_REVIEW)\s*$", report, re.MULTILINE)
    if markers == ["BLOCKED"]:
        return "blocked"
    if not has_native:
        return "blocked"
    # Fail closed: prose, conflicting markers and legacy reports are partial.
    if markers == ["READY_FOR_REVIEW"]:
        return "ready_for_review"
    return "checkpointed_partial"


def budget_phase(state: dict, remaining_seconds: float) -> str:
    """Leave headroom to save and hand off before the hard execution limits."""
    if (state.get("actions", 0) >= 350 or state.get("turns", 0) >= 40
            or state.get("input_tokens", 0) >= 650_000
            or state.get("output_tokens", 0) >= 20_000 or remaining_seconds <= 0):
        return "exhausted"
    if (state.get("actions", 0) >= 270 or state.get("turns", 0) >= 32
            or state.get("input_tokens", 0) >= 480_000
            or state.get("output_tokens", 0) >= 14_000 or remaining_seconds <= 150):
        return "checkpoint"
    return "work"


def finalize_terminal_state(state: dict, finalize) -> dict:
    """Run best-effort receipt cleanup without replacing an already recorded cause."""
    try:
        finalize()
    except Exception as error:
        state["terminal_cleanup_error"] = str(error)[:600]
    return state


def blender_launch_args(resuming: bool, component_id: str) -> list[str]:
    # /output and /inputs are stable aliases across containers. Opening through
    # /submissions/<new-job>/output silently rebases Blender's relative images.
    return ["blender", "--disable-autoexec", "--window-geometry", "0", "0", "1600", "1000",
            *(["/output/" + native_name(component_id)] if resuming else ["--factory-startup"])]


KEY_ALIASES = {
    "CTRL": "ctrl", "CONTROL": "ctrl", "SHIFT": "shift", "ALT": "alt",
    "META": "super", "SUPER": "super", "CMD": "super", "COMMAND": "super",
    "ENTER": "Return", "RETURN": "Return", "RET": "Return", "ESC": "Escape", "ESCAPE": "Escape",
    "BACKSPACE": "BackSpace", "DELETE": "Delete", "DEL": "Delete", "TAB": "Tab",
    "SPACE": "space", "ARROWUP": "Up", "ARROWDOWN": "Down",
    "ARROWLEFT": "Left", "ARROWRIGHT": "Right", "UP": "Up", "DOWN": "Down",
    "LEFT": "Left", "RIGHT": "Right", "HOME": "Home", "END": "End",
    "PAGEUP": "Prior", "PAGEDOWN": "Next", "NUMPADDECIMAL": "KP_Decimal",
    "DECIMAL": "KP_Decimal",
    "NUMPADDIVIDE": "KP_Divide", "NUMPADENTER": "KP_Enter", "NUMPADADD": "KP_Add",
    "NUMPADSUBTRACT": "KP_Subtract", "NUMPADMULTIPLY": "KP_Multiply",
    ".": "period", ",": "comma", "-": "minus", "/": "slash", "=": "equal",
    "+": "plus", "[": "bracketleft", "]": "bracketright", "`": "grave",
    "PERIOD": "period", "COMMA": "comma", "MINUS": "minus",
    "SLASH": "slash", "EQUAL": "equal", "PLUS": "plus",
    "BRACKETLEFT": "bracketleft", "BRACKETRIGHT": "bracketright", "GRAVE": "grave",
    "KPDECIMAL": "KP_Decimal", "NUMDECIMAL": "KP_Decimal",
    "KPDIVIDE": "KP_Divide", "NUMDIVIDE": "KP_Divide", "DIVIDE": "KP_Divide",
    "KPENTER": "KP_Enter", "NUMENTER": "KP_Enter",
    "KPADD": "KP_Add", "NUMADD": "KP_Add", "ADD": "KP_Add",
    "KPSUBTRACT": "KP_Subtract", "NUMSUBTRACT": "KP_Subtract", "SUBTRACT": "KP_Subtract",
    "KPMULTIPLY": "KP_Multiply", "NUMMULTIPLY": "KP_Multiply", "MULTIPLY": "KP_Multiply",
}

# Computer-tool pointer actions occasionally express the mouse button in the
# `keys` array. These are not X keyboard keysyms, so they must be separated
# before forwarding real keyboard modifiers to xdotool.
MOUSE_BUTTON_ALIASES = {
    "BUTTON1": "left", "BUTTON2": "middle", "BUTTON3": "right",
    "LEFTMOUSE": "left", "MIDDLEMOUSE": "middle", "RIGHTMOUSE": "right",
}


def normalize_keys(keys: list[str]) -> list[str]:
    if not isinstance(keys, list) or not keys or not all(isinstance(k, str) for k in keys):
        raise ValueError("keypress needs a non-empty string array")
    result = []
    for key in keys:
        upper = key.upper().replace("_", "")
        if re.fullmatch(r"(?:NUMPAD|NUM|KP)[0-9]", upper):
            result.append("KP_" + upper[-1])
        elif upper in KEY_ALIASES:
            result.append(KEY_ALIASES[upper])
        elif re.fullmatch(r"F(?:[1-9]|1[0-2])", upper):
            result.append(upper)
        elif len(key) == 1 and key.isascii() and key.isalnum():
            result.append(key.lower())
        elif key in {"period", "comma", "minus", "slash", "equal", "KP_Decimal", "KP_Divide", "KP_Enter"}:
            result.append(key)
        else:
            raise ValueError(f"Unsupported key name: {key!r}")
    if "shift" in result and "F4" in result:
        raise ValueError("Blender Python Console is outside this GUI-only trial")
    if "alt" in result and "F2" in result:
        raise ValueError("Desktop command launcher is outside this trial")
    if {"ctrl", "alt", "t"}.issubset(result):
        raise ValueError("External terminal shortcut is outside this trial")
    return result


def normalize_pointer_keys(keys: list[str] | None) -> tuple[list[str], str | None]:
    """Split a pointer button token from optional keyboard modifiers.

    BUTTON2 denotes the middle mouse button on X11. Keeping it out of
    ``normalize_keys`` means it is never injected as a keyboard keysym.
    """
    if keys is None:
        return [], None
    if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
        raise ValueError("pointer keys must be a string array")
    mouse_buttons = []
    keyboard_keys = []
    for key in keys:
        alias = MOUSE_BUTTON_ALIASES.get(key.upper().replace("_", ""))
        if alias:
            mouse_buttons.append(alias)
        else:
            keyboard_keys.append(key)
    if len(mouse_buttons) > 1:
        raise ValueError("pointer action may name at most one mouse button")
    return (normalize_keys(keyboard_keys) if keyboard_keys else [],
            mouse_buttons[0] if mouse_buttons else None)


def validate_typed_text(text: str) -> None:
    if not isinstance(text, str) or len(text) > 512 or not text.isascii():
        raise ValueError("Only short ASCII GUI field text is permitted")
    if any(token in text.lower() for token in (
        "bpy", "exec(", "eval(", "import ", "__", "subprocess", "python console",
        "os.system", "http://", "https://", "curl ", "wget ",
    )) or "\n" in text or "\r" in text:
        raise ValueError("Code, URLs and multiline pastes are outside this GUI-only trial")


def validate_input_names(inputs: dict[str, bytes], *, resuming: bool = False) -> None:
    expected = {"source_scene.blend", "structure_reference.png", "component_reference.png", "primary_artwork.png", "concept_reference.png"}
    if resuming and "source_scene.blend" not in inputs:
        expected.remove("source_scene.blend")
    if set(inputs) != expected or any(not isinstance(b, bytes) or not b for b in inputs.values()):
        raise ValueError("The trial requires the version-one five-file encounter input package")
    if sum(map(len, inputs.values())) > 30_000_000:
        raise ValueError("Unexpectedly large input package")


def validate_input_aliases(inputs: dict[str, bytes], aliases: dict[str, bytes]) -> None:
    """This repository starts fresh: checkpoint inputs have no legacy aliases."""
    if not isinstance(aliases, dict) or aliases:
        raise ValueError("Input aliases are unsupported in the encounter contract")


def native_name(component_id: str) -> str:
    """Return a stable, traversal-safe native filename for a component contract."""
    if not isinstance(component_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", component_id):
        raise ValueError("component_id must be lowercase kebab-case (1-64 characters)")
    return component_id + ".blend"

def validate_cloud_need(reviewed_score: float = -1) -> None:
    """A reviewed existing 4/10 draft belongs in local refinement, not cloud."""
    if reviewed_score != -1 and not 0 <= reviewed_score <= 10:
        raise ValueError("Reviewed score must be -1 (unreviewed) or 0..10")
    if reviewed_score >= 4:
        raise ValueError("Existing checkpoint meets cloud target; ship to local queue without remodeling")


def incremental_target(baseline_score: int) -> int:
    """Return the one-point cloud milestone, capped at the incremental 8/10 target."""
    if isinstance(baseline_score, bool) or not isinstance(baseline_score, int) or not 1 <= baseline_score <= 10:
        raise ValueError("baseline-score must be an integer from 1 through 10")
    return min(8, baseline_score + 1)


def parse_incremental_rating(text: str) -> dict | None:
    """Read the latest public model rating marker without treating it as acceptance."""
    markers = [line.strip() for line in text.splitlines() if line.strip().startswith("INCREMENTAL_RATING:")]
    if not markers:
        return None
    try:
        value = json.loads(markers[-1].split(":", 1)[1].strip())
    except (json.JSONDecodeError, IndexError) as error:
        raise ValueError("Malformed INCREMENTAL_RATING marker") from error
    if not isinstance(value, dict):
        raise ValueError("Malformed INCREMENTAL_RATING marker")
    score, reasons, evidence = value.get("score"), value.get("reasons"), value.get("evidence")
    if isinstance(score, bool) or not isinstance(score, int) or not 1 <= score <= 10:
        raise ValueError("INCREMENTAL_RATING score must be an integer from 1 through 10")
    if not isinstance(reasons, list) or not reasons or not all(isinstance(reason, str) and reason.strip() for reason in reasons):
        raise ValueError("INCREMENTAL_RATING requires non-empty string reasons")
    if not isinstance(evidence, str) or not evidence.strip():
        raise ValueError("INCREMENTAL_RATING requires an evidence pointer")
    return {"score": score, "reasons": reasons, "evidence": evidence}


def incremental_score_threshold_reached(*, baseline_score: int, current_score: int | None) -> bool:
    """A declared +1 freezes further modeling; a baseline at/above 8 is evidence-only."""
    if current_score is None:
        return False
    return current_score >= baseline_score if baseline_score >= 8 else current_score > baseline_score and current_score >= incremental_target(baseline_score)


def read_incremental_response(text: str, runner_state: dict) -> dict | None:
    """Contain model protocol errors; never coerce scores or mutate score history.

    The real response loop persists this diagnostic before bounded correction.
    The strict parser remains useful for validating trusted structured callers.
    """
    try:
        rating = parse_incremental_rating(text)
        if rating is None and runner_state.get("rating_correction_pending"):
            raise ValueError("Required corrective INCREMENTAL_RATING marker is missing")
    except ValueError as error:
        markers = [line.strip() for line in text.splitlines() if line.strip().startswith("INCREMENTAL_RATING:")]
        runner_state.setdefault("rating_protocol_errors", []).append({
            "turn": runner_state.get("turns"), "error": str(error),
            "raw_marker": markers[-1][:2000] if markers else None,
        })
        runner_state["rating_correction_pending"] = True
        return None
    if rating is not None:
        runner_state["rating_correction_pending"] = False
    return rating


def incremental_gain_reached(*, baseline_score: int, current_score: int | None, baseline_native_sha256: str,
                             current_native_sha256: str | None) -> bool:
    """A rating alone or unchanged parent bytes can never claim an incremental gain."""
    return (baseline_score < 8 and incremental_score_threshold_reached(
                baseline_score=baseline_score, current_score=current_score)
            and current_native_sha256 is not None and current_native_sha256 != baseline_native_sha256)


def incremental_evidence_ready(*, baseline_score: int, current_score: int | None,
                               baseline_native_mtime_ns: int, current_native_mtime_ns: int | None) -> bool:
    """At the 8/10 ceiling, require a GUI-save timestamp and rated visual evidence, not a fake gain."""
    return (baseline_score >= 8 and current_score is not None and current_score >= baseline_score
            and current_native_mtime_ns is not None and current_native_mtime_ns > baseline_native_mtime_ns)


def incremental_turn_plan(*, baseline_score: int, current_score: int | None,
                          save_only_instruction_issued: bool, has_computer_calls: bool) -> str:
    """Small, testable response-loop policy: score threshold first, GUI save second."""
    if not incremental_score_threshold_reached(baseline_score=baseline_score, current_score=current_score):
        return "execute_calls" if has_computer_calls else "ordinary_report"
    if has_computer_calls and not save_only_instruction_issued:
        return "skip_calls_for_save_only"
    return "request_save_only"


def record_incremental_rating(state: dict, rating: dict) -> dict:
    """Advance current assessment while preserving the caller-established baseline."""
    baseline = state.get("baseline_score")
    incremental_target(baseline)
    if rating.get("score") is None:
        raise ValueError("Incremental rating is missing score")
    updated = dict(state)
    updated["current_score"] = rating["score"]
    updated["current_rating"] = rating
    return updated

def render_prompt(template: str, component_id: str) -> str:
    name = native_name(component_id)
    return (template.replace("{{COMPONENT_ID}}", component_id)
            .replace("{{NATIVE}}", name))
