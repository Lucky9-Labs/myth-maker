#!/usr/bin/env python3
"""Read a component-diffusion attempt's provider-persisted phase."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import modal
import sys

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from infrastructure import runtime


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--attempt", required=True, type=int)
    parser.add_argument("--component-id", required=True)
    parser.add_argument("--provider-call-id", default="")
    parser.add_argument("--cancel-provider-call", action="store_true")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = runtime(args.environment)
    status_function = modal.Function.from_name(
        config.app_name, "get_component_diffusion_status", environment_name=config.environment)
    diffusion_function = modal.Function.from_name(
        config.app_name, config.component_diffusion_function_name,
        environment_name=config.environment)
    status_function.hydrate()
    diffusion_function.hydrate()
    stats = diffusion_function.get_current_stats()
    status = status_function.remote(args.run_id, args.work_id, args.attempt, args.component_id)
    status["diffusion_function_stats"] = {
        "function_name": config.component_diffusion_function_name,
        "backlog": stats.backlog,
        "num_total_runners": stats.num_total_runners,
        "num_running_inputs": stats.num_running_inputs,
        "input_headroom": stats.input_headroom,
    }
    if args.provider_call_id:
        call = modal.FunctionCall.from_id(args.provider_call_id)
        status["provider_call_id"] = args.provider_call_id
        if args.cancel_provider_call:
            call.cancel(terminate_containers=True)
            status["provider_call_status"] = "cancelled"
            status["cancelled_at"] = datetime.now(timezone.utc).isoformat()
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n")
            print(json.dumps(status, sort_keys=True))
            return 0
        try:
            status["provider_result"] = call.get(timeout=0)
            status["provider_call_status"] = "completed"
        except (TimeoutError, modal.exception.TimeoutError):
            status["provider_call_status"] = "running"
        except Exception as error:
            status["provider_call_status"] = "failed"
            status["provider_error"] = {"type": type(error).__name__, "message": str(error)}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n")
    print(json.dumps(status, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
