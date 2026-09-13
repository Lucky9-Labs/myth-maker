#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { inspectAnimatedPartedGlb } from "../src/parted-model-ingestion.js";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/inspect-animated-parted-glb.mjs <runtime.glb>");
console.log(JSON.stringify(inspectAnimatedPartedGlb(await readFile(path)), null, 2));
