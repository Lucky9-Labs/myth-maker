#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { inspectPartedGlb } from "../src/parted-model-ingestion.js";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/inspect-parted-glb.mjs <source.glb>");
console.log(JSON.stringify(inspectPartedGlb(await readFile(path)), null, 2));
