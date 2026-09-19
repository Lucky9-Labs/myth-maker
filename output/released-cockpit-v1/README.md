# Released Strokah cockpit filling — locally verified runtime candidate

This work replaces only the removable Strokah canopy object, `tripo_part_61.001`. It does not add an overlay to the existing glass and does not replace the torso, jaw cradle, shoulders, or any other part of the mech.

The Released identity is an open cranial void: the upper head is absent, the attachment rim is thin, and the visible machine anatomy recedes into a deep concave socket behind it. Orange braided conduits cling to the inner walls around a small, pupil-less seven-aperture core. The existing lower cockpit cradle supplies the jaw language. The part must never resolve into a convex dome, helmet, face, or second canopy silhouette.

## Authored multiview input

The v3 concept is a single Tripo multiview set with consistent Front, Left, Right, and Back views:

- `working/tripo-input/released-canopy-concave-front-v3.png`
- `working/tripo-input/released-canopy-concave-left-v3.png`
- `working/tripo-input/released-canopy-concave-right-v3.png`
- `working/tripo-input/released-canopy-concave-back-v3.png`
- `working/tripo-input/released-canopy-concave-multiview-v3.png`

The images are local review artifacts and are intentionally ignored by Git. Their hashes and the generation record are preserved in `design-contract.json`.

## Tripo texture and segmentation pass

The four directional views were submitted through Tripo's **Multiview** mode, not batch image generation. The resulting candidate is preserved at:

https://studio.tripo3d.ai/workspace/generate/ca172c62-35b7-4740-a2fa-5147a00baae6

Tripo textured the candidate at 4K from the same four directional source images, then segmented the textured result in Balanced mode. The final local export is hash-pinned as `working/released_strokah_concave_canopy_segmented_textured_v5.glb`; it contains 72 parts, 3,974 vertices, and 2,327 triangles. The central core is `tripo_part_11` (60 vertices / 26 triangles) and remains a separate, recentered animation pivot. The texture pass spent 20 credits and segmentation spent 40 credits.

## Unity runtime implementation

Hullscape commit `86d7e19b864a13b6655cf64a90e1f5efdfbbcab1` imports the hash-pinned segmented GLB, preserves Tripo's double-sided cavity materials, converts all 72 parts to `MechGame/InkLit`, registers the screen-outline layer, and mounts the result through the existing canopy slot. It hides only the source canopy panels; the proof snapshots confirm zero changes to the rest of the chassis' visibility, materials, or rendering layers.

The standalone ShowMe sweep rendered 54 frames, visually retained the open concave cavity from front through side profile, and animated `tripo_part_11` through 10.80 degrees. The final proof is `SHOWME_VERIFIED`; its commit-addressed GIF was read back from the private proof bucket with SHA-256 `4213e30d381f50b199b21bed608e2e02739fa7f81d19b69969a0c8bf6462552b`.

This is not yet a shippable clean-checkout asset. Both GLBs and the generated Unity prefab remain intentionally ignored/local. Publishing them into the private art inventory and Unity asset contract requires explicit asset-upload authorization; final retopology, LOD, and collision policy also remain production gates.

## Source-shape reference

The exact source canopy can be isolated from the pinned Strokah blend with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python scripts/released_cockpit/render_source_canopy.py
```

That produces four local reference renders under `working/source-canopy/`. The current runtime implementation fits the segmented export through the production canopy slot and has literal front-to-side Unity swap proof. Durable promotion still requires private asset publication plus final retopology, LOD, and collision policy.
