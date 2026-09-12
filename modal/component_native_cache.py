"""Losslessly cache an immutable Hunyuan GLB as a native Blender checkpoint."""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib, json, re, subprocess, time
from pathlib import Path

FORMAT="myth-maker.component-native-cache-job/v1"
NAME=re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
SHA=re.compile(r"^[a-f0-9]{64}$")

def validate_component_native_cache_job(value:dict)->dict:
    required={"format","run_id","work_id","attempt","asset_id","component_id","source"}
    if not isinstance(value,dict) or not required<=set(value) or set(value)-required-{"review_face_budget"} or value.get("format")!=FORMAT or value.get("asset_id")!="mech":
        raise ValueError("component native cache job has an invalid closed shape")
    if not all(isinstance(value.get(k),str) and NAME.fullmatch(value[k]) for k in ("run_id","work_id","component_id")):
        raise ValueError("component native cache identifiers are invalid")
    if not isinstance(value.get("attempt"),int) or isinstance(value["attempt"],bool) or value["attempt"]<1:
        raise ValueError("component native cache attempt is invalid")
    art=value.get("source")
    if (not isinstance(art,dict) or set(art)!={"path","bytes","sha256","media_type"}
        or art.get("media_type") not in {"model/gltf-binary","application/x-blender"} or not isinstance(art.get("path"),str)
        or Path(art["path"]).is_absolute() or ".." in Path(art["path"]).parts
        or not isinstance(art.get("bytes"),int) or art["bytes"]<1 or not SHA.fullmatch(str(art.get("sha256","")))):
        raise ValueError("component native cache source is invalid")
    budget=value.get("review_face_budget")
    if budget is not None and (not isinstance(budget,int) or isinstance(budget,bool) or not 20000<=budget<=200000):
        raise ValueError("component native cache review face budget is invalid")
    return json.loads(json.dumps(value))

def run_component_native_cache(job:dict,submissions_root:Path,blender:str)->dict:
    checked=validate_component_native_cache_job(job)
    root=submissions_root/"asset-production"/checked["run_id"]/"component-native-cache"/checked["work_id"]/f"attempt-{checked['attempt']:04d}"
    if root.exists(): raise ValueError("component native cache attempt already exists")
    root.mkdir(parents=True); (root/"job.json").write_text(json.dumps(checked,indent=2,sort_keys=True)+"\n")
    source=submissions_root/checked["source"]["path"]; data=source.read_bytes()
    if len(data)!=checked["source"]["bytes"] or hashlib.sha256(data).hexdigest()!=checked["source"]["sha256"]:
        raise ValueError("component native cache source hash mismatch")
    started=datetime.now(timezone.utc); clock=time.monotonic()
    command=[blender,"--background","--factory-startup","--disable-autoexec","--python","/opt/component_native_cache_blender.py","--","--source",str(source),"--media-type",checked["source"]["media_type"],"--output",str(root/"component.blend"),"--component-id",checked["component_id"]]
    if checked.get("review_face_budget") is not None: command += ["--review-face-budget",str(checked["review_face_budget"])]
    cp=subprocess.run(command,capture_output=True,text=True,timeout=12*60)
    output=root/"component.blend"
    if cp.returncode or not output.is_file(): raise RuntimeError("component native cache failed: "+((cp.stderr or "")+"\n"+(cp.stdout or ""))[-3000:])
    review_only=checked.get("review_face_budget") is not None
    out=output.read_bytes(); artifact={"path":str(output.relative_to(submissions_root)),"bytes":len(out),"sha256":hashlib.sha256(out).hexdigest(),"media_type":"application/x-blender-review-proxy" if review_only else "application/x-blender"}
    receipt={"format":"myth-maker.component-native-cache-receipt/v1","status":"completed","run_id":checked["run_id"],"work_id":checked["work_id"],"attempt":checked["attempt"],"asset_id":"mech","component_id":checked["component_id"],"source":checked["source"],"artifact":artifact,"started_at":started.isoformat(),"completed_at":datetime.now(timezone.utc).isoformat(),"duration_ms":round((time.monotonic()-clock)*1000),"geometry_changed":review_only,"review_only":review_only,"review_face_budget":checked.get("review_face_budget"),"model_calls":0}
    (root/"receipt.json").write_text(json.dumps(receipt,indent=2,sort_keys=True)+"\n")
    return receipt
