"""Bounded model coordinator for the immutable component production graph."""
from __future__ import annotations
import base64, hashlib, json, re, time
from datetime import datetime, timezone
from pathlib import Path

from component_cleanup import validate_component_cleanup_job
from component_diffusion import validate_component_diffusion_job
from component_isolation import validate_component_isolation_job
from component_review import validate_component_review_job
from pure_component_assembly import validate_pure_component_assembly_job

FORMAT="myth-maker.component-coordinator-job/v1"; NAME=re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
MODELS={"routing":"gpt-5.6-luna","visual":"gpt-6-astra"}
ACTION_TYPES={"revise-sheet","generate-multiview","generate-3d","review-3d","cleanup-3d","stitch-preview","hold"}
ACTION_VALIDATORS={
    "revise-sheet": validate_component_isolation_job,
    "generate-multiview": validate_component_isolation_job,
    "generate-3d": validate_component_diffusion_job,
    "review-3d": validate_component_review_job,
    "cleanup-3d": validate_component_cleanup_job,
    "stitch-preview": validate_pure_component_assembly_job,
}
SCHEMA={"type":"object","additionalProperties":False,"required":["format","assessment","selected_actions","component_dispositions"],"properties":{"format":{"type":"string","const":"myth-maker.component-coordinator-decision/v1"},"assessment":{"type":"string"},"selected_actions":{"type":"array","maxItems":4,"items":{"type":"object","additionalProperties":False,"required":["action_id","reason"],"properties":{"action_id":{"type":"string"},"reason":{"type":"string"}}}},"component_dispositions":{"type":"array","items":{"type":"object","additionalProperties":False,"required":["component_id","status","reason"],"properties":{"component_id":{"type":"string"},"status":{"type":"string","enum":["keep","repair","regenerate-sheet","regenerate-mesh","ready-for-preview","hold"]},"reason":{"type":"string"}}}}}}

def _artifact(x):
    return isinstance(x,dict) and set(x)=={"path","bytes","sha256","media_type"} and x.get("media_type")=="image/png" and isinstance(x.get("path"),str) and not Path(x["path"]).is_absolute() and ".." not in Path(x["path"]).parts and isinstance(x.get("bytes"),int) and x["bytes"]>0 and re.fullmatch(r"[a-f0-9]{64}",str(x.get("sha256","")))

def validate_component_coordinator_job(value):
    required={"format","run_id","work_id","attempt","role","model","objective","state_summary","evidence","prepared_actions","max_actions"}
    if not isinstance(value,dict) or set(value)!=required or value.get("format")!=FORMAT or value.get("role") not in MODELS or value.get("model")!=MODELS.get(value.get("role")): raise ValueError("component coordinator job has an invalid closed shape")
    if not all(isinstance(value.get(k),str) and NAME.fullmatch(value[k]) for k in ("run_id","work_id")): raise ValueError("component coordinator ids are invalid")
    if not isinstance(value["attempt"],int) or value["attempt"]<1 or not isinstance(value["max_actions"],int) or not 1<=value["max_actions"]<=4: raise ValueError("component coordinator bounds are invalid")
    if not isinstance(value["objective"],str) or not value["objective"] or not isinstance(value["state_summary"],dict): raise ValueError("component coordinator context is invalid")
    if not isinstance(value["evidence"],list) or len(value["evidence"])>8 or any(not _artifact(x) for x in value["evidence"]): raise ValueError("component coordinator evidence is invalid")
    if value["role"]=="routing" and value["evidence"]: raise ValueError("Luna routing cycles cannot consume image evidence")
    if not isinstance(value["prepared_actions"],list) or len(value["prepared_actions"])>32: raise ValueError("component coordinator actions are invalid")
    ids=set()
    for x in value["prepared_actions"]:
        if not isinstance(x,dict) or set(x)!={"action_id","action_type","component_id","summary","job"} or x["action_type"] not in ACTION_TYPES or not all(isinstance(x[k],str) and NAME.fullmatch(x[k]) for k in ("action_id","component_id")) or x["action_id"] in ids or not isinstance(x["summary"],str) or not isinstance(x["job"],dict): raise ValueError("prepared coordinator action is invalid")
        if x["action_type"]!="hold" and x["job"].get("asset_id")!="mech": raise ValueError("railgun and non-mech actions are frozen")
        if x["action_type"] != "hold":
            try:
                ACTION_VALIDATORS[x["action_type"]](x["job"])
            except ValueError as exc:
                raise ValueError(f"prepared {x['action_type']} job is invalid: {exc}") from exc
        ids.add(x["action_id"])
    return json.loads(json.dumps(value))

def run_component_coordinator(job,submissions_root,client):
    checked=validate_component_coordinator_job(job); root=submissions_root/"asset-production"/checked["run_id"]/"coordinator"/checked["work_id"]/f"attempt-{checked['attempt']:04d}"
    if root.exists(): raise ValueError("component coordinator attempt already exists")
    root.mkdir(parents=True); (root/"job.json").write_text(json.dumps(checked,indent=2,sort_keys=True)+"\n")
    role_instruction=("Route already-classified work using state and prepared action metadata. Do not make visual-quality claims. " if checked["role"]=="routing" else "Judge visual evidence and choose the bounded actions that best improve reference fidelity and integration. ")
    content=[{"type":"input_text","text":role_instruction+"You coordinate a component-first mech asset pipeline. Preserve useful immutable artifacts, but select only actions that materially advance a coherent stitched sculpture. Never choose railgun work. Prefer sheet revision before 3D when ownership is wrong; prefer repair over regeneration when silhouette is good; use stitch-preview to expose integration defects. Select at most %d prepared action IDs. Objective: %s\nSTATE:\n%s\nACTIONS:\n%s"%(checked["max_actions"],checked["objective"],json.dumps(checked["state_summary"]),json.dumps([{k:x[k] for k in ("action_id","action_type","component_id","summary")} for x in checked["prepared_actions"]]))}]
    for art in checked["evidence"]:
        p=submissions_root/art["path"]; data=p.read_bytes()
        if len(data)!=art["bytes"] or hashlib.sha256(data).hexdigest()!=art["sha256"]: raise ValueError("coordinator evidence hash mismatch")
        content.append({"type":"input_image","image_url":"data:image/png;base64,"+base64.b64encode(data).decode(),"detail":"original"})
    model=checked["model"]; started=datetime.now(timezone.utc); clock=time.monotonic(); response=client.responses.create(model=model,input=[{"role":"user","content":content}],reasoning={"effort":"low" if checked["role"]=="routing" else "medium"},text={"format":{"type":"json_schema","name":"component_coordinator_decision","strict":True,"schema":SCHEMA}},max_output_tokens=1500 if checked["role"]=="routing" else 3000,timeout=300)
    if response.status!="completed" or not response.output_text: raise RuntimeError("component coordinator model call did not complete")
    decision=json.loads(response.output_text); known={x["action_id"] for x in checked["prepared_actions"]}; selected=[x["action_id"] for x in decision["selected_actions"]]
    if len(selected)>checked["max_actions"] or len(selected)!=len(set(selected)) or any(x not in known for x in selected): raise ValueError("component coordinator selected invalid actions")
    usage=response.usage.model_dump() if response.usage else None
    receipt={"format":"myth-maker.component-coordinator-receipt/v1","status":"completed","run_id":checked["run_id"],"work_id":checked["work_id"],"attempt":checked["attempt"],"role":checked["role"],"decision":decision,"selected_action_ids":selected,"provider":{"name":"openai","model":model,"request_id":response.id},"model_usage":{"provenance":"measured" if usage else "unavailable","input_tokens":(usage or {}).get("input_tokens"),"cached_input_tokens":((usage or {}).get("input_tokens_details") or {}).get("cached_tokens"),"output_tokens":(usage or {}).get("output_tokens")},"started_at":started.isoformat(),"completed_at":datetime.now(timezone.utc).isoformat(),"duration_ms":round((time.monotonic()-clock)*1000)}
    (root/"receipt.json").write_text(json.dumps(receipt,indent=2,sort_keys=True)+"\n"); return receipt
