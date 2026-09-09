#!/usr/bin/env python3
"""Submit a four-slot wave to the exact deployed Modal production function."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import modal


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from asset_production import fan_in_assembly_job, plan_production_wave
from infrastructure import runtime


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = runtime(args.environment)
    wave = plan_production_wave(json.loads(Path(args.manifest).read_text(encoding="utf-8")))
    production = modal.Function.from_name(
        config.app_name, config.asset_production_function_name,
        environment_name=config.environment,
    )
    production.hydrate()
    if not production.object_id:
        raise RuntimeError("deployed Modal asset-production function has no provider identity")
    expected = {item["runtime_deployment"]["function_id"] for item in wave}
    if expected != {production.object_id}:
        raise RuntimeError("wave runtime deployment does not match the resolved Modal function")

    calls = [production.spawn(item) for item in wave]
    receipts = [call.get(timeout=20 * 60) for call in calls]
    assembly = fan_in_assembly_job(wave, receipts)
    receipts.append(production.remote(assembly))
    ledger_function = modal.Function.from_name(
        config.app_name, config.asset_ledger_function_name,
        environment_name=config.environment,
    )
    ledger_function.hydrate()
    if not ledger_function.object_id:
        raise RuntimeError("deployed Modal asset ledger function has no provider identity")
    ledger = ledger_function.remote(wave, receipts)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"receipts": receipts, "ledger": ledger}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
