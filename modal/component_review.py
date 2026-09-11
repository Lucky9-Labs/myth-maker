"""Cloud render and Astra cleanup review for one immutable generated component."""
from __future__ import annotations
import base64, hashlib, json, re, subprocess, time
from datetime import datetime, timezone
from pathlib import Path

FORMAT="myth-maker.component-review-job/v1"; MODEL="gpt-6-astra"; IDENTIFIER=re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
CRITERIA=("reference_fidelity","surface_coherence","part_completeness","attachment_readiness","articulation_readiness")
REVIEW_SCHEMA={"type":"object","additionalProperties":False,"required":["format","component_id","scores","blocking_defects","cleanup_actions","integration_guidance","decision"],"properties":{
    "format":{"type":"string","const":"myth-maker.component-review/v1"},"component_id":{"type":"string"},
    "scores":{"type":"object","additionalProperties":False,"required":list(CRITERIA),"properties":{key:{"type":"number","minimum":0,"maximum":100} for key in CRITERIA}},
    "blocking_defects":{"type":"array","items":{"type":"string"}},
    "cleanup_actions":{"type":"array","items":{"type":"string"}},
    "integration_guidance":{"type":"array","items":{"type":"string"}},
    "decision":{"type":"string","enum":["clean","regenerate","ready-to-stitch"]}}}

def _artifact(value, media):
    return (isinstance(value,dict) and set(value)=={"path","bytes","sha256","media_type"} and value.get("media_type")==media
            and isinstance(value.get("path"),str) and not Path(value["path"]).is_absolute() and ".." not in Path(value["path"]).parts
            and isinstance(value.get("bytes"),int) and value["bytes"]>0 and isinstance(value.get("sha256"),str) and re.fullmatch(r"[a-f0-9]{64}",value["sha256"]))

def validate_component_review_job(value):
    required={"format","run_id","work_id","attempt","asset_id","component_id","model","isolated_reference","candidate","attachment_surfaces"}
    if not isinstance(value,dict) or set(value)!=required: raise ValueError("component review job has an invalid closed shape")
    if value["format"]!=FORMAT or value["model"]!=MODEL or value["asset_id"] not in {"mech","railgun"}: raise ValueError("component review job has unsupported format, model, or asset")
    if not all(isinstance(value[k],str) and IDENTIFIER.fullmatch(value[k]) for k in ("run_id","work_id","component_id")): raise ValueError("component review identifiers are invalid")
    if not isinstance(value["attempt"],int) or isinstance(value["attempt"],bool) or value["attempt"]<1: raise ValueError("component review attempt must be positive")
    if not _artifact(value["isolated_reference"],"image/png") or not _artifact(value["candidate"],"model/gltf-binary"): raise ValueError("component review artifacts are invalid")
    if not isinstance(value["attachment_surfaces"],list) or any(not isinstance(v,str) or not IDENTIFIER.fullmatch(v) for v in value["attachment_surfaces"]): raise ValueError("component review attachment surfaces are invalid")
    return json.loads(json.dumps(value))

def _read_verified(root, artifact):
    path=root/artifact["path"]; data=path.read_bytes()
    if len(data)!=artifact["bytes"] or hashlib.sha256(data).hexdigest()!=artifact["sha256"]: raise ValueError("component review artifact hash mismatch")
    return path,data

def _image(path,label):
    return [{"type":"input_text","text":label},{"type":"input_image","image_url":"data:image/png;base64,"+base64.b64encode(path.read_bytes()).decode(),"detail":"original"}]

def _validate_result(value, component_id):
    required={"format","component_id","scores","blocking_defects","cleanup_actions","integration_guidance","decision"}
    if not isinstance(value,dict) or not required.issubset(value): raise ValueError("Astra component review omitted required fields")
    value={key:value[key] for key in required}
    value["format"]="myth-maker.component-review/v1"; value["component_id"]=component_id
    if set(value["scores"])!=set(CRITERIA) or any(not isinstance(v,(int,float)) or isinstance(v,bool) or not 0<=v<=100 for v in value["scores"].values()): raise ValueError("Astra component review scores are invalid")
    if value["decision"] not in {"clean","regenerate","ready-to-stitch"}: raise ValueError("Astra component decision is invalid")
    if not isinstance(value["blocking_defects"],list) or not isinstance(value["cleanup_actions"],list) or not isinstance(value["integration_guidance"],list): raise ValueError("Astra component guidance is invalid")
    return value

def run_component_review(job, submissions_root, blender, client):
    checked=validate_component_review_job(job); run_root=submissions_root/"asset-production"/checked["run_id"]
    reference,_=_read_verified(submissions_root,checked["isolated_reference"]); candidate,_=_read_verified(submissions_root,checked["candidate"])
    root=run_root/"component-reviews"/checked["work_id"]/f'attempt-{checked["attempt"]:04d}'
    if root.exists(): raise ValueError("component review attempt already exists")
    root.mkdir(parents=True); (root/"job.json").write_text(json.dumps(checked,indent=2,sort_keys=True)+"\n")
    started=datetime.now(timezone.utc); clock=time.monotonic()
    completed=subprocess.run([blender,"--background","--factory-startup","--disable-autoexec","--python","/opt/component_review_blender.py","--","--input",str(candidate),"--output",str(root/"renders")],capture_output=True,text=True,timeout=420)
    expected=[root/"renders/stats.json",root/"renders/three-quarter.png",root/"renders/front.png",root/"renders/side.png"]
    if completed.returncode or not all(path.is_file() for path in expected):
        log=((completed.stderr or "")+"\n"+(completed.stdout or "")).strip()[-2000:]
        raise RuntimeError("component diagnostic render failed or omitted evidence: "+log)
    stats=json.loads((root/"renders/stats.json").read_text()); content=[{"type":"input_text","text":(
      "Judge this isolated generated 3D component against its isolated design reference. Diagnose geometry before assembly. Return JSON only with format myth-maker.component-review/v1, component_id, scores for reference_fidelity, surface_coherence, part_completeness, attachment_readiness, articulation_readiness (0-100), blocking_defects, cleanup_actions, integration_guidance, and decision clean, regenerate, or ready-to-stitch. Cleanup actions must be bounded Blender operations with concrete parameters. Favor regenerate when the primary silhouette or topology is fundamentally wrong. Required attachment surfaces: "+", ".join(checked["attachment_surfaces"])+". Mesh stats: "+json.dumps(stats))}]
    content+=_image(reference,"ISOLATED DESIGN REFERENCE")
    for name in ("three-quarter","front","side"): content+=_image(root/f"renders/{name}.png",name.upper()+" GENERATED MESH")
    response=client.responses.create(model=checked["model"],input=[{"role":"user","content":content}],reasoning={"effort":"medium"},
        text={"format":{"type":"json_schema","name":"component_review","strict":True,"schema":REVIEW_SCHEMA}},max_output_tokens=3500,timeout=300)
    if response.status!="completed" or not response.output_text: raise RuntimeError("Astra component review did not complete")
    review=_validate_result(json.loads(response.output_text),checked["component_id"]); usage=response.usage.model_dump() if response.usage else None
    artifacts={}
    for path in sorted((root/"renders").iterdir()):
        data=path.read_bytes(); artifacts[path.name]={"path":str(path.relative_to(submissions_root)),"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"media_type":"application/json" if path.suffix==".json" else "image/png"}
    receipt={"format":"myth-maker.component-review-receipt/v1","status":"completed","run_id":checked["run_id"],"work_id":checked["work_id"],"attempt":checked["attempt"],"asset_id":checked["asset_id"],"component_id":checked["component_id"],"candidate_sha256":checked["candidate"]["sha256"],"review":review,"mesh_stats":stats,"artifacts":artifacts,"provider":{"name":"openai","model":checked["model"],"request_id":response.id},"model_usage":{"provenance":"measured" if usage else "unavailable","input_tokens":(usage or {}).get("input_tokens"),"cached_input_tokens":((usage or {}).get("input_tokens_details") or {}).get("cached_tokens"),"output_tokens":(usage or {}).get("output_tokens")},"started_at":started.isoformat(),"completed_at":datetime.now(timezone.utc).isoformat(),"duration_ms":round((time.monotonic()-clock)*1000)}
    (root/"receipt.json").write_text(json.dumps(receipt,indent=2,sort_keys=True)+"\n"); return receipt
