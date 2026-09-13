from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from resolve_github_animation_artifact import latest_attempt


class ResolveGitHubAnimationArtifactTests(unittest.TestCase):
    def test_selects_the_highest_available_attempt_without_assuming_current_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "reef-skitter-rig-42-1").mkdir()
            (root / "reef-skitter-rig-42-3").mkdir()
            (root / "unrelated").mkdir()

            result = latest_attempt(root, "reef-skitter-rig-42")

            self.assertEqual(result["attempt"], 3)
            self.assertEqual(result["path"].name, "reef-skitter-rig-42-3")

    def test_fails_closed_when_no_matching_artifact_was_downloaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(FileNotFoundError, "artifact attempt"):
                latest_attempt(Path(temporary), "reef-skitter-rig-42")


if __name__ == "__main__":
    unittest.main()
