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

Tripo textured the candidate at 4K from the same four directional source images, then segmented the textured result in Balanced mode. Unity uses the hash-pinned `working/released_strokah_concave_canopy_textured_v4.glb` as the render source: 2,100 vertices, 2,329 triangles, and one embedded 4096×4096 texture. The 72-part `working/released_strokah_concave_canopy_segmented_textured_v5.glb` is retained only as an eye-selection guide. Its `tripo_part_11` bounds select a 34-vertex / 29-triangle region from the coherent 4K mesh, which becomes the separate recentered animation pivot. The texture pass spent 20 credits and segmentation spent 40 credits.

## Unity runtime implementation

Hullscape commit `1ac9802557d90aabb8e138dae323cbf55baf371c` imports the hash-pinned coherent 4K GLB, uses the segmented export to extract only the eye, converts glTF's V coordinate into Unity texture space, and creates two double-sided `MechGame/InkLit` renderers sharing the same source texture. Both renderers use the screen-outline layer and mount through the existing canopy slot. It hides only the source canopy panels; the proof snapshots confirm zero changes to the rest of the chassis' visibility, materials, or rendering layers.

The standalone ShowMe sweep rendered 54 frames and visibly resolved the dark cavity structure, metal clamps, black hoses, orange braided conduits, and seven-light eye from front through side profile. The extracted eye animated through 10.80 degrees. The final proof is `SHOWME_VERIFIED`; its commit-addressed GIF was read back from the private proof bucket with SHA-256 `0761fce894fd85436d9d94d0f457b017fd109f08b9e003f45fa82a0421b7d649`.

This is not yet a shippable clean-checkout asset. Both GLBs and the generated Unity prefab remain intentionally ignored/local. Publishing them into the private art inventory and Unity asset contract requires explicit asset-upload authorization; final retopology, LOD, and collision policy also remain production gates.

## Source-shape reference

The exact source canopy can be isolated from the pinned Strokah blend with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python scripts/released_cockpit/render_source_canopy.py
```

That produces four local reference renders under `working/source-canopy/`. The current runtime implementation fits the coherent 4K export through the production canopy slot, uses the segmented export only to locate the animatable eye, and has literal front-to-side Unity swap proof. Durable promotion still requires private asset publication plus final retopology, LOD, and collision policy.
