# Turret Pet LOD0

Gameplay LOD0 derived from the accepted Tripo turret-pet source model.

- Tripo workspace model: `27644778-2078-4911-ba13-eff8232a473a`
- Source: `source/turret_pet_tripo_hd.glb`
- LOD0: `lod0/turret_pet_lod0.glb`
- Triangle budget: 20,000
- Verified output: 19,997 triangles, 12,437 exported vertices
- Structure: all 92 source mesh nodes preserved, plus one authored lower-front vertical eye indicator
- Materials: dark gunmetal and emissive cyan eye
- Build/validation manifest: `manifests/lod0.json`
- Independent GLB inspection: `manifests/lod0-inspection.json`
- Four-view proof: `../../output/turret-pet/lod0/turret_pet_lod0_4panel.png`

The source GLB, gameplay LOD0, and proof image are binary registry assets and
are intentionally not committed to Git. Restore the exact version-pinned
authoring release into any rigging worktree with:

```bash
python3 art-library/scripts/restore_turret_pet.py --destination .
```

The restorer refuses to overwrite modified files and verifies both the release
archive and every restored member against
`art-library/releases/nautiloid-turret-pet-authoring-v1.json`.

Rebuild with:

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background \
  --python scripts/build_turret_pet_lod0.py -- \
  --source assets/turret-pet/source/turret_pet_tripo_hd.glb \
  --output assets/turret-pet/lod0/turret_pet_lod0.glb \
  --manifest assets/turret-pet/manifests/lod0.json \
  --preview-dir output/turret-pet/lod0 \
  --target-triangles 20000
```
