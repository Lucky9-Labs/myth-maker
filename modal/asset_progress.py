"""Derived, immutable progress views for cloud asset-production runs."""
from __future__ import annotations

import base64
import hashlib
import html
import json
from datetime import datetime, timezone
from pathlib import Path

ASSETS = {
    "mech": {"job_types": {"mech-structure", "mech-armor"}, "views": ("full-body", "front", "gameplay-distance")},
    "railgun": {"job_types": {"railgun"}, "views": ("side", "gameplay-distance", "full-body")},
    "assembly": {"job_types": {"kit-assembly", "final-validation"}, "views": ("full-body", "gameplay-distance", "grip")},
}

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
    developments = completed_developments(run_root)
    assets, cards = {}, []
    for asset_id, values in developments.items():
        gif = _gif(values, output / f"{asset_id}-last-four.gif")
        assets[asset_id] = {"gif": gif, "developments": [{k: v for k, v in item.items() if k != "render"} for item in values]}
        rows = "".join(f"<li><b>{html.escape(str(item['job_type']))}</b> attempt {item['attempt']} · {html.escape(str(item.get('completed_at') or 'time unavailable'))}</li>" for item in values)
        visual = f'<img src="{gif["path"]}?sha={gif["sha256"]}" alt="{asset_id} last four completed developments">' if gif else "<p>No completed render revisions yet.</p>"
        cards.append(f'<section><h2>{html.escape(asset_id.title())}</h2>{visual}<ol>{rows}</ol></section>')
    generated = datetime.now(timezone.utc).isoformat()
    page = """<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="300"><meta name="viewport" content="width=device-width"><title>Asset production progress</title><style>body{margin:0;background:#07111f;color:#e5eefb;font:15px system-ui;padding:24px}main{max-width:1100px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px}section{background:#111c2d;padding:16px;border-radius:12px}img{width:100%;border-radius:8px;background:#030712}small{color:#9fb1c8}li{margin:.4em 0}</style></head><body><main><h1>Cloud asset production progress</h1><small>Run """ + html.escape(run_root.name) + " · generated " + html.escape(generated) + " · refreshes every 5 minutes</small><div class=\"grid\">" + "".join(cards) + "</div></main></body></html>"
    (output / "index.html").write_text(page, encoding="utf-8")
    manifest = {"format": "myth-maker.asset-progress-dashboard/v1", "run_id": run_root.name, "generated_at": generated, "refresh_seconds": 300, "assets": assets}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return manifest

def dashboard_bundle(run_root: Path) -> dict:
    manifest = build_dashboard(run_root)
    files = {path.name: base64.b64encode(path.read_bytes()).decode("ascii") for path in sorted((run_root / "observability").iterdir()) if path.is_file()}
    return {"manifest": manifest, "files_base64": files}
