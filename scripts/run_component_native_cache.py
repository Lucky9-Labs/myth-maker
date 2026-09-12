import argparse, json
from pathlib import Path
import modal

def main():
    p=argparse.ArgumentParser(); p.add_argument('--environment',default='dev'); p.add_argument('--job-json',required=True); p.add_argument('--output',required=True); a=p.parse_args()
    job=json.loads(a.job_json); fn=modal.Function.from_name('myth-maker-draft-trial','run_component_native_cache_job',environment_name=a.environment)
    receipt=fn.remote(job); out=Path(a.output); out.parent.mkdir(parents=True,exist_ok=True); out.write_text(json.dumps(receipt,indent=2,sort_keys=True)+'\n')
if __name__=='__main__': main()
