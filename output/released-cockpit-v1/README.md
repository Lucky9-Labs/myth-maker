# Samsara / Released Strokah concave canopy — runtime released

This work replaces only the removable Strokah canopy object, `tripo_part_61.001`. It does not add an overlay to the existing glass and does not replace the torso, jaw cradle, shoulders, or any other part of the mech.

The faction is now named **Samsara**; “Released” remains the legacy canopy/candidate label. Samsara enemies use `ReleasedStrokah` by default. **Abyssal** names the purple cephalopod faction and keeps its existing canopy. **Entropic** names the melding faction and temporarily uses `Standard` until its dedicated canopy is released.

The Samsara identity is an open cranial void: the upper head is absent, the attachment rim is thin, and the visible machine anatomy recedes into a deep concave socket behind it. Orange braided conduits cling to the inner walls around a small, pupil-less seven-aperture core. The existing lower cockpit cradle supplies the jaw language. The part must never resolve into a convex dome, helmet, face, or second canopy silhouette.

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

Runtime PR [mech-game#200](https://github.com/luckybucky9/mech-game/pull/200), merged as `5a35370289ddcd6c6f995875c68716e069a4cdd8`, imports the hash-pinned coherent 4K GLB, uses the segmented export to extract only the eye, converts glTF's V coordinate into Unity texture space, and creates two double-sided `MechGame/InkLit` renderers sharing the same source texture. Both renderers use the screen-outline layer and mount through the existing canopy slot. It hides only the source canopy panels; the proof snapshots confirm zero changes to the rest of the chassis' visibility, materials, or rendering layers. An `EnemyMechRaceTag` now resolves Samsara enemies to this canopy automatically.

The seven-aperture eye is now the dominant emitter: its eye-only material reaches a 9.0 HDR peak with an 18-pixel, 0.42-intensity texture-space emission spread, while the shell remains at 0.0 emission. A separate eye-bound, camera-facing additive halo supplies the soft optical lens response during normal gameplay, and high-quality bloom reinforces it in the proof scene without turning the detailed orange conduits into a uniform glow.

The exact-head standalone ShowMe sweep rendered 54 frames and visibly resolved the Samsara race-default label, dark cavity structure, metal clamps, black hoses, orange braided conduits, and bright seven-light eye from front through side profile. The extracted eye and its attached halo animated through 10.80 degrees without a detached quad artifact. The final proof is `SHOWME_VERIFIED`; its commit-addressed GIF was read back from the private proof bucket with SHA-256 `dcb03f08e150bd2cf8295b6be6813c2db969ddbcc516051ef40c9502eb01d665`.

The complete runtime closure is published as private art-inventory asset `samsara-released-strokah-canopy` revision 1 at `models/enemies/samsara-released-strokah-canopy/v1/samsara-released-strokah-canopy-v1.zip`, SHA-256 `1245cb03690dae2bf4a6910a60894440eae5b32f5667d2b8843fff440252ea8d`, version `UeWt3VwRglxJ2sfzEGzPcTu4dmd6rMCB`. Its S3 metadata and byte count were read back, and a fresh temporary restore verified all required runtime files and metadata through the Unity worktree asset contract. Final artist-approved retopology, LOD, and collision policy remain production gates.

## Source-shape reference

The exact source canopy can be isolated from the pinned Strokah blend with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python scripts/released_cockpit/render_source_canopy.py
```

That produces four local reference renders under `working/source-canopy/`. The released runtime implementation fits the coherent 4K export through the production canopy slot, uses the segmented export only to locate the animatable eye, and has literal front-to-side Unity swap proof. The remaining art-production work is final retopology, LOD, and collision policy.
