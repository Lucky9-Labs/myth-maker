"""Import the Modal entrypoint through an offline SDK-shaped shim.

This checks import-time wiring and decorators without authenticating to Modal or
creating a resource. Real deployment still uses Modal's pinned CLI in CI.
"""
from __future__ import annotations

import importlib
from pathlib import Path
import sys
from types import ModuleType


class _Chain:
    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: self


class _App(_Chain):
    def function(self, **_kwargs):
        return lambda function: function

    def local_entrypoint(self, **_kwargs):
        return lambda function: function


class _Factory:
    @classmethod
    def debian_slim(cls, *_args, **_kwargs):
        return _Chain()

    @classmethod
    def from_name(cls, *_args, **_kwargs):
        return _Chain()


def offline_modal_module() -> ModuleType:
    module = ModuleType("modal")
    module.App = lambda *_args, **_kwargs: _App()
    for name in ("Image", "Volume", "Secret", "Dict"):
        setattr(module, name, _Factory)
    module.current_function_call_id = lambda: "fc-offline-preview"
    module.current_input_id = lambda: "in-offline-preview"
    return module


def main() -> int:
    sys.modules["modal"] = offline_modal_module()
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    entrypoint = importlib.import_module("draft_trial")
    if not callable(getattr(entrypoint, "run_draft", None)):
        raise RuntimeError("draft_trial.run_draft is not importable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
