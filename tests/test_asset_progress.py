import hashlib, json, sys, tempfile, unittest
from pathlib import Path
from PIL import Image
ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from asset_progress import build_dashboard, completed_developments

class AssetProgressTests(unittest.TestCase):
    def _attempt(self, root, work, attempt, job_type, status="completed"):
        path = root / work / f"attempt-{attempt:04d}"
        render = path / "output" / "renders" / ("side.png" if job_type == "railgun" else "full-body.png")
        render.parent.mkdir(parents=True); Image.new("RGB", (32, 24), (attempt * 20, 30, 40)).save(render)
        data = render.read_bytes(); relative = f"renders/{render.name}"
        receipt = {"status": status, "work_id": work, "attempt": attempt, "job_type": job_type,
            "execution": {"completed_at": f"2026-09-09T00:0{attempt}:00+00:00", "duration_ms": attempt * 10},
            "artifacts": {relative: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}}}
        (path / "receipt.json").write_text(json.dumps(receipt))

    def test_selects_only_latest_four_completed_verified_revisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 6): self._attempt(root, "mech", attempt, "mech-structure")
            self._attempt(root, "railgun", 1, "railgun", "failed")
            values = completed_developments(root)
            self.assertEqual([item["attempt"] for item in values["mech"]], [2, 3, 4, 5])
            self.assertEqual(values["railgun"], [])

    def test_builds_animated_gif_manifest_and_five_minute_dashboard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 5): self._attempt(root, "gun", attempt, "railgun")
            manifest = build_dashboard(root); gif = root / "observability" / "railgun-last-four.gif"
            self.assertEqual(manifest["assets"]["railgun"]["gif"]["frames"], 4)
            with Image.open(gif) as image: self.assertEqual(image.n_frames, 4)
            self.assertIn('content="300"', (root / "observability" / "index.html").read_text())
if __name__ == "__main__": unittest.main()
