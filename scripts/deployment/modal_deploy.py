#!/usr/bin/env python3
"""CI-owned Modal bootstrap, deploy, verification, and bounded remote probe.

This program is intentionally invoked only by the trusted GitHub deployment
controller. It writes no credentials to stdout: its sole stdout line is a
machine-readable receipt containing provider-issued public identifiers.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone


APP_NAME = "myth-maker-encounter-draft"
VOLUME_NAME = "myth-maker-encounter-submissions"
DICT_NAME = "myth-maker-encounter-component-leases"
SECRET_NAME = "myth-maker-encounter-openai"
PROBE_FUNCTION = "run_dispatch_probe"
REQUIRED_CREDENTIALS = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY")


def run(*args: str, capture: bool = False) -> str:
    completed = subprocess.run(args, check=True, text=True, capture_output=capture)
    return completed.stdout if capture else ""


def json_command(*args: str) -> list[dict]:
    parsed = json.loads(run(*args, capture=True))
    if not isinstance(parsed, list):
        raise RuntimeError(f"expected a list from {' '.join(args[:3])}")
    return parsed


def ensure_environment(environment: str) -> None:
    environments = json_command("modal", "environment", "list", "--json")
    if not any(item.get("name") == environment for item in environments):
        run("modal", "environment", "create", environment)
    observed = json_command("modal", "environment", "list", "--json")
    if not any(item.get("name") == environment for item in observed):
        raise RuntimeError(f"Modal environment {environment!r} was not observable after bootstrap")


def ensure_named_resources(environment: str) -> None:
    if not any(item.get("Name") == VOLUME_NAME for item in json_command("modal", "volume", "list", "--env", environment, "--json")):
        run("modal", "volume", "create", VOLUME_NAME, "--env", environment)
    # Modal Dict creation is already a documented no-op when it exists.
    run("modal", "dict", "create", DICT_NAME, "--env", environment)

    secrets = json_command("modal", "secret", "list", "--env", environment, "--json")
    if not any(item.get("Name") == SECRET_NAME for item in secrets):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as handle:
            handle.write(json.dumps({"OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]}))
            secret_file = handle.name
        try:
            os.chmod(secret_file, 0o600)
            run("modal", "secret", "create", SECRET_NAME, "--env", environment, "--from-json", secret_file)
        finally:
            Path(secret_file).unlink(missing_ok=True)

def observed_resource_ids(environment: str) -> dict[str, str]:
    """Read public Modal object IDs after bootstrap; never handle secret values here."""
    import modal

    volume = next((item for item in modal.Volume.objects.list(environment_name=environment) if item.name == VOLUME_NAME), None)
    lease_dict = next((item for item in modal.Dict.objects.list(environment_name=environment) if item.name == DICT_NAME), None)
    secret = next((item for item in modal.Secret.objects.list(environment_name=environment) if item.name == SECRET_NAME), None)
    if not volume or not lease_dict or not secret:
        raise RuntimeError("Modal named-resource verification did not resolve every required object")
    return {"volume": volume.object_id, "dict": lease_dict.object_id, "secret": secret.object_id}


def deploy_and_observe(environment: str, resources: dict[str, str]) -> dict:
    run("modal", "deploy", "--env", environment, "modal/draft_trial.py")
    apps = json_command("modal", "app", "list", "--env", environment, "--json")
    app = next((item for item in apps if item.get("Description") == APP_NAME and item.get("State") == "deployed"), None)
    if not app or not isinstance(app.get("App ID"), str):
        raise RuntimeError("Modal deployment did not produce an observable deployed app")
    history = json_command("modal", "app", "history", app["App ID"], "--env", environment, "--json")
    if not history or not isinstance(history[0].get("Version"), str):
        raise RuntimeError("Modal deployment did not produce an observable app version")

    import modal

    draft = modal.Function.from_name(APP_NAME, "run_draft", environment_name=environment)
    probe = modal.Function.from_name(APP_NAME, PROBE_FUNCTION, environment_name=environment)
    draft.hydrate()
    probe.hydrate()
    if not draft.object_id or not probe.object_id:
        raise RuntimeError("Modal function verification did not resolve provider function IDs")

    work_id = "ci-modal-probe"
    call = probe.spawn({"schema_version": "1", "work_id": work_id, "attempt": 1, "kind": "bounded-health-probe"})
    result = call.get(timeout=120)
    if not isinstance(result, dict) or result.get("status") != "completed" or result.get("work_id") != work_id:
        raise RuntimeError("Modal remote probe did not return a terminal work-order receipt")
    observed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    dispatch = {
        "status": "completed",
        "work_id": work_id,
        "function_call_id": call.object_id,
        "function_id": probe.object_id,
        "input_id": result.get("input_id"),
        "worker_id": result.get("worker_id"),
        "observed_at": observed_at,
    }
    if not all(isinstance(dispatch[key], str) and dispatch[key] for key in ("function_call_id", "function_id", "input_id", "worker_id")):
        raise RuntimeError("Modal probe receipt omitted provider-issued call, input, or worker identity")
    return {
        "deployment_id": app["App ID"],
        "version_id": history[0]["Version"],
        "resource_ids": [resources["volume"], resources["dict"], resources["secret"], draft.object_id, probe.object_id],
        "health": {"status": "healthy", "environment": environment, "app_id": app["App ID"], "run_draft_function_id": draft.object_id},
        "dispatch": dispatch,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", required=True)
    args = parser.parse_args()
    if any(not os.environ.get(key) for key in REQUIRED_CREDENTIALS):
        raise RuntimeError("Modal CI bootstrap requires Modal credentials and OPENAI_API_KEY after the environment gate")
    ensure_environment(args.environment)
    ensure_named_resources(args.environment)
    resources = observed_resource_ids(args.environment)
    print(json.dumps(deploy_and_observe(args.environment, resources), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
