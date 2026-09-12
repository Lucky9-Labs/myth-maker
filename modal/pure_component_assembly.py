"""Hash-locked assembly of component-derived meshes into an empty Blender scene."""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib, json, re, subprocess, time
from pathlib import Path

FORMAT = "myth-maker.pure-component-assembly-job/v1"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
SHA = re.compile(r"^[a-f0-9]{64}$")

def validate_pure_component_assembly_job(value: dict) -> dict:
    required={"format","run_id","work_id","attempt","asset_id","components","retired_sha256"}
    optional={"output_mode","placement_graph","component_evidence","frozen_reference_sha256"}
    if not isinstance(value,dict) or not required <= set(value) or not set(value) <= required|optional or value.get("format")!=FORMAT or value.get("asset_id")!="mech":
        raise ValueError("pure component assembly job has an invalid closed shape")
    if value.get("output_mode", "full") not in {"full", "review-preview"}:
        raise ValueError("pure component assembly output mode is invalid")
    if not all(isinstance(value.get(k),str) and NAME.fullmatch(value[k]) for k in ("run_id","work_id")):
        raise ValueError("pure component assembly identifiers are invalid")
    if not isinstance(value["attempt"],int) or isinstance(value["attempt"],bool) or value["attempt"]<1:
        raise ValueError("pure component assembly attempt is invalid")
    retired=value["retired_sha256"]
    if not isinstance(retired,list) or any(not isinstance(x,str) or not SHA.fullmatch(x) for x in retired):
        raise ValueError("pure component retired hashes are invalid")
    if not isinstance(value["components"],list) or not 1<=len(value["components"])<=32:
        raise ValueError("pure component assembly requires components")
    seen=set()
    for item in value["components"]:
        if not isinstance(item,dict) or set(item)!={"component_id","artifact","location","dimensions","rotation_degrees","mirror_x","material"}:
            raise ValueError("pure component assembly entry has an invalid shape")
        cid=item["component_id"]
        if not isinstance(cid,str) or not NAME.fullmatch(cid) or cid in seen: raise ValueError("component ids must be unique")
        seen.add(cid); art=item["artifact"]
        if (not isinstance(art,dict) or set(art)!={"path","bytes","sha256","media_type"}
            or art.get("media_type") not in {"model/gltf-binary","application/x-blender","application/x-blender-review-proxy"} or not isinstance(art.get("path"),str)
            or Path(art["path"]).is_absolute() or ".." in Path(art["path"]).parts
            or not isinstance(art.get("bytes"),int) or art["bytes"]<1 or not SHA.fullmatch(str(art.get("sha256","")))):
            raise ValueError("pure component artifact is invalid")
        if art["media_type"]=="application/x-blender-review-proxy" and value.get("output_mode","full")!="review-preview":
            raise ValueError("review proxy cannot enter full assembly")
        if art["sha256"] in retired: raise ValueError("retired component hash cannot enter pure assembly")
        for key,limit,positive in (("location",20,False),("dimensions",20,True),("rotation_degrees",360,False)):
            vals=item[key]
            if not isinstance(vals,list) or len(vals)!=3 or any(not isinstance(x,(int,float)) or isinstance(x,bool) or abs(x)>limit or (positive and x<=0) for x in vals):
                raise ValueError("pure component transform is invalid")
        if not isinstance(item["mirror_x"],bool) or item["material"] not in {"source","structural","armor-white","armor-blue","lens","metal"}:
            raise ValueError("pure component presentation is invalid")
    graph=value.get("placement_graph")
    evidence=value.get("component_evidence")
    reference=value.get("frozen_reference_sha256")
    if any(x is not None for x in (graph,evidence,reference)):
        if not SHA.fullmatch(str(reference or "")):
            raise ValueError("placement graph requires a frozen reference hash")
        if not isinstance(evidence,dict) or set(evidence)!=seen:
            raise ValueError("placement graph requires multiview evidence for every component")
        for cid, views in evidence.items():
            if not isinstance(views,list) or len(views)<2 or any(not isinstance(v,dict) or set(v)!={"view","sha256"} or not isinstance(v["view"],str) or not SHA.fullmatch(str(v["sha256"])) for v in views):
                raise ValueError("component multiview evidence is invalid")
        if not isinstance(graph,list) or len(graph)!=len(seen):
            raise ValueError("placement graph must cover every component")
        graph_ids=set()
        for node in graph:
            keys={"component_id","parent_component_id","parent_anchor","self_anchor","offset"}
            if not isinstance(node,dict) or set(node)!=keys or node.get("component_id") not in seen or node["component_id"] in graph_ids:
                raise ValueError("placement graph node is invalid")
            graph_ids.add(node["component_id"]); parent=node["parent_component_id"]
            if parent is not None and (parent not in seen or parent==node["component_id"]):
                raise ValueError("placement graph parent is invalid")
            for key,limit in (("parent_anchor",1),("self_anchor",1),("offset",5)):
                vals=node[key]
                if not isinstance(vals,list) or len(vals)!=3 or any(not isinstance(x,(int,float)) or isinstance(x,bool) or abs(x)>limit for x in vals):
                    raise ValueError("placement graph anchor is invalid")
        if graph_ids!=seen or not any(n["parent_component_id"] is None for n in graph):
            raise ValueError("placement graph must have a root and cover every component")
    return json.loads(json.dumps(value))

def run_pure_component_assembly(job:dict, submissions_root:Path, blender:str)->dict:
    checked=validate_pure_component_assembly_job(job)
    root=submissions_root/"asset-production"/checked["run_id"]/"pure-assembly"/checked["work_id"]/f"attempt-{checked['attempt']:04d}"
    if root.exists(): raise ValueError("pure component assembly attempt already exists")
    root.mkdir(parents=True); (root/"job.json").write_text(json.dumps(checked,indent=2,sort_keys=True)+"\n")
    for item in checked["components"]:
        path=submissions_root/item["artifact"]["path"]; data=path.read_bytes()
        if len(data)!=item["artifact"]["bytes"] or hashlib.sha256(data).hexdigest()!=item["artifact"]["sha256"]:
            raise ValueError("pure component artifact hash mismatch")
    started=datetime.now(timezone.utc); clock=time.monotonic()
    cp=subprocess.run([blender,"--background","--factory-startup","--disable-autoexec","--python","/opt/pure_component_assembly_blender.py","--","--job",str(root/"job.json"),"--submissions",str(submissions_root),"--output",str(root)],capture_output=True,text=True,timeout=28*60)
    expected=[root/"three-quarter.png",root/"front.png",root/"side.png",root/"manifest.json"]
    if checked.get("output_mode", "full") == "full": expected[:0]=[root/"assembly.blend",root/"assembly.glb"]
    if cp.returncode or not all(p.is_file() for p in expected):
        raise RuntimeError("pure component assembly failed: "+((cp.stderr or "")+"\n"+(cp.stdout or ""))[-3000:])
    media={".blend":"application/x-blender",".glb":"model/gltf-binary",".png":"image/png",".json":"application/json"}
    artifacts={}
    for p in expected:
        data=p.read_bytes(); artifacts[p.name]={"path":str(p.relative_to(submissions_root)),"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"media_type":media[p.suffix]}
    receipt={"format":"myth-maker.pure-component-assembly-receipt/v1","status":"completed","run_id":checked["run_id"],"work_id":checked["work_id"],"attempt":checked["attempt"],"asset_id":"mech","component_hashes":{x["component_id"]:x["artifact"]["sha256"] for x in checked["components"]},"artifacts":artifacts,"started_at":started.isoformat(),"completed_at":datetime.now(timezone.utc).isoformat(),"duration_ms":round((time.monotonic()-clock)*1000)}
    (root/"receipt.json").write_text(json.dumps(receipt,indent=2,sort_keys=True)+"\n")
    return receipt
