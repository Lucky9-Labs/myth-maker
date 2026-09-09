"""Derived, immutable progress views for cloud asset-production runs."""
from __future__ import annotations

import base64
import hashlib
import html
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ASSETS = {
    "mech": {"job_types": {"mech-structure", "mech-armor"}, "views": ("full-body", "front", "gameplay-distance")},
    "railgun": {"job_types": {"railgun"}, "views": ("side", "gameplay-distance", "full-body")},
    "assembly": {"job_types": {"kit-assembly", "final-validation"}, "views": ("full-body", "gameplay-distance", "grip")},
}

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
    # Codex task-level usage is not present in production receipts. Keep the
    # desired comparison visible without turning unavailable telemetry into 0.
    model_rows.setdefault("gpt-5.6-luna", {"model": "gpt-5.6-luna", "requests": None,
        "input_tokens": None, "cached_input_tokens": None, "output_tokens": None,
        "total_tokens": None, "duration_ms": None, "provenance": "unavailable"})
    attempts.sort(key=lambda item: item.get("completed_at") or "", reverse=True)
    patches.sort(key=lambda item: item.get("completed_at") or "", reverse=True)
    completed = sum(item["status"] == "completed" for item in attempts)
    failed = sum(item["status"] == "failed" for item in attempts)
    return {"window_started_at": cutoff.isoformat(), "patches_last_5m": patches,
        "attempts": {"completed": completed, "failed": failed,
                     "success_rate": completed / (completed + failed) if completed + failed else None},
        "models": sorted(model_rows.values(), key=lambda item: item["model"]),
        "quality": {"blocking_open": sum(item.get("severity") == "blocking" and item.get("disposition") != "resolved" for item in defects),
                    "resolved": sum(item.get("disposition") == "resolved" for item in defects),
                    "cosmetic_backlog": sum(item.get("disposition") == "backlog" for item in defects),
                    "accepted_asset_set": False},
        "efficiency": {"tokens_per_accepted_asset_set": {"provenance": "unavailable", "value": None},
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
    quality = telemetry["quality"]; attempts = telemetry["attempts"]
    page = """<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="300"><meta name="viewport" content="width=device-width"><title>Asset production progress</title><style>body{margin:0;background:#07111f;color:#e5eefb;font:15px system-ui;padding:24px}main{max-width:1200px;margin:auto}.grid,.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}section,.metric{background:#111c2d;padding:16px;border-radius:12px;margin:18px 0}img{width:100%;border-radius:8px;background:#030712}small,.muted{color:#9fb1c8}li{margin:.4em 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #26364d}.bad{color:#fda4af}.good{color:#86efac}</style></head><body><main><h1>Cloud asset production progress</h1><small>Run """ + html.escape(run_root.name) + " · generated " + html.escape(generated) + " · refreshes every 5 minutes</small><div class=\"metrics\"><div class=\"metric\"><b>Attempts</b><br>" + str(attempts["completed"]) + " completed / " + str(attempts["failed"]) + " failed</div><div class=\"metric\"><b>Open blockers</b><br><span class=\"bad\">" + str(quality["blocking_open"]) + "</span></div><div class=\"metric\"><b>Resolved defects</b><br><span class=\"good\">" + str(quality["resolved"]) + "</span></div><div class=\"metric\"><b>Accepted set efficiency</b><br>unavailable until acceptance</div></div><section><h2>Asset patches in the last 5 minutes</h2><table><thead><tr><th>Lane</th><th>Status</th><th>Attempt</th><th>Output hashes</th><th>Completed</th></tr></thead><tbody>" + patch_rows + "</tbody></table></section><section><h2>Measured model spend</h2><table><thead><tr><th>Model</th><th>Provenance</th><th>Requests</th><th>Input</th><th>Cached</th><th>Output</th><th>Total billable tokens*</th></tr></thead><tbody>" + model_rows + "</tbody></table><p class=\"muted\">* Total shown as input plus output tokens. Cached tokens are included in input and shown separately. Blender script operations use compute time and zero model calls. Luna remains unavailable until Codex exports task usage into this run ledger.</p></section><h2>Last four completed developments</h2><div class=\"grid\">" + "".join(cards) + "</div></main></body></html>"
    (output / "index.html").write_text(page, encoding="utf-8")
    manifest = {"format": "myth-maker.asset-progress-dashboard/v2", "run_id": run_root.name, "generated_at": generated, "refresh_seconds": 300, "telemetry": telemetry, "assets": assets}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest

def dashboard_bundle(run_root: Path) -> dict:
    manifest = build_dashboard(run_root)
    files = {path.name: base64.b64encode(path.read_bytes()).decode("ascii") for path in sorted((run_root / "observability").iterdir()) if path.is_file()}
    return {"manifest": manifest, "files_base64": files}
