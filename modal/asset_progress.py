"""Derived, immutable progress views for cloud asset-production runs."""
from __future__ import annotations

import base64
import hashlib
import html
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ASSETS = {
    "mech": {"job_types": {"mech-structure", "mech-armor"}, "views": ("full-body", "front", "gameplay-distance")},
    "railgun": {"job_types": {"railgun"}, "views": ("side", "gameplay-distance", "full-body")},
    "assembly": {"job_types": {"kit-assembly", "final-validation"}, "views": ("full-body", "gameplay-distance", "grip")},
}
RUBRIC = {"silhouette": 0.30, "proportions": 0.25, "component_geometry": 0.20,
          "material_identity": 0.10, "detail_readability": 0.10, "fit": 0.05}

def reference_evaluation_inputs(run_root: Path) -> dict[str, dict]:
    """Resolve one frozen reference and up to four verified revisions per asset."""
    developments = completed_developments(run_root)
    result = {}
    for asset_id in ("mech", "railgun"):
        values = developments[asset_id]
        if not values:
            continue
        reference = None
        for item in reversed(values):
            job = _read_json(item["render"].parents[2] / "job.json")
            if not job:
                continue
            for artifact in job.get("inputs", []):
                if artifact.get("media_type") not in {"image/png", "image/jpeg"}:
                    continue
                candidate = item["render"].parents[2] / "inputs" / artifact.get("staged_name", Path(artifact["path"]).name)
                try:
                    data = candidate.read_bytes()
                except OSError:
                    continue
                if len(data) == artifact.get("bytes") and hashlib.sha256(data).hexdigest() == artifact.get("sha256"):
                    reference = {"path": candidate, "sha256": artifact["sha256"]}
                    break
            if reference:
                break
        if reference:
            result[asset_id] = {"reference": reference, "developments": values}
    return result

def evaluation_set_digest(inputs: dict[str, dict]) -> str:
    identities = []
    for asset_id, value in sorted(inputs.items()):
        identities.append(asset_id + ":" + value["reference"]["sha256"])
        identities.extend(item["render_sha256"] for item in value["developments"])
    return hashlib.sha256("\n".join(identities).encode()).hexdigest()

def validate_reference_evaluation(value: dict, inputs: dict[str, dict]) -> dict:
    """Validate closed Astra output and calculate the weighted score locally."""
    if not isinstance(value, dict) or set(value) != {"format", "evaluations"} or value.get("format") != "myth-maker.asset-reference-evaluation/v1" or not isinstance(value.get("evaluations"), list):
        raise ValueError("invalid asset reference evaluation")
    expected = {(asset_id, item["render_sha256"]) for asset_id, data in inputs.items() for item in data["developments"]}
    observed, evaluations = set(), []
    required = {"asset_id", "render_sha256", "criteria", "confidence", "observable_delta", "blocking_visual_defects"}
    for raw in value["evaluations"]:
        if not isinstance(raw, dict) or set(raw) != required:
            raise ValueError("invalid reference evaluation row")
        identity = (raw["asset_id"], raw["render_sha256"])
        if identity not in expected or identity in observed or set(raw["criteria"]) != set(RUBRIC):
            raise ValueError("reference evaluation does not match requested revisions")
        if any(not isinstance(score, (int, float)) or isinstance(score, bool) or not 0 <= score <= 100 for score in raw["criteria"].values()):
            raise ValueError("reference criterion score is invalid")
        if not isinstance(raw["confidence"], (int, float)) or isinstance(raw["confidence"], bool) or not 0 <= raw["confidence"] <= 1:
            raise ValueError("reference evaluation confidence is invalid")
        if not isinstance(raw["observable_delta"], str) or not isinstance(raw["blocking_visual_defects"], list) or any(not isinstance(item, str) for item in raw["blocking_visual_defects"]):
            raise ValueError("reference evaluation evidence is invalid")
        row = json.loads(json.dumps(raw))
        row["weighted_score"] = round(sum(raw["criteria"][key] * weight for key, weight in RUBRIC.items()), 2)
        evaluations.append(row); observed.add(identity)
    if observed != expected:
        raise ValueError("reference evaluation omitted requested revisions")
    return {"format": value["format"], "evaluations": evaluations}

def _image_content(path: Path, label: str) -> list[dict]:
    data = path.read_bytes()
    return [{"type": "input_text", "text": label},
            {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(data).decode(), "detail": "original"}]

def evaluate_reference_progress(run_root: Path, client, model: str = "gpt-6-astra") -> dict:
    """Evaluate only unseen revision sets; the digest is the model-call idempotency key."""
    inputs = reference_evaluation_inputs(run_root)
    if not inputs:
        return {"status": "unavailable", "reason": "no completed asset revision with a verified reference"}
    digest = evaluation_set_digest(inputs)
    evaluation_root = run_root / "observability" / "evaluations"
    receipt_path = evaluation_root / f"{digest}.json"
    existing = _read_json(receipt_path)
    if existing:
        return existing
    content = [{"type": "input_text", "text": (
        "Judge artwork convergence only. Compare every candidate to its labeled frozen reference and to earlier candidates of the same asset. "
        "Return JSON only with format myth-maker.asset-reference-evaluation/v1 and evaluations. Each evaluation must contain asset_id, render_sha256, "
        "criteria with silhouette, proportions, component_geometry, material_identity, detail_readability, and fit scored 0-100, confidence 0-1, "
        "observable_delta as one concise evidence statement, and blocking_visual_defects as strings. Use the same strict scale for all revisions. "
        "Do not reward render polish that does not improve the modeled design.") }]
    for asset_id, data in inputs.items():
        content.extend(_image_content(data["reference"]["path"], f"{asset_id} FROZEN REFERENCE sha256 {data['reference']['sha256']}"))
        for index, item in enumerate(data["developments"], 1):
            content.extend(_image_content(item["render"], f"{asset_id} CANDIDATE {index} render_sha256 {item['render_sha256']}"))
    started = datetime.now(timezone.utc)
    response = client.responses.create(model=model, input=[{"role": "user", "content": content}],
        reasoning={"effort": "high"}, max_output_tokens=6000, timeout=300)
    if response.status != "completed" or not response.output_text:
        raise RuntimeError("reference evaluation did not complete")
    evaluation = validate_reference_evaluation(json.loads(response.output_text), inputs)
    usage = response.usage.model_dump() if response.usage else None
    cached = ((usage or {}).get("input_tokens_details") or {}).get("cached_tokens")
    receipt = {"format": "myth-maker.asset-reference-evaluation-receipt/v1", "status": "completed",
        "revision_set_sha256": digest, "created_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": round((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        "provider": {"name": "openai", "model": model, "request_id": response.id},
        "model_usage": {"provenance": "measured" if usage else "unavailable", "input_tokens": (usage or {}).get("input_tokens"),
                        "cached_input_tokens": 0 if usage is not None and cached is None else cached, "output_tokens": (usage or {}).get("output_tokens")},
        "evaluation": evaluation}
    evaluation_root.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt

def latest_reference_evaluation(run_root: Path) -> dict | None:
    receipts = [value for path in (run_root / "observability" / "evaluations").glob("*.json") if (value := _read_json(path))]
    return max(receipts, key=lambda item: item.get("created_at") or "") if receipts else None

def _progress_svg(evaluation: dict | None, developments: dict[str, list[dict]], output: Path) -> dict | None:
    if not evaluation:
        return None
    rows = evaluation["evaluation"]["evaluations"]
    points, polylines, labels = [], [], []
    colors = {"mech": "#67e8f9", "railgun": "#fbbf24"}
    for asset_id in ("mech", "railgun"):
        asset_rows = [row for row in rows if row["asset_id"] == asset_id]
        coordinates = []
        for index, row in enumerate(asset_rows):
            x = 90 + index * (780 / max(1, len(asset_rows) - 1)); y = 330 - row["weighted_score"] * 2.7
            coordinates.append(f"{x:.1f},{y:.1f}"); points.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{colors[asset_id]}"/><text x="{x:.1f}" y="{y-12:.1f}" text-anchor="middle" fill="#e5eefb">{row["weighted_score"]:.1f}</text>')
        if coordinates: polylines.append(f'<polyline points="{" ".join(coordinates)}" fill="none" stroke="{colors[asset_id]}" stroke-width="4"/>')
        labels.append(f'<text x="{100 + len(labels)*180}" y="385" fill="{colors[asset_id]}">● {asset_id}</text>')
    grid = "".join(f'<line x1="80" y1="{330-i*54}" x2="880" y2="{330-i*54}" stroke="#26364d"/><text x="45" y="{335-i*54}" fill="#9fb1c8">{i*20}</text>' for i in range(6))
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="960" height="410" viewBox="0 0 960 410"><rect width="960" height="410" fill="#111c2d"/><text x="40" y="35" fill="#f8fafc" font-size="20">Reference convergence over completed revisions</text>{grid}{"".join(polylines)}{"".join(points)}{"".join(labels)}</svg>'
    output.write_text(svg, encoding="utf-8")
    data = output.read_bytes()
    return {"path": output.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

def _instant(value) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None

def production_observability(run_root: Path, now: datetime | None = None) -> dict:
    """Project attempts, critique spend, and a rolling five-minute patch feed."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=5)
    attempts, patches, model_rows, defects = [], [], {}, []
    for path in run_root.glob("*/attempt-*/receipt.json"):
        receipt = _read_json(path)
        if not receipt:
            continue
        completed_at = (receipt.get("execution") or {}).get("completed_at")
        attempt = {"work_id": receipt.get("work_id"), "attempt": receipt.get("attempt"),
            "job_type": receipt.get("job_type"), "status": receipt.get("status"),
            "completed_at": completed_at, "duration_ms": (receipt.get("execution") or {}).get("duration_ms"),
            "input_hashes": receipt.get("input_hashes") or [], "output_hashes": receipt.get("output_hashes") or []}
        attempts.append(attempt)
        instant = _instant(completed_at)
        if instant and instant >= cutoff:
            patches.append(attempt)
    for path in run_root.glob("*/critique-attempt-*/receipt.json"):
        receipt = _read_json(path)
        if not receipt:
            continue
        provider, usage = receipt.get("provider") or {}, receipt.get("model_usage") or {}
        model = provider.get("model") or "unknown-model"
        row = model_rows.setdefault(model, {"model": model, "requests": 0, "input_tokens": 0,
            "cached_input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "duration_ms": 0,
            "provenance": "measured"})
        row["requests"] += 1
        if usage.get("provenance") != "measured":
            row["provenance"] = "unavailable"
        else:
            for field in ("input_tokens", "cached_input_tokens", "output_tokens"):
                row[field] += usage.get(field) or 0
            row["total_tokens"] += (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)
        row["duration_ms"] += receipt.get("duration_ms") or 0
        defects.extend((receipt.get("critique") or {}).get("defects") or [])
    for path in (run_root / "observability" / "evaluations").glob("*.json"):
        receipt = _read_json(path)
        if not receipt:
            continue
        provider, usage = receipt.get("provider") or {}, receipt.get("model_usage") or {}
        model = provider.get("model") or "unknown-model"
        row = model_rows.setdefault(model, {"model": model, "requests": 0, "input_tokens": 0,
            "cached_input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "duration_ms": 0, "provenance": "measured"})
        row["requests"] += 1
        if usage.get("provenance") != "measured": row["provenance"] = "unavailable"
        else:
            for field in ("input_tokens", "cached_input_tokens", "output_tokens"): row[field] += usage.get(field) or 0
            row["total_tokens"] += (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)
        row["duration_ms"] += receipt.get("duration_ms") or 0
    # Codex task-level usage is not present in production receipts. Keep the
    # desired comparison visible without turning unavailable telemetry into 0.
    model_rows.setdefault("gpt-5.6-luna", {"model": "gpt-5.6-luna", "requests": None,
        "input_tokens": None, "cached_input_tokens": None, "output_tokens": None,
        "total_tokens": None, "duration_ms": None, "provenance": "unavailable"})
    attempts.sort(key=lambda item: item.get("completed_at") or "", reverse=True)
    patches.sort(key=lambda item: item.get("completed_at") or "", reverse=True)
    completed = sum(item["status"] == "completed" for item in attempts)
    failed = sum(item["status"] == "failed" for item in attempts)
    evaluation = latest_reference_evaluation(run_root)
    scores = (evaluation or {}).get("evaluation", {}).get("evaluations", [])
    gains = []
    for asset_id in ("mech", "railgun"):
        asset_scores = [item["weighted_score"] for item in scores if item["asset_id"] == asset_id]
        gains.extend(max(0, current - prior) for prior, current in zip(asset_scores, asset_scores[1:]))
    measured_tokens = sum(row["total_tokens"] or 0 for row in model_rows.values() if row["provenance"] == "measured")
    compute_minutes = sum((item["duration_ms"] or 0) for item in attempts) / 60000
    return {"window_started_at": cutoff.isoformat(), "patches_last_5m": patches,
        "attempts": {"completed": completed, "failed": failed,
                     "success_rate": completed / (completed + failed) if completed + failed else None},
        "models": sorted(model_rows.values(), key=lambda item: item["model"]),
        "quality": {"blocking_open": sum(item.get("severity") == "blocking" and item.get("disposition") != "resolved" for item in defects),
                    "resolved": sum(item.get("disposition") == "resolved" for item in defects),
                    "cosmetic_backlog": sum(item.get("disposition") == "backlog" for item in defects),
                    "accepted_asset_set": False},
        "reference_convergence": {"provenance": "measured" if evaluation else "unavailable",
                                  "latest_evaluation": evaluation, "positive_quality_gain": round(sum(gains), 2) if evaluation else None},
        "efficiency": {"quality_gain_per_1k_tokens": round(sum(gains) * 1000 / measured_tokens, 3) if evaluation and measured_tokens else None,
                       "quality_gain_per_compute_minute": round(sum(gains) / compute_minutes, 3) if evaluation and compute_minutes else None,
                       "tokens_per_accepted_asset_set": {"provenance": "unavailable", "value": None},
                       "luna_comparison": "unavailable until Codex task usage is exported into the run ledger"}}

def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None

def completed_developments(run_root: Path, limit: int = 4) -> dict[str, list[dict]]:
    """Select the last N hash-verified renders for each logical asset."""
    selected = {asset_id: [] for asset_id in ASSETS}
    for receipt_path in run_root.glob("*/attempt-*/receipt.json"):
        receipt = _read_json(receipt_path)
        if not receipt or receipt.get("status") != "completed":
            continue
        asset_id = next((key for key, spec in ASSETS.items() if receipt.get("job_type") in spec["job_types"]), None)
        if not asset_id:
            continue
        artifacts = receipt.get("artifacts") or {}
        relative = next((f"renders/{view}.png" for view in ASSETS[asset_id]["views"] if f"renders/{view}.png" in artifacts), None)
        if not relative:
            continue
        render_path = receipt_path.parent / "output" / relative
        artifact = artifacts[relative]
        try:
            data = render_path.read_bytes()
        except OSError:
            continue
        if len(data) != artifact.get("bytes") or hashlib.sha256(data).hexdigest() != artifact.get("sha256"):
            continue
        selected[asset_id].append({"work_id": receipt.get("work_id"), "job_type": receipt.get("job_type"),
            "attempt": receipt.get("attempt"), "completed_at": (receipt.get("execution") or {}).get("completed_at"),
            "duration_ms": (receipt.get("execution") or {}).get("duration_ms"), "render": render_path,
            "render_sha256": artifact["sha256"]})
    for asset_id, values in selected.items():
        values.sort(key=lambda item: (item.get("completed_at") or "", item.get("attempt") or 0, item.get("work_id") or ""))
        selected[asset_id] = values[-limit:]
    return selected

def _gif(developments: list[dict], output: Path) -> dict | None:
    if not developments:
        return None
    from PIL import Image, ImageDraw, ImageOps
    frames = []
    for index, item in enumerate(developments, 1):
        with Image.open(item["render"]) as source:
            frame = ImageOps.contain(source.convert("RGB"), (960, 720))
        canvas = Image.new("RGB", (960, 780), "#111827")
        canvas.paste(frame, ((960 - frame.width) // 2, 0))
        ImageDraw.Draw(canvas).text((20, 740), f"{index}/{len(developments)}  {item['job_type']}  attempt {item['attempt']}  {item['render_sha256'][:12]}", fill="#f8fafc")
        frames.append(canvas)
    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(output, save_all=True, append_images=frames[1:], duration=1250, loop=0, optimize=False)
    data = output.read_bytes()
    return {"path": output.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "frames": len(frames)}

def build_dashboard(run_root: Path) -> dict:
    """Refresh GIFs and a self-contained HTML dashboard from completed attempts."""
    output = run_root / "observability"
    output.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc)
    developments = completed_developments(run_root)
    telemetry = production_observability(run_root, generated_at)
    chart = _progress_svg(telemetry["reference_convergence"]["latest_evaluation"], developments, output / "reference-convergence.svg")
    assets, cards = {}, []
    for asset_id, values in developments.items():
        gif = _gif(values, output / f"{asset_id}-last-four.gif")
        assets[asset_id] = {"gif": gif, "developments": [{k: v for k, v in item.items() if k != "render"} for item in values]}
        rows = "".join(f"<li><b>{html.escape(str(item['job_type']))}</b> attempt {item['attempt']} · {html.escape(str(item.get('completed_at') or 'time unavailable'))}</li>" for item in values)
        visual = f'<img src="{gif["path"]}?sha={gif["sha256"]}" alt="{asset_id} last four completed developments">' if gif else "<p>No completed render revisions yet.</p>"
        cards.append(f'<section><h2>{html.escape(asset_id.title())}</h2>{visual}<ol>{rows}</ol></section>')
    generated = generated_at.isoformat()
    patches = telemetry["patches_last_5m"]
    patch_rows = "".join(f"<tr><td>{html.escape(str(item['job_type']))}</td><td>{html.escape(str(item['status']))}</td><td>{item['attempt']}</td><td>{len(item['output_hashes'])}</td><td>{html.escape(str(item.get('completed_at') or 'unavailable'))}</td></tr>" for item in patches)
    if not patch_rows: patch_rows = '<tr><td colspan="5">No completed or failed asset patch in this five-minute window.</td></tr>'
    model_rows = "".join(f"<tr><td>{html.escape(row['model'])}</td><td>{html.escape(row['provenance'])}</td><td>{row['requests'] if row['requests'] is not None else 'unavailable'}</td><td>{row['input_tokens'] if row['input_tokens'] is not None else 'unavailable'}</td><td>{row['cached_input_tokens'] if row['cached_input_tokens'] is not None else 'unavailable'}</td><td>{row['output_tokens'] if row['output_tokens'] is not None else 'unavailable'}</td><td>{row['total_tokens'] if row['total_tokens'] is not None else 'unavailable'}</td></tr>" for row in telemetry["models"])
    quality = telemetry["quality"]; attempts = telemetry["attempts"]; efficiency = telemetry["efficiency"]
    chart_html = f'<section><h2>Artwork convergence</h2><img src="{chart["path"]}?sha={chart["sha256"]}" alt="reference convergence graph"><p class="muted">Weighted rubric: silhouette 30%, proportions 25%, component geometry 20%, material identity 10%, detail readability 10%, fit 5%.</p></section>' if chart else '<section><h2>Artwork convergence</h2><p>Awaiting the first reference evaluation.</p></section>'
    page = """<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="300"><meta name="viewport" content="width=device-width"><title>Asset production progress</title><style>body{margin:0;background:#07111f;color:#e5eefb;font:15px system-ui;padding:24px}main{max-width:1200px;margin:auto}.grid,.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}section,.metric{background:#111c2d;padding:16px;border-radius:12px;margin:18px 0}img{width:100%;border-radius:8px;background:#030712}small,.muted{color:#9fb1c8}li{margin:.4em 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #26364d}.bad{color:#fda4af}.good{color:#86efac}</style></head><body><main><h1>Cloud asset production progress</h1><small>Run """ + html.escape(run_root.name) + " · generated " + html.escape(generated) + " · refreshes every 5 minutes</small><div class=\"metrics\"><div class=\"metric\"><b>Attempts</b><br>" + str(attempts["completed"]) + " completed / " + str(attempts["failed"]) + " failed</div><div class=\"metric\"><b>Open blockers</b><br><span class=\"bad\">" + str(quality["blocking_open"]) + "</span></div><div class=\"metric\"><b>Quality gain / 1K tokens</b><br>" + str(efficiency["quality_gain_per_1k_tokens"] if efficiency["quality_gain_per_1k_tokens"] is not None else "unavailable") + "</div><div class=\"metric\"><b>Quality gain / compute minute</b><br>" + str(efficiency["quality_gain_per_compute_minute"] if efficiency["quality_gain_per_compute_minute"] is not None else "unavailable") + "</div></div>" + chart_html + "<section><h2>Asset patches in the last 5 minutes</h2><table><thead><tr><th>Lane</th><th>Status</th><th>Attempt</th><th>Output hashes</th><th>Completed</th></tr></thead><tbody>" + patch_rows + "</tbody></table></section><section><h2>Measured model spend</h2><table><thead><tr><th>Model</th><th>Provenance</th><th>Requests</th><th>Input</th><th>Cached</th><th>Output</th><th>Total tokens*</th></tr></thead><tbody>" + model_rows + "</tbody></table><p class=\"muted\">* Input plus output. Cached tokens are included in input and shown separately. Blender scripts use compute time and zero model calls. Luna remains unavailable until Codex exports task usage into the run ledger.</p></section><h2>Last four completed developments</h2><div class=\"grid\">" + "".join(cards) + "</div></main></body></html>"
    (output / "index.html").write_text(page, encoding="utf-8")
    manifest = {"format": "myth-maker.asset-progress-dashboard/v2", "run_id": run_root.name, "generated_at": generated, "refresh_seconds": 300, "telemetry": telemetry, "assets": assets}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest

def dashboard_bundle(run_root: Path) -> dict:
    manifest = build_dashboard(run_root)
    files = {path.name: base64.b64encode(path.read_bytes()).decode("ascii") for path in sorted((run_root / "observability").iterdir()) if path.is_file()}
    return {"manifest": manifest, "files_base64": files}
