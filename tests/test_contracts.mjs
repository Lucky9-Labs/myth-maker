import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractDirectory = path.join(here, "..", "contracts", "v1");

test("v1 contracts are parseable, closed JSON Schemas with unique identifiers", async () => {
  const files = (await readdir(contractDirectory)).filter((file) => file.endsWith(".schema.json"));
  assert.ok(files.length >= 7);

  const ids = new Set();
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(contractDirectory, file), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/myth-maker\.dev\/contracts\/v1\//);
    assert.equal(ids.has(schema.$id), false, `duplicate schema id in ${file}`);
    ids.add(schema.$id);

    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false, `${file} must reject undeclared top-level fields`);
      assert.ok(schema.required.includes("schema_version"), `${file} must require schema_version`);
      assert.equal(schema.properties.schema_version.const, "1");
    }
  }
});

test("all relative schema references resolve to a published v1 schema", async () => {
  const files = (await readdir(contractDirectory)).filter((file) => file.endsWith(".schema.json"));
  const knownFiles = new Set(files);

  for (const file of files) {
    const text = await readFile(path.join(contractDirectory, file), "utf8");
    const schema = JSON.parse(text);
    const pending = [schema];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
        const [referencedFile] = value.$ref.split("#");
        assert.ok(knownFiles.has(referencedFile), `${file} references missing ${referencedFile}`);
      }
      pending.push(...Object.values(value));
    }
  }
});

test("v2 contracts are closed and retain v1 dependencies without changing v1", async () => {
  const contractDirectory = path.join(here, "..", "contracts", "v2");
  const files = [
    "encounter-spec.schema.json", "work-order.schema.json", "host-capability-manifest.schema.json",
    "package-discovery-manifest.schema.json", "package-discovery-catalog-revision.schema.json",
    "package-discovery-assembly-receipt.schema.json", "runtime-artifact-publication.schema.json",
  ];
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(contractDirectory, file), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, `https://myth-maker.dev/contracts/v2/${file}`);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.schema_version.const, "2");
  }
  const workOrder = JSON.parse(await readFile(path.join(contractDirectory, "work-order.schema.json"), "utf8"));
  assert.equal(workOrder.properties.production_gate.$ref, "production-gate.schema.json#/$defs/dispatchGate");
  assert.equal(workOrder.properties.host_capabilities.oneOf[1].$ref, "host-capability-manifest.schema.json");
  const host = JSON.parse(await readFile(path.join(contractDirectory, "host-capability-manifest.schema.json"), "utf8"));
  assert.equal(host.required.includes("artifact_formats"), true);
  const manifest = JSON.parse(await readFile(path.join(contractDirectory, "package-discovery-manifest.schema.json"), "utf8"));
  assert.equal(manifest.$defs.artifact.properties.media_type.const, undefined);
  assert.equal(manifest.$defs.artifact.required.includes("byte_length"), true);
  assert.equal(manifest.$defs.artifact.required.includes("compatibility"), true);
  const publication = JSON.parse(await readFile(path.join(contractDirectory, "runtime-artifact-publication.schema.json"), "utf8"));
  assert.equal(publication.$defs.runtimeArtifact.properties.media_type.maxLength, 128);
  assert.equal(publication.properties.extension.pattern, "^[a-z0-9]{1,16}$");
  assert.equal(publication.$defs.hostCompatibility.required.includes("scripting_backend"), true);

  const schemas = new Set();
  for (const version of ["v1", "v2"]) {
    for (const file of (await readdir(path.join(here, "..", "contracts", version))).filter((entry) => entry.endsWith(".schema.json"))) {
      schemas.add(`${version}/${file}`);
    }
  }
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(contractDirectory, file), "utf8"));
    const pending = [schema];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) {
        const [reference] = value.$ref.split("#");
        assert.equal(schemas.has(path.posix.normalize(path.posix.join("v2", reference))), true, `${file} references a published schema`);
      }
      pending.push(...Object.values(value));
    }
  }
});
