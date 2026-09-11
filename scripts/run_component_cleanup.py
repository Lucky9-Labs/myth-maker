#!/usr/bin/env python3
"""Run one deterministic component cleanup in the deployed Modal runtime."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import modal
ROOT=Path(__file__).parents[1]; sys.path.insert(0,str(ROOT/'modal'))
from component_cleanup import validate_component_cleanup_job
from infrastructure import runtime

def main():
    p=argparse.ArgumentParser(); p.add_argument('--environment',default='dev'); p.add_argument('--job-json',required=True); p.add_argument('--output',required=True); a=p.parse_args()
    job=validate_component_cleanup_job(json.loads(a.job_json)); config=runtime(a.environment)
    receipt=modal.Function.from_name(config.app_name,'run_component_cleanup_job',environment_name=config.environment).remote(job)
    out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n')
    if receipt.get('status')!='completed': raise RuntimeError('component cleanup failed')
    return 0
if __name__=='__main__': raise SystemExit(main())
