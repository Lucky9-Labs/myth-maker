import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "resolve_github_animation_work_id.py"


class ResolveGithubAnimationWorkIdTests(unittest.TestCase):
    def test_returns_ready_work_id_matching_the_required_prefix(self):
        with tempfile.TemporaryDirectory() as temporary:
            receipt = Path(temporary) / "receipt.json"
            receipt.write_text(
                json.dumps(
                    {
                        "work_order": {"work_id": "reef-rig-42"},
                        "worker_state": {
                            "status": "ready_for_review",
                            "part": "reef-rig-42",
                        },
                    }
                ),
                encoding="utf-8",
            )

            result = subprocess.run(
                ["python3", str(SCRIPT), str(receipt), "--prefix", "reef-rig-"],
                check=True,
                capture_output=True,
                text=True,
            )

        self.assertEqual(result.stdout.strip(), "reef-rig-42")

    def test_rejects_partial_mismatched_or_path_like_work_ids(self):
        cases = (
            ("checkpointed_partial", "reef-rig-42", "reef-rig-42"),
            ("ready_for_review", "reef-rig-42", "reef-rig-41"),
            ("ready_for_review", "reef-rig-../../escape", "reef-rig-../../escape"),
        )
        for status, work_id, part in cases:
            with self.subTest(status=status, work_id=work_id, part=part):
                with tempfile.TemporaryDirectory() as temporary:
                    receipt = Path(temporary) / "receipt.json"
                    receipt.write_text(
                        json.dumps(
                            {
                                "work_order": {"work_id": work_id},
                                "worker_state": {"status": status, "part": part},
                            }
                        ),
                        encoding="utf-8",
                    )
                    result = subprocess.run(
                        ["python3", str(SCRIPT), str(receipt), "--prefix", "reef-rig-"],
                        capture_output=True,
                        text=True,
                    )

                self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
