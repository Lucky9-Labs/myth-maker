#!/usr/bin/env python3
"""Run one measured correction wave against the current cloud baselines."""
from __future__ import annotations
import argparse, json, os, sys
from pathlib import Path
import modal
ROOT = Path(__file__).parents[1]; sys.path.insert(0, str(ROOT / "modal"))
from asset_production import fan_in_assembly_job
from infrastructure import runtime

def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--environment", default="dev")
    parser.add_argument("--run-id", required=True); parser.add_argument("--source-sha", required=True)
    parser.add_argument("--apply-reference-batch", action="store_true")
    parser.add_argument("--reference-batch-slot", choices=("worker-a", "worker-b", "worker-c"))
    parser.add_argument("--correction-spec-json")
    parser.add_argument("--output", required=True); args = parser.parse_args()
    config = runtime(args.environment)
    production = modal.Function.from_name(config.app_name, config.asset_production_function_name, environment_name=config.environment); production.hydrate()
    prepare = modal.Function.from_name(config.app_name, "prepare_asset_correction_wave", environment_name=config.environment)
    spec_json = args.correction_spec_json or os.environ.get("CORRECTION_SPEC")
    spec = json.loads(spec_json) if spec_json else None
    wave = prepare.remote(args.run_id, {"source_sha": args.source_sha, "function_id": production.object_id},
                          args.apply_reference_batch, args.reference_batch_slot, spec)
    calls = [production.spawn(job) for job in wave[:3]]; receipts = [call.get(timeout=20 * 60) for call in calls]
    if any(item.get("status") != "completed" for item in receipts):
        raise RuntimeError("one or more correction lanes failed; inspect returned receipts")
    assembly = fan_in_assembly_job(wave, receipts); receipts.append(production.remote(assembly))
    ledger = modal.Function.from_name(config.app_name, config.asset_ledger_function_name, environment_name=config.environment).remote(wave, receipts)
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"wave": wave, "receipts": receipts, "ledger": ledger}, indent=2, sort_keys=True) + "\n")
    if receipts[-1].get("status") != "completed": raise RuntimeError("corrected assembly failed")
    return 0
if __name__ == "__main__": raise SystemExit(main())
