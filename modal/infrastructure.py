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
    volume_function_name: str = "run_draft_from_volume_manifest"
    deterministic_recipe_function_name: str = "run_deterministic_recipe"
    asset_production_function_name: str = "run_asset_production_job"
    asset_critique_function_name: str = "run_asset_visual_critique"
    asset_ledger_function_name: str = "record_asset_production_run"
    component_diffusion_function_name: str = "run_component_diffusion_job"
    component_cleanup_function_name: str = "run_component_cleanup_job"
    agentic_stitch_function_name: str = "run_agentic_stitch_job"
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
                "WORK_DISPATCH_TOKEN",
                "PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY",
                "CATALOG_ACCEPTANCE_TOKEN",
            ],
            "required_plain_configuration": [
                "WORK_DISPATCH_URL",
                "DEPLOYMENT_ENVIRONMENT",
            ],
        },
        "railway": {
            "project_name": "myth-maker",
            "environment_name": config.environment,
            "dispatcher_service_name": f"myth-maker-{config.environment}-dispatcher",
            "required_secret_names": [
                "WORK_DISPATCH_TOKEN",
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
                "MODAL_VOLUME_FUNCTION_NAME": config.volume_function_name,
                "MODAL_INPUT_MANIFEST_PATH": "modal/kraken_input_manifest.json",
                "COORDINATOR_WORK_ID_HEADER": "x-work-id",
            },
            "receiver": {
                "authorization_header": "Authorization: Bearer",
                "token_secret_name": "WORK_DISPATCH_TOKEN",
            },
        },
        "modal": asdict(config),
        "deterministic_recipe_fallback": {
            "format": "myth-maker.deterministic-encounter-recipe/v1",
            "function_name": config.deterministic_recipe_function_name,
            "requires_openai_secret": False,
            "artifacts": ["native-blend", "validated-glb", "initial-png", "intermediate-png", "final-png"],
            "rule": "The recipe is bounded generic construction data; named demos are caller-owned data, not runtime schema.",
        },
        "asset_production": {
            "format": "myth-maker.asset-production-job/v1",
            "function_name": config.asset_production_function_name,
            "critique_function_name": config.asset_critique_function_name,
            "ledger_function_name": config.asset_ledger_function_name,
            "component_diffusion_function_name": config.component_diffusion_function_name,
            "component_cleanup_function_name": config.component_cleanup_function_name,
            "agentic_stitch_function_name": config.agentic_stitch_function_name,
            "execution_boundary": "cloud-only-blender",
            "max_containers": 4,
            "worker_slots": ["worker-a", "worker-b", "worker-c", "worker-d"],
            "checkpoint_store": config.volume_name,
            "assembly_authority": "worker-d",
        },
        "connections": [
            {
                "from": "cloudflare.WORK_DISPATCH_URL",
                "to": "railway.dispatcher_service_name",
                "rule": "Set only to an explicit, independently provisioned Railway endpoint; deduplicate each delivery by its x-work-id header.",
            },
            {
                "from": "railway work order (schema_version 1)",
                "to": "modal.BlenderDraftWorkerAdapter -> run_draft_from_volume_manifest.remote",
                "rule": "The dispatcher validates a v1 work order and passes only an immutable input manifest; Modal resolves and verifies bytes inside its mounted Volume.",
            },
        ],
        "ci_deployment_controller": {
            "deployment_owner": "ci-only",
            "required_immutable_inputs": ["release_revision", "reviewed Terraform plan digest"],
            "required_secret_inputs": [
                "CLOUDFLARE_API_TOKEN",
                "TF_VAR_agent_ingress_token",
                "TF_VAR_work_dispatch_token",
                "TF_VAR_package_discovery_signing_private_key",
                "TF_VAR_catalog_acceptance_token",
                "TF_VAR_railway_token",
                "MODAL_TOKEN_ID",
                "MODAL_TOKEN_SECRET",
                "OPENAI_API_KEY",
            ],
            "post_deploy_receipts": [
                "Cloudflare Worker version/deployment IDs and binding/module digest snapshot",
                "Railway project/environment/service IDs and configured variable names",
                "Modal app deployment ID/version and named resource verification",
                "coordinator-to-dispatcher x-work-id acknowledgement",
            ],
        },
    }


def check_local_files() -> list[str]:
    root = Path(__file__).resolve().parent
    required = [root / "draft_trial.py", root / "draft_support.py",
                root / "asset_production.py", root / "asset_production_blender.py"]
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
