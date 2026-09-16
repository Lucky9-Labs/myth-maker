import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
class CockpitReleaseContractTests(unittest.TestCase):
    def test_selected_release_matches_inventory_and_preview_inputs(self):
        release = json.loads((ROOT/'art-library/releases/strokah-cockpit-mechanical-v1.json').read_text())
        inventory = json.loads((ROOT/'art-library/inventory.json').read_text())
        asset = next(a for a in inventory['assets'] if a['id'] == release['asset_id'])
        self.assertEqual(asset['revisions'][0], release['artifact'])
        self.assertEqual(release['artifact']['state'], 'uploaded')
        self.assertTrue(release['artifact']['s3_version_id'])
        manifest = json.loads((ROOT/'output/cockpit-mechanical/manifest.json').read_text())
        for name in ['source_native','accepted_export','glass_preview','candidate_native','proof']:
            self.assertEqual(manifest[name]['sha256'],release['files'][manifest[name]['path']])
        self.assertEqual(manifest['motion_config']['sha256'],hashlib.sha256((ROOT/'output/cockpit-mechanical/mechanism.json').read_bytes()).hexdigest())
