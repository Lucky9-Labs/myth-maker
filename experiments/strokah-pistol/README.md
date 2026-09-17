# Strokah ambidextrous pistol review

Run commands from the repository root:

```sh
npm ci --prefix experiments/strokah-pistol
npm run bootstrap --prefix experiments/strokah-pistol
node experiments/strokah-pistol/serve.mjs
node --test experiments/strokah-pistol/pistol-rig.test.mjs
node experiments/strokah-pistol/collision-check.mjs
```

Open http://127.0.0.1:4179/experiments/strokah-pistol/preview.html. Choose hand, action and camera. The preview uses the supplied Tripo FBX-derived geometry and original Strokah GLB. Source identity and hashes are in output/pistol/provenance.json; review media and the six-clip GLB are in output/pistol/review.

`pistol-rig.mjs` owns weapon-local grip anchors and ready/aim/fire/reload poses. Intact left-hand actions reflect the solved right-hand pose. Disabled arms are excluded, bracing suppresses firing, and support overrides can take ownership for ground contact. The support hand reaches the magazine only during reload. The original neutral wrist and local elbow hinge constrain the active arm.

`single-hand-carry.mjs` ports the established StrokahMeleeMotion and StrokahMeleeDynamics single-handed carry values, lag and spring. The existing locomotion clip drives the lower body. Unity source was read without modification. The saved right-hand-approved checkpoint is a source snapshot, not a standalone preview.

`capture.playwright.js`, `build-review.py`, and `export-review.mjs` produce the review evidence. This package has not been integrated into Unity or merged. The crawl adapter demonstrates flat-ground support using the existing structural controller; it is not a complete handed damage-runtime port.

Update: left-hand ready now rests beside the hip using the single-handed idle carry pose. Aim and fire still mirror the right-hand actions; reload blends from the side rest into magazine service and back. Right-hand poses are unchanged.

Dual mode: combines independent left/right grips, side rests, shared locomotion and alternating recoil. Aim retains parallel barrels and uses 0.15-radian wrist yaw with 0.8-radian forearm roll to open the elbows outside the shoulder line. This is a pose preview, without target convergence. Dual reload and crawl are disabled pending a dedicated occupied-hand choreography. The six-clip GLB remains the single-handed export.

Shared-pose update: both single-hand modes now use the accepted open-elbow aim and side-rest pose. Left mirrors right. Dual invokes the same update without pose overrides, preserves both active arm results, and offsets left recoil by 0.36 seconds. Historical approved-right snapshots remain unchanged for reference; current exports use the newly requested shared pose.

Assets are registry-backed by art-library/releases/strokah-shared-pistol-v1.json. Bootstrap restores the immutable version and verifies each member hash, refusing to overwrite changed local assets. Requires boto3 and access to the existing art-library bucket. This authoring package does not itself change the Unity core-asset bootstrap contract.
