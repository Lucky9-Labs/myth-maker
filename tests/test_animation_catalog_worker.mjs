import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AnimationCatalog,
  InMemoryAnimationCatalogAdapter,
} from "../src/animation-catalog.js";
import { createSqliteCatalog } from "../src/catalog-sqlite.js";
import {
  emitAnimationCandidate,
  emitSmallOceanFixture,
} from "../src/animation-worker.js";
import { assembleEncounterPackage } from "../src/encounter-package-assembler.js";

const plannerHost = {
  platform: "windows",
  loaders: ["animation.rig.rig.dune.leviathan.v1", "animation.model.model.dune.leviathan.v1", "animation.scale.gargantuan"],
  contracts: [],
};

const workOrder = {
  schema_version: "1",
  work_id: "gargantuan-animation-work",
  encounter_id: "dune-encounter",
  lane: "animation.lane",
  deadline_at: "2026-09-08T01:00:00.000Z",
  requested_provides: ["animation.gargantuan.dune"],
  host_capabilities: {
    schema_version: "1",
    host_id: "demo-host",
    host_build: "1.0.0",
    platform: "windows",
    scripting_backend: "il2cpp",
    execution_kinds: ["recipe"],
    loaders: plannerHost.loaders,
    contracts: [],
    limits: { memory_mb: 1024, preload_seconds: 10 },
  },
  input_module_ids: [],
  attempt: 1,
};

function entry(animation_id, revision, overrides = {}) {
  return {
    animation_id,
    revision,
    kind: "preloaded_clip",
    rig_id: "rig.ocean.biped.v1",
    model_binding_id: "binding.ocean.biped.v1",
    duration_seconds: 1.25,
    tags: {
      locomotion: ["locomotion.swim"],
      attack: ["attack.pincer"],
      reaction: ["reaction.stagger"],
    },
    scale_profiles: ["small"],
    quality_score: 10,
    provenance: {
      producer: "demo-importer",
      label: "Demo Ocean Bootstrap",
      imported_at: "2026-09-08T00:00:00.000Z",
    },
    acceptance_state: "accepted",
    clip: { clip_id: `${animation_id}-clip`, preload_key: `preload://${animation_id}` },
    ...overrides,
  };
}

test("selects an accepted, compatible preloaded animation through the catalog adapter", () => {
  const catalog = new AnimationCatalog({ adapter: new InMemoryAnimationCatalogAdapter([
    entry("small-ocean-combo", 1),
    entry("small-ocean-wrong-rig", 1, { rig_id: "rig.other.v1", quality_score: 999 }),
  ]) });

  const selection = catalog.select({
    rig_id: "rig.ocean.biped.v1",
    model_binding_id: "binding.ocean.biped.v1",
    scale_profile: "small",
    required_tags: ["locomotion.swim", "attack.pincer", "reaction.stagger"],
  });

  assert.equal(selection.entry.animation_id, "small-ocean-combo");
  assert.equal(selection.used_fallback, false);
  assert.equal(selection.entry.kind, "preloaded_clip");
});

test("uses the catalog planner port when one is available", () => {
  const local = new InMemoryAnimationCatalogAdapter([entry("local-only", 1)]);
  const sharedEntry = {
    animationId: "shared-dune-strike",
    revision: 1,
    kind: "recipe",
    durationMs: 1800,
    functionalTags: ["attack.tail", "scale.gargantuan"],
    aestheticTags: ["aesthetic.dune"],
    compatibility: { loaders: [], contracts: [], platforms: ["windows"], bindingIds: [] },
    rigBinding: { rigBindingId: "rig.dune.leviathan.v1", modelBindingId: "model.dune.leviathan.v1" },
    provenance: { producer: "synthetic-catalog", createdAt: "2026-09-08T00:00:00.000Z", label: "Synthetic catalog test" },
    runtimeAcceptanceState: "accepted",
    recipe: { recipe_id: "dune-tail-sweep" },
  };
  let receivedQuery;
  const catalog = new AnimationCatalog({
    adapter: local,
    sharedCatalog: {
      findCompatibleParts(query) {
        receivedQuery = query;
        return { assets: [], animations: [sharedEntry] };
      },
    },
  });

  const selection = catalog.select({
    host: plannerHost,
    rig_id: "rig.dune.leviathan.v1",
    model_binding_id: "model.dune.leviathan.v1",
    scale_profile: "gargantuan",
    required_tags: ["attack.tail"],
    functional_tags: ["attack.tail", "scale.gargantuan"],
    aesthetic_tags: ["aesthetic.dune"],
  });

  assert.equal(selection.entry.animation_id, "shared-dune-strike");
  assert.equal(selection.entry.kind, "procedural_recipe");
  assert.deepEqual(receivedQuery, {
    host: plannerHost,
    functionalTags: ["attack.tail", "scale.gargantuan"],
    aestheticTags: ["aesthetic.dune"],
    rigBindingId: "rig.dune.leviathan.v1",
  });
  assert.equal(Object.isFrozen(sharedEntry), false, "selection snapshots rather than freezing the shared provider record");
});

test("uses the authoritative SQLite planner port and its newest accepted animation revision", () => {
  const sharedCatalog = createSqliteCatalog();
  sharedCatalog.bootstrapOceanEncounter();
  const prior = sharedCatalog.getAnimation("ocean-lunge");
  const acceptedRevision = sharedCatalog.appendAnimationRevision({
    ...prior,
    functionalTags: [...prior.functionalTags, "scale.small"],
    provenance: {
      ...prior.provenance,
      parentRefs: [{
        domain: "animation", stableId: prior.animationId, revision: prior.revision, contentSha256: prior.contentSha256,
      }],
    },
  });
  const catalog = new AnimationCatalog({
    adapter: new InMemoryAnimationCatalogAdapter(),
    sharedCatalog,
  });

  const selection = catalog.select({
    host: { platform: "windows", loaders: ["rig.aquatic", "collision.default"], contracts: ["combat.target.v1"] },
    rig_id: "rig.aquatic.biped.v1",
    model_binding_id: "model.brine-stalker.v1",
    scale_profile: "small",
    required_tags: ["combat.lunge"],
    functional_tags: ["combat.lunge", "scale.small"],
  });

  assert.equal(selection.entry.animation_id, "ocean-lunge");
  assert.equal(selection.entry.revision, acceptedRevision.revision);
  assert.equal(selection.entry.kind, "preloaded_clip");
  sharedCatalog.close();
});

test("selects an accepted procedural recipe at a gargantuan scale profile", () => {
  const catalog = new AnimationCatalog({ adapter: new InMemoryAnimationCatalogAdapter([
    entry("gargantuan-procedural", 1, {
      kind: "procedural_recipe",
      clip: undefined,
      recipe: { recipe_id: "procedural-leviathan-sweep", amplitude: 0.8 },
      scale_profiles: ["gargantuan"],
    }),
  ]) });

  const selection = catalog.select({
    rig_id: "rig.ocean.biped.v1",
    model_binding_id: "binding.ocean.biped.v1",
    scale_profile: "gargantuan",
    required_tags: ["attack.pincer"],
  });

  assert.equal(selection.entry.kind, "procedural_recipe");
  assert.equal(selection.entry.recipe.recipe_id, "procedural-leviathan-sweep");
});

test("rejects rig mismatches and deterministically selects a known fallback", () => {
  const catalog = new AnimationCatalog({ adapter: new InMemoryAnimationCatalogAdapter([
    entry("wrong-rig", 1, { rig_id: "rig.other.v1" }),
    entry("known-small-ocean-fallback", 1, {
      tags: { locomotion: ["locomotion.idle"], attack: [], reaction: [] },
      quality_score: 1,
    }),
  ]) });

  const selection = catalog.select({
    rig_id: "rig.ocean.biped.v1",
    model_binding_id: "binding.ocean.biped.v1",
    scale_profile: "small",
    required_tags: ["attack.pincer"],
    fallback_animation_id: "known-small-ocean-fallback",
  });

  assert.equal(selection.entry.animation_id, "known-small-ocean-fallback");
  assert.equal(selection.used_fallback, true);
  assert.deepEqual(selection.rejections, [{
    animation_id: "wrong-rig",
    revision: 1,
    reason: "rig_id mismatch",
  }]);
});

test("publishes immutable revisions while preserving prior snapshots", () => {
  const adapter = new InMemoryAnimationCatalogAdapter([entry("small-ocean-combo", 1)]);
  const catalog = new AnimationCatalog({ adapter });
  const first = catalog.getRevision("small-ocean-combo", 1);
  const second = catalog.publish(entry("small-ocean-combo", 2, { duration_seconds: 2.5 }));

  assert.equal(first.duration_seconds, 1.25);
  assert.equal(second.duration_seconds, 2.5);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(second));
  assert.throws(() => catalog.publish(entry("small-ocean-combo", 2)), /already exists/);
  assert.throws(() => catalog.publish(entry("another-animation", 2)), /must follow the current revision/);
  assert.equal(catalog.select({
    rig_id: "rig.ocean.biped.v1",
    model_binding_id: "binding.ocean.biped.v1",
    scale_profile: "small",
  }).entry.revision, 2);
});

test("keeps the latest accepted local revision selected while a later candidate is pending", () => {
  const catalog = new AnimationCatalog({ adapter: new InMemoryAnimationCatalogAdapter([
    entry("small-ocean-combo", 1),
    entry("small-ocean-combo", 2, { acceptance_state: "candidate" }),
  ]) });

  const selection = catalog.select({
    rig_id: "rig.ocean.biped.v1",
    model_binding_id: "binding.ocean.biped.v1",
    scale_profile: "small",
  });

  assert.equal(selection.entry.revision, 1);
});

test("emits ordered worker progress and an EncounterModule recipe for the small ocean fixture", () => {
  const catalog = new AnimationCatalog({ adapter: new InMemoryAnimationCatalogAdapter([
    entry("small-ocean-combo", 1),
    entry("known-small-ocean-fallback", 1, {
      tags: { locomotion: ["locomotion.idle"], attack: [], reaction: [] },
      quality_score: 1,
    }),
  ]) });

  const result = emitSmallOceanFixture({
    catalog,
    encounter_id: "ocean-fixture",
    work_id: "ocean-animation-work",
    worker_id: "animation-worker",
    occurred_at: "2026-09-08T00:00:00.000Z",
  });

  assert.equal(result.module.execution_kind, "recipe");
  assert.equal(result.module.inline_recipe.animation_id, "small-ocean-combo");
  assert.equal(result.module.inline_recipe.rig_id, "rig.ocean.biped.v1");
  assert.deepEqual(result.events.map((event) => event.kind), [
    "accepted", "started", "progress", "candidate_produced", "completed",
  ]);
  assert.deepEqual(result.events.map((event) => event.sequence), [0, 1, 2, 3, 4]);
  assert.equal(result.events[2].progress, 0.5);
  assert.equal(result.events[3].module, result.module);
  assert.deepEqual(result.module.compatibility.bindings, {
    "animation.rig.rig.ocean.biped.v1": "required",
    "animation.model.binding.ocean.biped.v1": "required",
    "animation.scale.small": "required",
  });
});

test("emits the known preloaded fallback as a worker candidate when no primary matches", () => {
  const catalog = new AnimationCatalog({ adapter: new InMemoryAnimationCatalogAdapter([
    entry("known-small-ocean-fallback", 1, {
      tags: { locomotion: ["locomotion.idle"], attack: [], reaction: [] },
      quality_score: 1,
    }),
  ]) });

  const result = emitSmallOceanFixture({ catalog });

  assert.equal(result.selection.used_fallback, true);
  assert.equal(result.module.inline_recipe.animation_id, "known-small-ocean-fallback");
  assert.match(result.events[3].message, /fallback/i);
});

test("emits arbitrary gargantuan work through the v1 assembler compatibility path", () => {
  let plannerQuery;
  const catalog = new AnimationCatalog({
    adapter: new InMemoryAnimationCatalogAdapter(),
    sharedCatalog: {
      findCompatibleParts(query) {
        plannerQuery = query;
        return {
          assets: [],
          animations: [{
            animationId: "dune-leviathan-sweep", revision: 2, kind: "recipe", durationMs: 2600,
            functionalTags: ["locomotion.burrow", "attack.tail", "reaction.armor", "scale.gargantuan"],
            aestheticTags: ["aesthetic.dune"],
            compatibility: { loaders: [], contracts: [], platforms: ["windows"], bindingIds: [] },
            rigBinding: { rigBindingId: "rig.dune.leviathan.v1", modelBindingId: "model.dune.leviathan.v1" },
            provenance: { producer: "synthetic-catalog", createdAt: "2026-09-08T00:00:00.000Z", label: "Synthetic catalog test" },
            runtimeAcceptanceState: "accepted",
            recipe: { recipe_id: "dune-leviathan-sweep" },
          }],
        };
      },
    },
  });
  const bindings = {
    "animation.rig.rig.dune.leviathan.v1": "required",
    "animation.model.model.dune.leviathan.v1": "required",
    "animation.scale.gargantuan": "required",
  };
  const query = {
    rig_id: "rig.dune.leviathan.v1",
    model_binding_id: "model.dune.leviathan.v1",
    scale_profile: "gargantuan",
    required_tags: ["locomotion.burrow", "attack.tail", "reaction.armor"],
    functional_tags: ["locomotion.burrow", "attack.tail", "reaction.armor", "scale.gargantuan"],
    aesthetic_tags: ["aesthetic.dune"],
  };
  const selection = catalog.select({ host: workOrder.host_capabilities, ...query });
  const result = emitAnimationCandidate({
    work_order: workOrder,
    selection,
    query,
    bindings,
    provides: ["animation.gargantuan.dune"],
    fallback: {},
    occurred_at: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result.module.provides, ["animation.gargantuan.dune"]);
  assert.equal(result.module.inline_recipe.rig_id, "rig.dune.leviathan.v1");
  assert.deepEqual(result.module.compatibility.bindings, bindings);
  assert.deepEqual(result.events.map((event) => event.sequence), [0, 1, 2, 3, 4]);
  assertClosedV1Envelope(result.module, "encounter-module.schema.json");
  for (const event of result.events) assertClosedV1Envelope(event, "worker-event.schema.json");
  assert.deepEqual(plannerQuery, {
    host: workOrder.host_capabilities,
    functionalTags: ["locomotion.burrow", "attack.tail", "reaction.armor", "scale.gargantuan"],
    aestheticTags: ["aesthetic.dune"],
    rigBindingId: "rig.dune.leviathan.v1",
  });

  const assembled = assembleEncounterPackage({
    host: workOrder.host_capabilities,
    encounterId: workOrder.encounter_id,
    packageId: "dune-package",
    baselineModules: [baselineModule()],
    candidateModules: [result.module],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });
  assert.deepEqual(assembled.package.module_ids, ["baseline-animation", "dune-leviathan-sweep"]);

  const incompatible = assembleEncounterPackage({
    host: { ...workOrder.host_capabilities, loaders: bindingsKeysExcept(bindings, "animation.scale.gargantuan") },
    encounterId: workOrder.encounter_id,
    packageId: "dune-incompatible-package",
    baselineModules: [baselineModule()],
    candidateModules: [result.module],
    assembledAt: "2026-09-08T00:00:00.000Z",
  });
  assert.match(incompatible.rejections[0].reasons[0], /missing host loader animation.scale.gargantuan/);
  assert.throws(() => emitAnimationCandidate({
    work_order: workOrder, selection, query, bindings: { "unrelated.loader": "required" },
    provides: ["animation.gargantuan.dune"], fallback: {},
  }), /bindings must cover animation.rig.rig.dune.leviathan.v1/);
  assert.throws(() => emitAnimationCandidate({
    work_order: { ...workOrder, lane: "" }, selection, query, bindings,
    provides: ["animation.gargantuan.dune"], fallback: {},
  }), /EncounterWorkOrder/);
});

function baselineModule() {
  return {
    schema_version: "1", module_id: "baseline-animation", revision: 1, execution_kind: "recipe",
    provides: ["animation.baseline"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" },
    quality: { tier: 0, score: 0 }, inline_recipe: { kind: "baseline" }, fallback_module_ids: [],
  };
}

function bindingsKeysExcept(bindings, omitted) {
  return Object.keys(bindings).filter((key) => key !== omitted);
}

function assertClosedV1Envelope(value, schemaFile) {
  const schema = JSON.parse(readFileSync(new URL(`../contracts/v1/${schemaFile}`, import.meta.url), "utf8"));
  for (const field of schema.required) assert.ok(field in value, `${schemaFile} requires ${field}`);
  for (const field of Object.keys(value)) assert.ok(field in schema.properties, `${schemaFile} disallows ${field}`);
  assert.equal(value.schema_version, schema.properties.schema_version.const);
}
