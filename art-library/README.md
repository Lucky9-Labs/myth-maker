# Authoring asset releases

Cockpit authoring assets use the existing private Strokah art library bucket,
`mech-art-library-20260905225047699700000001`, established by the mech game
repository's `art-library/releases/strokah-motion-rig-v1.json`.
This repository owns the distinct `strokah-cockpit-mechanical` asset ID.
The inventory schema and create-only publisher are reused from that repository.
New revisions require new `vN` object keys; never overwrite a published object.

Run `python3 art-library/scripts/inventory.py validate` to validate metadata.
With boto3 installed and bucket read credentials, restore exact source, preview,
and proof bytes using `python3 art-library/scripts/restore_cockpit.py`.
The restorer pins the S3 VersionId and verifies the archive and every member's
SHA-256 before writing. It refuses to overwrite modified local files.

These are authoring/review assets, not a new Unity runtime dependency.
No game bootstrap or core runtime asset contract is changed.
