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
