#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createPartedModelImportManifest, inspectPartedGlb } from "../src/parted-model-ingestion.js";

const sourcePath = "assets/reef-skitter/source/reef_skitter.tripo.glb";
const inspectionPath = "assets/reef-skitter/manifests/source-inspection.json";
const importPath = "assets/reef-skitter/manifests/parted-model-import.json";
const previous = JSON.parse(await readFile(importPath, "utf8"));
const inspection = inspectPartedGlb(await readFile(sourcePath));
const manifest = createPartedModelImportManifest({
  model_id: "reef-skitter",
  source_path: sourcePath,
  inspection,
  imported_at: previous.imported_at,
});

await writeFile(inspectionPath, JSON.stringify(inspection, null, 2) + "\n");
await writeFile(importPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ source_sha256: inspection.source_sha256, parts: inspection.parts.length,
  connected_regions: inspection.parts.reduce((sum, part) => sum + (part.geometry?.connected_region_count || 0), 0) }));
