"""Offline-only naming and configuration contract for the Modal runtime.

This module deliberately imports no Modal SDK. Running it validates and renders
the handoff only; it cannot authenticate, create resources, or deploy an app.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import argparse
import json
from pathlib import Path
import re


_ENVIRONMENT = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")


@dataclass(frozen=True)
class ModalRuntime:
    environment: str
    app_name: str = "myth-maker-encounter-draft"
    function_name: str = "run_draft"
    volume_name: str = "myth-maker-encounter-submissions"
    lease_dict_name: str = "myth-maker-encounter-component-leases"
    openai_secret_name: str = "myth-maker-encounter-openai"
    openai_secret_keys: tuple[str, ...] = ("OPENAI_API_KEY",)


def runtime(environment: str = "dev") -> ModalRuntime:
    if not _ENVIRONMENT.fullmatch(environment):
        raise ValueError("environment must be lowercase kebab-case, at most 32 characters")
    return ModalRuntime(environment=environment)


def application_contract(environment: str = "dev") -> dict:
    config = runtime(environment)
    worker_name = (
        "myth-maker-encounter-runtime"
        if config.environment == "dev"
        else f"myth-maker-{config.environment}-encounter-runtime"
    )
    return {
        "format": "myth-maker.infrastructure.application-config/v1",
        "environment": config.environment,
        "cloudflare": {
            "worker_name": worker_name,
            "durable_object": {
                "binding_name": "ENCOUNTER_COORDINATOR",
                "class_name": "EncounterCoordinator",
                "migration_tag": "v1",
            },
            "required_secret_names": [
                "AGENT_INGRESS_TOKEN",
                "COMPUTER_USE_DISPATCH_TOKEN",
            ],
            "required_plain_configuration": [
                "COMPUTER_USE_DISPATCH_URL",
                "DEPLOYMENT_ENVIRONMENT",
            ],
        },
        "railway": {
            "project_name": "myth-maker",
            "environment_name": config.environment,
            "dispatcher_service_name": f"myth-maker-{config.environment}-dispatcher",
            "required_secret_names": [
                "COMPUTER_USE_DISPATCH_TOKEN",
                "MODAL_TOKEN_ID",
                "MODAL_TOKEN_SECRET",
            ],
            "required_plain_configuration": {
                "COORDINATOR_WORK_ORDER_SCHEMA_VERSION": "1",
                "MODAL_ENVIRONMENT": config.environment,
                "MODAL_APP_NAME": config.app_name,
                "MODAL_ADAPTER_CLASS": "BlenderDraftWorkerAdapter",
                "MODAL_ADAPTER_RUNNER": "ModalDraftRunner",
                "MODAL_FUNCTION_NAME": config.function_name,
                "COORDINATOR_WORK_ID_HEADER": "x-work-id",
            },
        },
        "modal": asdict(config),
        "connections": [
            {
                "from": "cloudflare.COMPUTER_USE_DISPATCH_URL",
                "to": "railway.dispatcher_service_name",
                "rule": "Set only to an explicit, independently provisioned Railway endpoint; deduplicate each delivery by its x-work-id header.",
            },
            {
                "from": "railway work order (schema_version 1)",
                "to": "modal.BlenderDraftWorkerAdapter -> ModalDraftRunner -> run_draft.remote",
                "rule": "The dispatcher must validate a v1 work order, then use the adapter to derive legacy run_draft arguments.",
            },
        ],
    }


def check_local_files() -> list[str]:
    root = Path(__file__).resolve().parent
    required = [root / "draft_trial.py", root / "draft_support.py"]
    return [str(path) for path in required if not path.is_file()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Render the offline Myth Maker infrastructure handoff.")
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--check-files", action="store_true", help="Verify local Modal sources exist without contacting Modal.")
    args = parser.parse_args()

    missing = check_local_files() if args.check_files else []
    if missing:
        raise SystemExit("missing local Modal sources: " + ", ".join(missing))
    print(json.dumps(application_contract(args.environment), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
