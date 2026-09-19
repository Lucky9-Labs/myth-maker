# Released Strokah cockpit filling — concave candidate

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

## Tripo candidate

The four directional views were submitted through Tripo's **Multiview** mode, not batch image generation. The resulting candidate is preserved at:

https://studio.tripo3d.ai/workspace/generate/ca172c62-35b7-4740-a2fa-5147a00baae6

The generated mesh visibly retains the recessed bowl/socket profile, but it has not yet been exported locally, dimensionally fitted to the source canopy, retopologized, or imported into Unity. It is therefore a shape candidate, not a shippable runtime asset.

## Source-shape reference

The exact source canopy can be isolated from the pinned Strokah blend with:

```sh
/Applications/Blender.app/Contents/MacOS/Blender \
  --background \
  --python scripts/released_cockpit/render_source_canopy.py
```

That produces four local reference renders under `working/source-canopy/`. Promotion requires a local Tripo export, fit/scale correction against the source bounds, a clean standalone cockpit-filling export, and literal Unity swap proof showing that the blue canopy is absent only on Released enemies.
