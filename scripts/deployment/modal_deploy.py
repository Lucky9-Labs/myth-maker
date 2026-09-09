#!/usr/bin/env python3
"""CI-owned Modal bootstrap, deploy, verification, and bounded remote probe.

This program is intentionally invoked only by the trusted GitHub deployment
controller. It writes no credentials to stdout. The controller supplies a
CI-private output path for the machine-readable public receipt.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


APP_NAME = "myth-maker-encounter-draft"
VOLUME_NAME = "myth-maker-encounter-submissions"
DICT_NAME = "myth-maker-encounter-component-leases"
SECRET_NAME = "myth-maker-encounter-openai"
PROBE_FUNCTION = "run_dispatch_probe"
ASSET_PRODUCTION_FUNCTION = "run_asset_production_job"
ASSET_CRITIQUE_FUNCTION = "run_asset_visual_critique"
ASSET_LEDGER_FUNCTION = "record_asset_production_run"
ASSET_PROGRESS_REFRESH_FUNCTION = "refresh_asset_progress_dashboards"
ASSET_PROGRESS_FETCH_FUNCTION = "get_asset_progress_dashboard"
ASSET_REFERENCE_EVALUATION_FUNCTION = "evaluate_asset_reference_progress"
ASSET_CORRECTION_PREPARE_FUNCTION = "prepare_asset_correction_wave"
REQUIRED_CREDENTIALS = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "OPENAI_API_KEY")
IMAGE_ID = re.compile(r"\bim-[A-Za-z0-9]+\b")
# The initial image pull/import can outlive the short CLI request cadence. Keep
# the CI probe bounded, but allow one cold start to reach a terminal receipt.
PROBE_TIMEOUT_SECONDS = 300


def run(*args: str, capture: bool = False) -> str:
    completed = subprocess.run(args, check=True, text=True, capture_output=capture)
    return completed.stdout if capture else ""


def json_command(*args: str) -> list[dict]:
    parsed = json.loads(run(*args, capture=True))
    if not isinstance(parsed, list):
        raise RuntimeError(f"expected a list from {' '.join(args[:3])}")
    return parsed


def has_named_resource(resources: list[dict], name: str) -> bool:
    """Accept the documented CLI's legacy and current JSON display keys."""
    return any(item.get("Name") == name or item.get("name") == name for item in resources)


def item_value(item: dict, legacy_key: str, current_key: str) -> str | None:
    value = item.get(legacy_key, item.get(current_key))
    return value if isinstance(value, str) else None


def deployed_app(apps: list[dict]) -> dict | None:
    """Find the app across Modal CLI JSON field-name revisions."""
    return next(
        (item for item in apps
         if item_value(item, "Description", "description") == APP_NAME
         and item_value(item, "State", "state") == "deployed"
         and item_value(item, "App ID", "app_id")),
        None,
    )


def ensure_environment(environment: str) -> None:
    environments = json_command("modal", "environment", "list", "--json")
    if not any(item.get("name") == environment for item in environments):
        run("modal", "environment", "create", environment)
    observed = json_command("modal", "environment", "list", "--json")
    if not any(item.get("name") == environment for item in observed):
        raise RuntimeError(f"Modal environment {environment!r} was not observable after bootstrap")


def ensure_named_resources(environment: str) -> None:
    if not has_named_resource(json_command("modal", "volume", "list", "--env", environment, "--json"), VOLUME_NAME):
        run("modal", "volume", "create", VOLUME_NAME, "--env", environment)
    # Modal Dict creation is already a documented no-op when it exists.
    run("modal", "dict", "create", DICT_NAME, "--env", environment)

    # A named secret can outlive the CI credential that originally created it.
    # Force replacement so the function deployed below receives the credential
    # passed to this immutable CI run, without ever printing its value.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False) as handle:
        handle.write(json.dumps({"OPENAI_API_KEY": os.environ["OPENAI_API_KEY"]}))
        secret_file = handle.name
    try:
        os.chmod(secret_file, 0o600)
        run("modal", "secret", "create", SECRET_NAME, "--env", environment, "--from-json", secret_file, "--force")
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
    # Secret existence is verified here but its object ID is deliberately not
    # emitted. Security scanners correctly treat secret identifiers as
    # potentially sensitive; the public receipt carries the dedicated name.
    return {"volume": volume.object_id, "dict": lease_dict.object_id}


def emit_failed_image_logs(error: subprocess.CalledProcessError) -> None:
    """Surface only the failed image layer after the provider redacts credentials."""
    output = "\n".join(str(value) for value in (error.stdout, error.stderr, error.output) if value)
    for credential in REQUIRED_CREDENTIALS:
        value = os.environ.get(credential)
        if value:
            output = output.replace(value, "[REDACTED]")
    if output:
        print(f"Modal deploy failure context:\n{output}", file=sys.stderr, end="")
    match = IMAGE_ID.search(output)
    if not match:
        return
    image_id = match.group(0)
    logs = subprocess.run(
        ("modal", "image", "logs", image_id, "--all"),
        text=True,
        capture_output=True,
        check=False,
    )
    if logs.stdout:
        print(f"Modal image build logs for {image_id}:\n{logs.stdout}", file=sys.stderr, end="")
    elif logs.stderr:
        print(f"Modal could not retrieve image build logs for {image_id}: {logs.stderr}", file=sys.stderr, end="")


def deploy_app(environment: str) -> None:
    try:
        run("modal", "deploy", "--env", environment, "modal/draft_trial.py", capture=True)
    except subprocess.CalledProcessError as error:
        emit_failed_image_logs(error)
        raise


def deploy_and_observe(environment: str, resources: dict[str, str]) -> dict:
    deploy_app(environment)
    apps = json_command("modal", "app", "list", "--env", environment, "--json")
    app = deployed_app(apps)
    app_id = item_value(app, "App ID", "app_id") if app else None
    if not app_id:
        raise RuntimeError("Modal deployment did not produce an observable deployed app")
    history = json_command("modal", "app", "history", app_id, "--env", environment, "--json")
    version_id = item_value(history[0], "Version", "version") if history else None
    if not version_id:
        raise RuntimeError("Modal deployment did not produce an observable app version")

    import modal

    draft = modal.Function.from_name(APP_NAME, "run_draft", environment_name=environment)
    probe = modal.Function.from_name(APP_NAME, PROBE_FUNCTION, environment_name=environment)
    production = modal.Function.from_name(APP_NAME, ASSET_PRODUCTION_FUNCTION, environment_name=environment)
    critique = modal.Function.from_name(APP_NAME, ASSET_CRITIQUE_FUNCTION, environment_name=environment)
    ledger = modal.Function.from_name(APP_NAME, ASSET_LEDGER_FUNCTION, environment_name=environment)
    progress_refresh = modal.Function.from_name(APP_NAME, ASSET_PROGRESS_REFRESH_FUNCTION, environment_name=environment)
    progress_fetch = modal.Function.from_name(APP_NAME, ASSET_PROGRESS_FETCH_FUNCTION, environment_name=environment)
    reference_evaluation = modal.Function.from_name(APP_NAME, ASSET_REFERENCE_EVALUATION_FUNCTION, environment_name=environment)
    correction_prepare = modal.Function.from_name(APP_NAME, ASSET_CORRECTION_PREPARE_FUNCTION, environment_name=environment)
    draft.hydrate()
    probe.hydrate()
    production.hydrate()
    critique.hydrate()
    ledger.hydrate()
    progress_refresh.hydrate()
    progress_fetch.hydrate()
    reference_evaluation.hydrate()
    correction_prepare.hydrate()
    if not all(item.object_id for item in (draft, probe, production, critique, ledger, progress_refresh, progress_fetch, reference_evaluation, correction_prepare)):
        raise RuntimeError("Modal function verification did not resolve provider function IDs")

    work_id = "ci-modal-probe"
    call = probe.spawn({"schema_version": "1", "work_id": work_id, "attempt": 1, "kind": "bounded-health-probe"})
    result = call.get(timeout=PROBE_TIMEOUT_SECONDS)
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
        "deployment_id": app_id,
        "version_id": version_id,
        "resource_ids": [resources["volume"], resources["dict"], draft.object_id, probe.object_id,
                         production.object_id, critique.object_id, ledger.object_id,
                         progress_refresh.object_id, progress_fetch.object_id, reference_evaluation.object_id, correction_prepare.object_id],
        "health": {
            "status": "healthy",
            "environment": environment,
            "app_id": app_id,
            "run_draft_function_id": draft.object_id,
            "asset_production_function_id": production.object_id,
            "asset_critique_function_id": critique.object_id,
            "asset_ledger_function_id": ledger.object_id,
            "asset_progress_refresh_function_id": progress_refresh.object_id,
            "asset_progress_fetch_function_id": progress_fetch.object_id,
            "asset_reference_evaluation_function_id": reference_evaluation.object_id,
            "asset_correction_prepare_function_id": correction_prepare.object_id,
            "max_asset_production_containers": 4,
            "verified_secret_name": SECRET_NAME,
            "dedicated_secret_verified": True,
        },
        "dispatch": dispatch,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if any(not os.environ.get(key) for key in REQUIRED_CREDENTIALS):
        raise RuntimeError("Modal CI bootstrap requires Modal credentials and OPENAI_API_KEY after the environment gate")
    ensure_environment(args.environment)
    ensure_named_resources(args.environment)
    resources = observed_resource_ids(args.environment)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(deploy_and_observe(args.environment, resources), separators=(",", ":")) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
