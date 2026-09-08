import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL("../contracts/v1/concept-first-asset-production-gate.schema.json", import.meta.url);
const fixtureUrl = new URL("./fixtures/concept-first-asset-production-gate.fixture.json", import.meta.url);

const refOf = (record, id) => ({ id, revision: record.revision, content_sha256: record.content_sha256 });

test("the concept-first gate fixture pins the same immutable intent, direction, and concept through dispatch and selection", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  const intent = fixture.encounter_intent;
  const direction = fixture.art_direction_revision;
  const concept = fixture.concept_reference_revision;
  const expectedLineage = {
    kind: "concept_lineage",
    encounter_intent: refOf(intent, intent.intent_id),
    art_direction_revision: refOf(direction, direction.art_direction_id),
    concept_reference_revision: refOf(concept, concept.concept_reference_id),
  };

  assert.deepEqual(direction.encounter_intent, expectedLineage.encounter_intent);
  assert.deepEqual(concept.art_direction_revision, expectedLineage.art_direction_revision);
  assert.deepEqual(fixture.worker_brief.lineage, expectedLineage);
  assert.deepEqual(fixture.asset_revision.lineage, expectedLineage);
  assert.deepEqual(fixture.asset_revision.worker_brief, refOf(fixture.worker_brief, fixture.worker_brief.brief_id));
  assert.equal(fixture.asset_revision.artifact.sha256, fixture.asset_revision.content_sha256);
  assert.deepEqual(fixture.assembly_receipt.asset_revision, refOf(fixture.asset_revision, fixture.asset_revision.asset_id));
  assert.equal(fixture.assembly_receipt.decision, "selected");
  assert.equal(fixture.assembly_receipt.lineage_compatibility, "compatible");
  assert.equal(fixture.asset_revision.source_acceptance.status, "accepted");
  assert.equal(fixture.asset_revision.runtime_acceptance.status, "pending");
});

test("the closed contract requires the full art brief, acceptance states, and either concept lineage or a bounded waiver", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  const defs = schema.$defs;

  for (const name of ["encounterIntent", "artDirectionRevision", "conceptReferenceRevision", "workerBrief", "assetRevision", "assemblyReceipt", "reuseMaintenanceWaiver"]) {
    assert.equal(defs[name].additionalProperties, false, `${name} must reject undeclared fields`);
  }
  for (const field of ["player_facing_beat", "silhouette", "scale", "palette_material_cues", "arena_relationship", "animation_combat_beats", "constraints"]) {
    assert.ok(defs.artDirectionRevision.required.includes(field), `art direction requires ${field}`);
  }
  for (const field of ["artifact", "lineage", "interpretation_constraints", "provenance", "source_acceptance", "runtime_acceptance"]) {
    assert.ok(defs.assetRevision.required.includes(field), `asset revision requires ${field}`);
  }
  assert.deepEqual(defs.lineage.oneOf.map((variant) => variant.$ref), ["#/$defs/conceptLineage", "#/$defs/waivedLineage"]);
  for (const field of ["kind", "bounded_reason", "approver", "approved_at", "expires_at", "asset_ids"]) {
    assert.ok(defs.reuseMaintenanceWaiver.required.includes(field), `waiver requires ${field}`);
  }
  assert.deepEqual(defs.assemblyReceipt.properties.decision.enum, ["selected", "rejected", "deviation", "fallback"]);
  assert.equal(defs.assemblyReceipt.allOf[0].then.properties.lineage_compatibility.const, "compatible");
});
