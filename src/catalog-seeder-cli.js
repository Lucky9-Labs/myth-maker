import { readFile } from "node:fs/promises";
import process from "node:process";

import { createSqliteCatalog } from "./catalog-sqlite.js";
import { CatalogSeedValidationError, importCatalogSeedManifest, inspectCatalogSeedManifest } from "./catalog-seeder.js";

const args = parse(process.argv.slice(2));
if (!args.manifest) usage("--manifest is required");
if (!args.check && !args.database) usage("--database is required unless --check is used");

try {
  const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
  const providedFiles = new Map();
  for (const [locator, filePath] of args.files) providedFiles.set(locator, await readFile(filePath));
  const inspection = inspectCatalogSeedManifest(manifest, { providedFiles });
  if (args.check) {
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.valid ? 0 : 1;
  } else {
    const catalog = createSqliteCatalog({ filename: args.database });
    try {
      process.stdout.write(`${JSON.stringify(importCatalogSeedManifest({ catalog, manifest, providedFiles }), null, 2)}\n`);
    } finally { catalog.close(); }
  }
} catch (error) {
  const detail = error instanceof CatalogSeedValidationError ? { error: error.message, failures: error.failures } : { error: error.message };
  process.stderr.write(`${JSON.stringify(detail, null, 2)}\n`);
  process.exitCode = 1;
}

function parse(values) {
  const output = { files: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--check") output.check = true;
    else if (value === "--manifest" || value === "--database") output[value.slice(2)] = values[++index];
    else if (value === "--file") {
      const assignment = values[++index] || "";
      const split = assignment.indexOf("=");
      if (split < 1 || split === assignment.length - 1) usage("--file must be locator=explicit-path");
      output.files.push([assignment.slice(0, split), assignment.slice(split + 1)]);
    } else usage(`unknown option ${value}`);
  }
  return output;
}
function usage(message) {
  process.stderr.write(`${message}\nUsage: node src/catalog-seeder-cli.js --manifest manifest.json [--file locator=explicit-path] --check | --database catalog.sqlite\n`);
  process.exit(2);
}
