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
    "mech": {"job_types": {"kit-assembly", "final-validation", "agentic-stitch"}, "views": ("full-body", "front", "gameplay-distance")},
    "railgun": {"job_types": {"railgun"}, "views": ("side", "gameplay-distance", "full-body")},
}
RUBRIC = {"silhouette": 0.30, "proportions": 0.25, "component_geometry": 0.20,
          "material_identity": 0.10, "detail_readability": 0.10, "fit": 0.05}
MODEL_PRICING = {
    "gpt-6-astra": {
        "input_usd_per_million": 10.0,
        "cached_input_usd_per_million": 1.0,
        "output_usd_per_million": 50.0,
        "source": "https://developers.openai.com/api/docs/models/gpt-6-astra",
        "verified_at": "2026-09-10",
    },
    "gpt-5.6-luna": {
        "input_usd_per_million": 0.20,
        "cached_input_usd_per_million": 0.02,
        "output_usd_per_million": 1.20,
        "source": "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
        "verified_at": "2026-09-10",
    },
}


def priced_model_usage(model: str, usage: dict) -> dict:
    """Price measured usage without treating unavailable usage as free."""
    pricing = MODEL_PRICING.get(model)
    fields = ("input_tokens", "cached_input_tokens", "output_tokens")
    if not pricing or usage.get("provenance") != "measured" or any(usage.get(field) is None for field in fields):
        return {"provenance": "unavailable", "usd": None, "breakdown_usd": None, "pricing": pricing}
    input_tokens = usage["input_tokens"]
    cached_tokens = usage["cached_input_tokens"]
    if cached_tokens < 0 or cached_tokens > input_tokens:
        return {"provenance": "unavailable", "usd": None, "breakdown_usd": None, "pricing": pricing}
    breakdown = {
        "uncached_input": round((input_tokens - cached_tokens) * pricing["input_usd_per_million"] / 1_000_000, 6),
        "cached_input": round(cached_tokens * pricing["cached_input_usd_per_million"] / 1_000_000, 6),
        "output": round(usage["output_tokens"] * pricing["output_usd_per_million"] / 1_000_000, 6),
    }
    return {"provenance": "calculated-from-measured-usage",
            "usd": round(sum(breakdown.values()), 6), "breakdown_usd": breakdown, "pricing": pricing}


def image_space_profile(path: Path) -> dict:
    """Measure coarse composition without asking a vision model.

    The border median estimates the background independently for light concept
    art and dark Blender renders.  These measurements intentionally describe
    only registration and silhouette; they are not an artistic similarity
    score.
    """
    from PIL import Image, ImageFilter, ImageStat
    with Image.open(path) as source:
        image = source.convert("RGB")
    image.thumbnail((512, 512))
    width, height = image.size
    samples = []
    pixels = image.load()
    for x in range(width):
        samples.extend((pixels[x, 0], pixels[x, height - 1]))
    for y in range(1, height - 1):
        samples.extend((pixels[0, y], pixels[width - 1, y]))
    background = tuple(sorted(pixel[channel] for pixel in samples)[len(samples) // 2] for channel in range(3))
    mask = Image.new("L", image.size)
    mask.putdata([255 if sum((pixel[i] - background[i]) ** 2 for i in range(3)) ** .5 >= 36 else 0
                  for pixel in image.getdata()])
    mask = mask.filter(ImageFilter.MedianFilter(3))
    bbox = mask.getbbox()
    if bbox is None:
        return {"foreground": False, "background_rgb": list(background)}
    left, top, right, bottom = bbox
    values = list(mask.getdata()); count = sum(value > 0 for value in values)
    xs = [index % width for index, value in enumerate(values) if value > 0]
    ys = [index // width for index, value in enumerate(values) if value > 0]
    edges = mask.filter(ImageFilter.FIND_EDGES)
    return {"foreground": True, "background_rgb": list(background),
            "bbox": [round(left / width, 4), round(top / height, 4), round(right / width, 4), round(bottom / height, 4)],
            "centroid": [round((sum(xs) / count) / width, 4), round((sum(ys) / count) / height, 4)],
            "occupancy": round(count / (width * height), 4),
            "aspect_ratio": round(((right - left) / width) / max((bottom - top) / height, 1e-6), 4),
            "edge_density": round(ImageStat.Stat(edges).mean[0] / 255, 4)}


def image_space_comparison(reference: Path, baseline: Path, candidate: Path) -> dict:
    """Compare candidate and baseline coarse geometry to the same reference."""
    profiles = {"reference": image_space_profile(reference), "baseline": image_space_profile(baseline),
                "candidate": image_space_profile(candidate)}
    fields = ("occupancy", "aspect_ratio", "edge_density")
    def distance(value: dict) -> float | None:
        target = profiles["reference"]
        if not target.get("foreground") or not value.get("foreground"):
            return None
        terms = [abs(value[field] - target[field]) / max(abs(target[field]), .05) for field in fields]
        terms.extend(abs(value["centroid"][index] - target["centroid"][index]) for index in (0, 1))
        return round(sum(terms) / len(terms), 4)
    baseline_distance, candidate_distance = distance(profiles["baseline"]), distance(profiles["candidate"])
    delta = None if baseline_distance is None or candidate_distance is None else round(baseline_distance - candidate_distance, 4)
    return {"format": "myth-maker.image-space-comparison/v1", "profiles": profiles,
            "baseline_distance": baseline_distance, "candidate_distance": candidate_distance,
            "improvement": delta,
            "decision": "reject-before-model" if delta is not None and delta < -.08 else "model-review"}


def _verified_reference(developments: list[dict], asset_id: str) -> dict | None:
    """Find the frozen, hash-verified reference even when no critique is due."""
    for item in reversed(developments):
        job = _read_json(item["render"].parents[2] / "job.json")
        if not job:
            continue
        artifacts = [artifact for artifact in job.get("inputs", [])
                     if artifact.get("media_type") in {"image/png", "image/jpeg"}]
        artifacts.sort(key=lambda artifact: asset_id not in
                       (artifact.get("staged_name", "") + artifact.get("path", "")).lower())
        for artifact in artifacts:
            candidate = item["render"].parents[2] / "inputs" / artifact.get("staged_name", Path(artifact["path"]).name)
            try:
                data = candidate.read_bytes()
            except OSError:
                continue
            if len(data) == artifact.get("bytes") and hashlib.sha256(data).hexdigest() == artifact.get("sha256"):
                return {"path": candidate, "sha256": artifact["sha256"]}
    return None


def _asset_component_signature(run_root: Path, asset_id: str, render_sha256: str) -> tuple[str, ...] | None:
    """Resolve the immutable component hashes that define one asset render."""
    attempts = []
    for path in run_root.glob("**/attempt-*/receipt.json"):
        receipt = _read_json(path)
        if receipt:
            attempts.append((path, receipt))
    rendered = [(path, receipt) for path, receipt in attempts
                if any((name.startswith("renders/") or name == "three-quarter.png") and item.get("sha256") == render_sha256
                       for name, item in (receipt.get("artifacts") or {}).items())]
    if not rendered:
        return None
    path, receipt = rendered[-1]
    if receipt.get("format") == "myth-maker.agentic-stitch-receipt/v1":
        return tuple(sorted((receipt.get("component_hashes") or {}).values())) or None
    if asset_id == "railgun":
        native = (receipt.get("artifacts") or {}).get("asset.blend")
        return (native["sha256"],) if native and native.get("sha256") else None
    dependencies = set((_read_json(path.parent / "job.json") or {}).get("dependencies") or [])
    hashes = []
    for slot in ("worker-a", "worker-b"):
        matches = [(candidate.get("artifacts") or {}).get("asset.blend", {}).get("sha256")
                   for _candidate_path, candidate in attempts if candidate.get("worker_slot") == slot]
        match = next((digest for digest in matches if digest in dependencies), None)
        if not match:
            return None
        hashes.append(match)
    return tuple(hashes)

def reference_evaluation_inputs(run_root: Path) -> dict[str, dict]:
    """Resolve one frozen reference, promoted baseline, and newest candidate per asset."""
    developments = completed_developments(run_root, limit=None)
    accepted_baselines = {}
    for row in reference_progress_history(run_root):
        if row["accepted"]:
            accepted_baselines[row["asset_id"]] = row["render_sha256"]
    result = {}
    for asset_id in ("mech", "railgun"):
        values = developments[asset_id]
        if not values:
            continue
        latest_protocol = values[-1].get("review_protocol", "legacy")
        values = [item for item in values if item.get("review_protocol", "legacy") == latest_protocol]
        historical_scores = {}
        evaluated_pairs = set()
        for path in (run_root / "observability" / "evaluations").glob("*.json"):
            receipt = _read_json(path) or {}
            asset_rows = [row for row in ((receipt.get("evaluation") or {}).get("evaluations") or [])
                          if row.get("asset_id") == asset_id]
            for row in asset_rows:
                if row.get("asset_id") == asset_id and isinstance(row.get("weighted_score"), (int, float)):
                    historical_scores[row.get("render_sha256")] = row["weighted_score"]
            if len(asset_rows) == 1:
                evaluated_pairs.add((None, asset_rows[0].get("render_sha256")))
            elif len(asset_rows) == 2:
                evaluated_pairs.add((asset_rows[0].get("render_sha256"), asset_rows[1].get("render_sha256")))
        latest = values[-1]
        prior = values[:-1]
        promoted_digest = accepted_baselines.get(asset_id)
        baseline = next((item for item in reversed(prior) if item["render_sha256"] == promoted_digest), None)
        if baseline is None and prior:
            baseline = max(prior, key=lambda item: historical_scores.get(item["render_sha256"], -1))
        comparison = (baseline["render_sha256"] if baseline else None, latest["render_sha256"])
        if comparison in evaluated_pairs:
            continue
        if baseline:
            baseline_signature = _asset_component_signature(run_root, asset_id, baseline["render_sha256"])
            latest_signature = _asset_component_signature(run_root, asset_id, latest["render_sha256"])
            if baseline_signature is not None and baseline_signature == latest_signature:
                continue
        values = ([baseline] if baseline else []) + [latest]
        values = list({item["render_sha256"]: item for item in values}.values())
        reference = _verified_reference(values, asset_id)
        # Assembly renders change whenever any component changes. Do not spend
        # a model call rescoring the mech when only Worker C mutated, or the
        # railgun when only the mech lanes mutated.
        attributed = _candidate_is_attributed(run_root, asset_id, latest["render_sha256"])
        if reference and attributed is not False:
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

MINIMUM_ACCEPTED_REFERENCE_DELTA = 3.0


def _job_mutates_geometry(job: dict) -> bool:
    mutating = {"apply-reference-corrections", "apply-parameterized-correction"}
    return bool(job.get("correction_spec") or any(item.get("kind") in mutating for item in job.get("operations") or []))


def _candidate_is_attributed(run_root: Path, asset_id: str, render_sha256: str | None) -> bool | None:
    """Say whether the render came from a targeted mutation of this asset.

    None preserves older evidence whose receipt/job provenance cannot be resolved.
    """
    attempts = []
    for path in run_root.glob("*/attempt-*/receipt.json"):
        receipt = _read_json(path)
        if receipt: attempts.append((path, receipt, _read_json(path.parent / "job.json")))
    rendered = [(path, receipt, job) for path, receipt, job in attempts
                if any(name.startswith("renders/") and item.get("sha256") == render_sha256
                       for name, item in (receipt.get("artifacts") or {}).items())]
    if not rendered:
        return None
    _path, receipt, job = rendered[-1]
    if not job:
        return None
    if asset_id == "railgun":
        if receipt.get("worker_slot") is None or "operations" not in job:
            return None
        return receipt.get("worker_slot") == "worker-c" and _job_mutates_geometry(job)
    dependencies = set(job.get("dependencies") or [])
    components = [(component_receipt, component_job) for _component_path, component_receipt, component_job in attempts
                  if component_receipt.get("worker_slot") in {"worker-a", "worker-b"}
                  and (component_receipt.get("artifacts") or {}).get("asset.blend", {}).get("sha256") in dependencies]
    return any(_job_mutates_geometry(component_job or {}) for component_receipt, component_job in components) if components else None


def reference_progress_history(run_root: Path) -> list[dict]:
    """Return one same-request delta for each newly observed candidate render."""
    receipts = sorted(
        (value for path in (run_root / "observability" / "evaluations").glob("*.json")
         if (value := _read_json(path)) and value.get("status") == "completed"),
        key=lambda item: item.get("created_at") or "")
    seen, cumulative, history = set(), {"mech": 0.0, "railgun": 0.0}, []
    for receipt in receipts:
        rows = (receipt.get("evaluation") or {}).get("evaluations") or []
        for asset_id in ("mech", "railgun"):
            asset_rows = [row for row in rows if row.get("asset_id") == asset_id]
            if len(asset_rows) != 2:
                continue
            candidate = asset_rows[-1]
            identity = (asset_id, candidate.get("render_sha256"))
            if identity in seen:
                continue
            attributed = _candidate_is_attributed(run_root, asset_id, candidate.get("render_sha256"))
            if attributed is False:
                continue
            seen.add(identity)
            delta = round(candidate["weighted_score"] - asset_rows[0]["weighted_score"], 2)
            accepted = delta >= MINIMUM_ACCEPTED_REFERENCE_DELTA
            if accepted:
                cumulative[asset_id] = round(cumulative[asset_id] + delta, 2)
            history.append({"created_at": receipt.get("created_at"), "asset_id": asset_id,
                            "render_sha256": candidate.get("render_sha256"), "delta": delta,
                            "attribution": "measured" if attributed else "unavailable",
                            "accepted": accepted,
                            "disposition": "accepted" if accepted else ("below-threshold" if delta > 0 else "rejected"),
                            "cumulative_accepted_gain": cumulative[asset_id]})
    return history

def _progress_svg(history: list[dict], output: Path) -> dict | None:
    if not history:
        return None
    points, polylines, labels = [], [], []
    colors = {"mech": "#67e8f9", "railgun": "#fbbf24"}
    extrema = [0.0] + [row["cumulative_accepted_gain"] for row in history]
    low, high = min(extrema), max(extrema)
    span = max(1.0, high - low)
    for asset_id in ("mech", "railgun"):
        asset_rows = [row for row in history if row["asset_id"] == asset_id]
        coordinates = []
        for index, row in enumerate(asset_rows):
            x = 90 + index * (780 / max(1, len(asset_rows) - 1)); y = 330 - ((row["cumulative_accepted_gain"] - low) / span) * 270
            coordinates.append(f"{x:.1f},{y:.1f}")
            point_color = colors[asset_id] if row["accepted"] else "#fb7185"
            points.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="6" fill="{point_color}"/><text x="{x:.1f}" y="{y-12:.1f}" text-anchor="middle" fill="#e5eefb">{row["delta"]:+.1f}</text>')
        if coordinates: polylines.append(f'<polyline points="{" ".join(coordinates)}" fill="none" stroke="{colors[asset_id]}" stroke-width="4"/>')
        labels.append(f'<text x="{100 + len(labels)*180}" y="385" fill="{colors[asset_id]}">● {asset_id}</text>')
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="960" height="410" viewBox="0 0 960 410"><rect width="960" height="410" fill="#111c2d"/><text x="40" y="35" fill="#f8fafc" font-size="20">Cumulative accepted reference progress</text>{"".join(polylines)}{"".join(points)}{"".join(labels)}<text x="460" y="385" fill="#fb7185">● rejected candidate</text></svg>'
    output.write_text(svg, encoding="utf-8")
    data = output.read_bytes()
    return {"path": output.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}

def _spend_svg(history: list[dict], output: Path) -> dict | None:
    """Plot cumulative USD, accepted gain, and gain per dollar per model call."""
    if not history:
        return None
    max_cost = max(item["cumulative_cost_usd"] for item in history) or 1
    max_gain = max(item["cumulative_accepted_gain"] for item in history) or 1
    max_efficiency = max(item["accepted_gain_per_usd"] or 0 for item in history) or 1
    def points(field, maximum):
        return " ".join(f'{90 + index * (780 / max(1, len(history) - 1)):.1f},'
                        f'{330 - (item[field] or 0) / maximum * 270:.1f}'
                        for index, item in enumerate(history))
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="960" height="410" viewBox="0 0 960 410">'
           '<rect width="960" height="410" fill="#111c2d"/>'
           '<text x="40" y="35" fill="#f8fafc" font-size="20">Spend and accepted improvement over model calls</text>'
           f'<polyline points="{points("cumulative_cost_usd", max_cost)}" fill="none" stroke="#67e8f9" stroke-width="4"/>'
           f'<polyline points="{points("cumulative_accepted_gain", max_gain)}" fill="none" stroke="#86efac" stroke-width="4"/>'
           f'<polyline points="{points("accepted_gain_per_usd", max_efficiency)}" fill="none" stroke="#fbbf24" stroke-width="4"/>'
           f'<text x="100" y="385" fill="#67e8f9">USD ${max_cost:.2f}</text>'
           f'<text x="280" y="385" fill="#86efac">accepted gain {max_gain:.1f}</text>'
           f'<text x="500" y="385" fill="#fbbf24">gain / $ {history[-1]["accepted_gain_per_usd"] or 0:.3f}</text>'
           '</svg>')
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
    attempts, patches, model_rows, model_events, defects = [], [], {}, [], []
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
        model_events.append({"created_at": receipt.get("created_at"), "model": model,
                             "request_id": provider.get("request_id"),
                             "cost": priced_model_usage(model, usage)})
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
        model_events.append({"created_at": receipt.get("created_at"), "model": model,
                             "request_id": provider.get("request_id"),
                             "cost": priced_model_usage(model, usage)})
    # Codex task-level usage is not present in production receipts. Keep the
    # desired comparison visible without turning unavailable telemetry into 0.
    model_rows.setdefault("gpt-5.6-luna", {"model": "gpt-5.6-luna", "requests": None,
        "input_tokens": None, "cached_input_tokens": None, "output_tokens": None,
        "total_tokens": None, "duration_ms": None, "provenance": "unavailable",
        "telemetry_scope": "codex-account-only",
        "unavailable_reason": "Codex exposes an account-wide allowance, not per-task Luna token usage; no Luna API receipt exists in this run."})
    for row in model_rows.values():
        row["cost"] = priced_model_usage(row["model"], row)
    attempts.sort(key=lambda item: item.get("completed_at") or "", reverse=True)
    patches.sort(key=lambda item: item.get("completed_at") or "", reverse=True)
    completed = sum(item["status"] == "completed" for item in attempts)
    failed = sum(item["status"] == "failed" for item in attempts)
    evaluation = latest_reference_evaluation(run_root)
    history = reference_progress_history(run_root)
    scores = (evaluation or {}).get("evaluation", {}).get("evaluations", [])
    gains = [row["delta"] for row in history if row["accepted"]]
    candidate_net = sum(row["delta"] for row in history)
    measured_cost = round(sum(row["cost"]["usd"] or 0 for row in model_rows.values()
                              if row["cost"]["provenance"] == "calculated-from-measured-usage"), 6)
    unpriced_models = sorted(row["model"] for row in model_rows.values() if row["cost"]["usd"] is None)
    accepted_by_time = {}
    for item in history:
        if item["accepted"]:
            accepted_by_time[item["created_at"]] = accepted_by_time.get(item["created_at"], 0) + item["delta"]
    cumulative_cost = cumulative_gain = 0.0
    spend_history = []
    for event in sorted(model_events, key=lambda item: item.get("created_at") or ""):
        cost = event["cost"]["usd"]
        if cost is None:
            continue
        cumulative_cost += cost
        cumulative_gain += accepted_by_time.get(event["created_at"], 0)
        spend_history.append({"created_at": event["created_at"], "model": event["model"],
                              "request_id": event["request_id"], "request_cost_usd": cost,
                              "cumulative_cost_usd": round(cumulative_cost, 6),
                              "cumulative_accepted_gain": round(cumulative_gain, 2),
                              "accepted_gain_per_usd": round(cumulative_gain / cumulative_cost, 4) if cumulative_cost else None})
    compute_minutes = sum((item["duration_ms"] or 0) for item in attempts) / 60000
    return {"window_started_at": cutoff.isoformat(), "patches_last_5m": patches,
        "attempts": {"completed": completed, "failed": failed,
                     "success_rate": completed / (completed + failed) if completed + failed else None},
        "models": sorted(model_rows.values(), key=lambda item: item["model"]),
        "spend": {"currency": "USD", "measured_model_cost_usd": measured_cost,
                  "unpriced_models": unpriced_models, "history": spend_history,
                  "provenance": "calculated-from-measured-usage"},
        "quality": {"blocking_open": sum(item.get("severity") == "blocking" and item.get("disposition") != "resolved" for item in defects),
                    "resolved": sum(item.get("disposition") == "resolved" for item in defects),
                    "cosmetic_backlog": sum(item.get("disposition") == "backlog" for item in defects),
                    "accepted_asset_set": False},
        "reference_convergence": {"provenance": "measured" if evaluation else "unavailable",
                                  "latest_evaluation": evaluation, "history": history,
                                  "minimum_accepted_delta": MINIMUM_ACCEPTED_REFERENCE_DELTA,
                                  "accepted_quality_gain": round(sum(gains), 2) if evaluation else None,
                                  "candidate_net_delta": round(candidate_net, 2) if evaluation else None,
                                  "below_threshold_candidates": sum(row["disposition"] == "below-threshold" for row in history),
                                  "rejected_candidates": sum(not row["accepted"] for row in history)},
        "efficiency": {"accepted_quality_gain_per_usd": round(sum(gains) / measured_cost, 3) if evaluation and measured_cost else None,
                       "quality_gain_per_compute_minute": round(sum(gains) / compute_minutes, 3) if evaluation and compute_minutes else None,
                       "accepted_asset_sets_per_usd": {"provenance": "unavailable", "value": None},
                       "luna_comparison": {"provenance": "unavailable",
                                           "reason": "Codex exposes an account-wide allowance, not per-task Luna token usage; no Luna API receipt exists in this run.",
                                           "resolution": "Invoke Luna through the metered cloud API path and record response usage in the run ledger."}}}

def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None

def completed_developments(run_root: Path, limit: int | None = 4) -> dict[str, list[dict]]:
    """Select the last N hash-verified renders for each logical asset."""
    selected = {asset_id: [] for asset_id in ASSETS}
    for receipt_path in run_root.glob("**/attempt-*/receipt.json"):
        receipt = _read_json(receipt_path)
        if not receipt or receipt.get("status") != "completed":
            continue
        job_type = receipt.get("job_type")
        if receipt.get("format") == "myth-maker.agentic-stitch-receipt/v1":
            job_type = "agentic-stitch"
        asset_id = next((key for key, spec in ASSETS.items() if job_type in spec["job_types"]), None)
        if not asset_id:
            continue
        artifacts = receipt.get("artifacts") or {}
        relative = next((f"renders/{view}.png" for view in ASSETS[asset_id]["views"] if f"renders/{view}.png" in artifacts), None)
        if relative is None and job_type == "agentic-stitch" and "three-quarter.png" in artifacts:
            relative = "three-quarter.png"
        if not relative:
            continue
        render_path = receipt_path.parent / relative if job_type == "agentic-stitch" else receipt_path.parent / "output" / relative
        artifact = artifacts[relative]
        try:
            data = render_path.read_bytes()
        except OSError:
            continue
        if len(data) != artifact.get("bytes") or hashlib.sha256(data).hexdigest() != artifact.get("sha256"):
            continue
        selected[asset_id].append({"work_id": receipt.get("work_id"), "job_type": job_type,
            "attempt": receipt.get("attempt"), "completed_at": receipt.get("completed_at") or (receipt.get("execution") or {}).get("completed_at"),
            "duration_ms": receipt.get("duration_ms") or (receipt.get("execution") or {}).get("duration_ms"), "render": render_path,
            "render_sha256": artifact["sha256"],
            "review_protocol": "agentic-connected-v1" if job_type == "agentic-stitch" else (_read_json(receipt_path.parent / "output" / "scene-manifest.json") or {}).get("review_protocol", "legacy")})
    for asset_id, values in selected.items():
        values.sort(key=lambda item: (item.get("completed_at") or "", item.get("attempt") or 0, item.get("work_id") or ""))
        selected[asset_id] = values[-limit:] if limit is not None else values
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

def completed_component_reviews(run_root: Path) -> list[dict]:
    """Return the latest hash-verified review receipt for each component."""
    latest = {}
    for receipt_path in run_root.glob("component-reviews/*/attempt-*/receipt.json"):
        receipt = _read_json(receipt_path)
        if not receipt or receipt.get("status") != "completed" or not receipt.get("component_id"):
            continue
        artifact = (receipt.get("artifacts") or {}).get("three-quarter.png") or {}
        render = run_root.parent.parent / str(artifact.get("path") or "")
        try: data = render.read_bytes()
        except OSError: continue
        if len(data) != artifact.get("bytes") or hashlib.sha256(data).hexdigest() != artifact.get("sha256"):
            continue
        prior = latest.get(receipt["component_id"])
        if prior is None or (receipt.get("completed_at") or "") > (prior.get("completed_at") or ""):
            latest[receipt["component_id"]] = {**receipt, "render": render}
    return sorted(latest.values(), key=lambda item: item["component_id"])

def current_component_selection(run_root: Path) -> dict[str, dict]:
    """Return inputs selected by the newest section-stitch attempt.

    Selection is intentionally distinct from promotion: a rejected Hunyuan
    proposal may still be selected as source material for bounded rebuilding.
    """
    jobs = []
    for path in run_root.glob("agentic-stitch/*/attempt-*/job.json"):
        job = _read_json(path)
        if not job or not isinstance(job.get("components"), list):
            continue
        jobs.append((path.stat().st_mtime_ns, int(job.get("attempt") or 0), path, job))
    if not jobs:
        return {}
    _mtime, _attempt, _path, latest = max(jobs)
    return {item["component_id"]: {
        "sha256": item["artifact"]["sha256"], "work_id": latest.get("work_id"),
        "attempt": latest.get("attempt"),
    } for item in latest["components"] if isinstance(item, dict) and item.get("component_id")
        and isinstance(item.get("artifact"), dict) and item["artifact"].get("sha256")}

def build_dashboard(run_root: Path) -> dict:
    """Refresh GIFs and a self-contained HTML dashboard from completed attempts."""
    output = run_root / "observability"
    output.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc)
    all_developments = completed_developments(run_root, limit=None)
    developments = {asset_id: values[-4:] for asset_id, values in all_developments.items()}
    telemetry = production_observability(run_root, generated_at)
    chart = _progress_svg(telemetry["reference_convergence"]["history"], output / "reference-convergence.svg")
    spend_chart = _spend_svg(telemetry["spend"]["history"], output / "spend-efficiency.svg")
    assets, cards = {}, []
    for asset_id, values in developments.items():
        gif = _gif(values, output / f"{asset_id}-last-four.gif")
        verified_reference = _verified_reference(all_developments[asset_id], asset_id) if values else None
        reference, measurements = None, None
        if verified_reference:
            data = verified_reference["path"].read_bytes()
            from PIL import Image, ImageOps
            with Image.open(io.BytesIO(data)) as source:
                preview = ImageOps.contain(source.convert("RGB"), (1280, 1280))
            reference_path = output / f"{asset_id}-frozen-reference-preview.jpg"
            preview.save(reference_path, format="JPEG", quality=82, optimize=True)
            preview_data = reference_path.read_bytes()
            reference = {"path": reference_path.name, "bytes": len(preview_data),
                         "sha256": verified_reference["sha256"],
                         "preview_sha256": hashlib.sha256(preview_data).hexdigest()}
            if len(values) >= 2:
                measurements = image_space_comparison(verified_reference["path"], values[-2]["render"], values[-1]["render"])
        assets[asset_id] = {"gif": gif, "reference": reference,
                            "image_space_measurements": measurements,
                            "developments": [{k: v for k, v in item.items() if k != "render"} for item in values]}
        rows = "".join(f"<li><b>{html.escape(str(item['job_type']))}</b> attempt {item['attempt']} · {html.escape(str(item.get('completed_at') or 'time unavailable'))}</li>" for item in values)
        reference_visual = (f'<h3>Frozen reference</h3><img src="{reference["path"]}?sha={reference["preview_sha256"]}" '
                            f'alt="{asset_id} frozen reference">' if reference else "<p>Frozen reference unavailable.</p>")
        visual = f'<h3>Last four developments</h3><img src="{gif["path"]}?sha={gif["sha256"]}" alt="{asset_id} last four completed developments">' if gif else "<p>No completed render revisions yet.</p>"
        cards.append(f'<section><h2>{html.escape(asset_id.title())}</h2>{reference_visual}{visual}<ol>{rows}</ol></section>')
    component_reviews = completed_component_reviews(run_root)
    selected_components = current_component_selection(run_root)
    component_cards = []
    for item in component_reviews:
        destination = output / f'component-{item["component_id"]}.png'
        destination.write_bytes(item["render"].read_bytes())
        review = item["review"]; scores = review["scores"]
        selected = selected_components.get(item["component_id"])
        if selected and selected["sha256"] == item.get("candidate_sha256"):
            lifecycle, lifecycle_class = "ACTIVE STITCH INPUT", "active"
            lifecycle_reason = f'Selected by {selected["work_id"]} attempt {selected["attempt"]}; selection does not mean accepted.'
        elif review["decision"] == "regenerate":
            lifecycle, lifecycle_class = "REJECTED", "bad"
            lifecycle_reason = "Not eligible for stitching without reconstruction or regeneration."
        elif review["decision"] == "ready-to-stitch":
            lifecycle, lifecycle_class = "STITCH-READY CANDIDATE", "good"
            lifecycle_reason = "Eligible for section assembly; becomes canonical only after an accepted section or asset promotion."
        else:
            lifecycle, lifecycle_class = "CLEANUP CANDIDATE", "candidate"
            lifecycle_reason = "Useful shape requiring bounded cleanup before stitching."
        score_rows = "".join(f"<li>{html.escape(key.replace('_',' '))}: {value:.0f}</li>" for key,value in scores.items())
        defect_rows = "".join(f"<li>{html.escape(value)}</li>" for value in review["blocking_defects"][:3])
        component_cards.append(f'<section class="component-card" data-lifecycle="{lifecycle_class}"><h3>{html.escape(item["component_id"])}</h3><p class="badge {lifecycle_class}">{lifecycle}</p><p class="muted">{html.escape(lifecycle_reason)}</p><p class="hash">Candidate {html.escape(str(item.get("candidate_sha256") or "hash unavailable")[:12])}</p><img src="{destination.name}?sha={item["artifacts"]["three-quarter.png"]["sha256"]}" alt="{html.escape(item["component_id"])} diagnostic render"><p><b>Astra routing:</b> {html.escape(review["decision"])}</p><ul>{score_rows}</ul><b>Top blockers</b><ul>{defect_rows}</ul></section>')
    generated = generated_at.isoformat()
    patches = telemetry["patches_last_5m"]
    patch_rows = "".join(f"<tr><td>{html.escape(str(item['job_type']))}</td><td>{html.escape(str(item['status']))}</td><td>{item['attempt']}</td><td>{len(item['output_hashes'])}</td><td>{html.escape(str(item.get('completed_at') or 'unavailable'))}</td></tr>" for item in patches)
    if not patch_rows: patch_rows = '<tr><td colspan="5">No completed or failed asset patch in this five-minute window.</td></tr>'
    def usd(value):
        return "$%.4f" % value if value is not None else "unavailable"
    model_rows = "".join(
        f"<tr><td>{html.escape(row['model'])}</td><td>{html.escape(row['cost']['provenance'])}</td>"
        f"<td>{row['requests'] if row['requests'] is not None else 'unavailable'}</td>"
        f"<td>{usd((row['cost']['breakdown_usd'] or {}).get('uncached_input'))}</td>"
        f"<td>{usd((row['cost']['breakdown_usd'] or {}).get('cached_input'))}</td>"
        f"<td>{usd((row['cost']['breakdown_usd'] or {}).get('output'))}</td>"
        f"<td>{usd(row['cost']['usd'])}</td></tr>" for row in telemetry["models"])
    quality = telemetry["quality"]; attempts = telemetry["attempts"]; efficiency = telemetry["efficiency"]
    chart_html = f'<section><h2>Artwork convergence</h2><img src="{chart["path"]}?sha={chart["sha256"]}" alt="reference convergence graph"><p class="muted">Weighted rubric: silhouette 30%, proportions 25%, component geometry 20%, material identity 10%, detail readability 10%, fit 5%.</p></section>' if chart else '<section><h2>Artwork convergence</h2><p>Awaiting the first reference evaluation.</p></section>'
    spend_chart_html = f'<section><h2>Dollar spend and efficiency</h2><img src="{spend_chart["path"]}?sha={spend_chart["sha256"]}" alt="dollar spend and accepted quality gain graph"></section>' if spend_chart else '<section><h2>Dollar spend and efficiency</h2><p>Awaiting measured, priced model usage.</p></section>'
    spend = telemetry["spend"]
    page = """<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="300"><meta name="viewport" content="width=device-width"><title>Asset production progress</title><style>body{margin:0;background:#07111f;color:#e5eefb;font:15px system-ui;padding:24px}main{max-width:1200px;margin:auto}.grid,.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}section,.metric{background:#111c2d;padding:16px;border-radius:12px;margin:18px 0}img{width:100%;border-radius:8px;background:#030712}small,.muted{color:#9fb1c8}li{margin:.4em 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #26364d}.bad{color:#fda4af}.good{color:#86efac}.active{color:#7dd3fc}.candidate{color:#fde68a}.badge{font-weight:800;letter-spacing:.04em}.hash{font:12px ui-monospace;color:#a5b4fc}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 18px}.filters button{border:1px solid #385070;background:#16263d;color:#dbeafe;padding:9px 13px;border-radius:999px;cursor:pointer}.filters button[aria-selected=true]{background:#2563eb;border-color:#60a5fa;color:white}.component-card[hidden]{display:none}</style></head><body><main><h1>Cloud asset production progress</h1><small>Run """ + html.escape(run_root.name) + " · generated " + html.escape(generated) + " · refreshes every 5 minutes</small><div class=\"metrics\"><div class=\"metric\"><b>Measured API spend</b><br>$" + f'{spend["measured_model_cost_usd"]:.4f}' + "</div><div class=\"metric\"><b>Accepted gain / $</b><br>" + str(efficiency["accepted_quality_gain_per_usd"] if efficiency["accepted_quality_gain_per_usd"] is not None else "unavailable") + "</div><div class=\"metric\"><b>Attempts</b><br>" + str(attempts["completed"]) + " completed / " + str(attempts["failed"]) + " failed</div><div class=\"metric\"><b>Open blockers</b><br><span class=\"bad\">" + str(quality["blocking_open"]) + "</span></div><div class=\"metric\"><b>Quality gain / compute minute</b><br>" + str(efficiency["quality_gain_per_compute_minute"] if efficiency["quality_gain_per_compute_minute"] is not None else "unavailable") + "</div></div>" + spend_chart_html + chart_html + "<section><h2>How to read component status</h2><p><b>Canonical</b> is reserved for a hash promoted by an accepted section or final asset receipt. The review grid below contains candidates, so an Astra routing decision by itself never means canonical.</p><ul><li><span class=\"active\"><b>ACTIVE STITCH INPUT</b></span>: selected for the newest section job; it may be rebuilt during stitching.</li><li><span class=\"good\"><b>STITCH-READY CANDIDATE</b></span>: passed component review but awaits section acceptance.</li><li><span class=\"candidate\"><b>CLEANUP CANDIDATE</b></span>: useful shape that still needs repair.</li><li><span class=\"bad\"><b>REJECTED</b></span>: cannot enter assembly unchanged.</li></ul></section><section><h2>Asset patches in the last 5 minutes</h2><table><thead><tr><th>Lane</th><th>Status</th><th>Attempt</th><th>Output hashes</th><th>Completed</th></tr></thead><tbody>" + patch_rows + "</tbody></table></section><section><h2>Measured model spend</h2><table><thead><tr><th>Model</th><th>Provenance</th><th>Requests</th><th>Uncached input USD</th><th>Cached input USD</th><th>Output USD</th><th>Total USD</th></tr></thead><tbody>" + model_rows + "</tbody></table><p class=\"muted\">Each dollar amount is calculated from recorded usage and that model's published rates at the time of the call. Raw usage counts remain in the machine-readable manifest for auditability. Blender scripts use compute time and zero model calls. Models with unavailable task usage remain unpriced rather than counted as free.</p></section><h2>Component candidate quality gate</h2><nav class=\"filters\" aria-label=\"Component lifecycle filter\"><button type=\"button\" data-filter=\"active\" aria-selected=\"true\">Active</button><button type=\"button\" data-filter=\"good\" aria-selected=\"false\">Stitch-ready</button><button type=\"button\" data-filter=\"candidate\" aria-selected=\"false\">Cleanup</button><button type=\"button\" data-filter=\"bad\" aria-selected=\"false\">Rejected</button><button type=\"button\" data-filter=\"all\" aria-selected=\"false\">All</button></nav><p id=\"empty-filter\" class=\"muted\" hidden>No components currently have this status.</p><div id=\"component-grid\" class=\"grid\">" + "".join(component_cards) + "</div><h2>Last four completed developments</h2><div class=\"grid\">" + "".join(cards) + "</div></main><script>(()=>{const buttons=[...document.querySelectorAll('[data-filter]')],cards=[...document.querySelectorAll('.component-card')],empty=document.getElementById('empty-filter');function apply(value){let shown=0;for(const card of cards){const visible=value==='all'||card.dataset.lifecycle===value;card.hidden=!visible;if(visible)shown++}empty.hidden=shown>0;for(const button of buttons)button.setAttribute('aria-selected',String(button.dataset.filter===value));location.hash='components-'+value}for(const button of buttons)button.addEventListener('click',()=>apply(button.dataset.filter));const requested=location.hash.replace('#components-','');apply(['active','good','candidate','bad','all'].includes(requested)?requested:'active')})()</script></body></html>"
    (output / "index.html").write_text(page, encoding="utf-8")
    manifest = {"format": "myth-maker.asset-progress-dashboard/v2", "run_id": run_root.name, "generated_at": generated, "refresh_seconds": 300, "telemetry": telemetry, "assets": assets,
                "component_selection": selected_components,
                "component_reviews": [{k:v for k,v in item.items() if k != "render"} for item in component_reviews]}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest

def dashboard_bundle(run_root: Path) -> dict:
    manifest = build_dashboard(run_root)
    files = {path.name: base64.b64encode(path.read_bytes()).decode("ascii") for path in sorted((run_root / "observability").iterdir()) if path.is_file()}
    # Include the latest structural evidence so a broken crop or missing lane is
    # diagnosable from the same private dashboard download.
    latest = {}
    for receipt_path in run_root.glob("*/attempt-*/receipt.json"):
        try:
            receipt = _read_json(receipt_path)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(receipt, dict) or receipt.get("status") != "completed":
            continue
        key = str(receipt.get("job_type"))
        if key not in {"kit-assembly", "railgun"}:
            continue
        prior = latest.get(key)
        if prior is None or int(receipt.get("attempt", 0)) > prior[0]:
            latest[key] = (int(receipt.get("attempt", 0)), receipt_path.parent)
    for job_type, (attempt, attempt_root) in latest.items():
        for artifact_name in ("scene-manifest.json", "fit-report.json"):
            path = attempt_root / "output" / artifact_name
            if path.is_file():
                name = f"latest-{job_type}-attempt-{attempt:04d}-{artifact_name}"
                files[name] = base64.b64encode(path.read_bytes()).decode("ascii")
    return {"manifest": manifest, "files_base64": files}
