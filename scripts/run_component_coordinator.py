#!/usr/bin/env python3
import argparse,json,os,sys
from pathlib import Path
import modal
ROOT=Path(__file__).parents[1]; sys.path.insert(0,str(ROOT/'modal'))
from infrastructure import runtime
def main():
 p=argparse.ArgumentParser(); p.add_argument('--environment',default=os.environ.get('MODAL_ENVIRONMENT','dev')); p.add_argument('--job-json',required=True); p.add_argument('--output',required=True); a=p.parse_args(); cfg=runtime(a.environment)
 fn=modal.Function.from_name(cfg.app_name,'run_component_coordinator_cycle',environment_name=cfg.environment); result=fn.remote(json.loads(a.job_json)); out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
if __name__=='__main__': main()
