import assert from "node:assert/strict";
import test from "node:test";
import { assembleEncounterPackage, freezeEncounterPackage } from "../src/encounter-package-assembler.js";
import { canonicalJson, canonicalSha256, compatibleFrozenPackage } from "../src/package-discovery.js";
import worker, { EncounterCoordinator } from "../src/worker.js";

const baseWorkOrder = {
  schema_version: "1",
  work_id: "arena-shell",
  encounter_id: "encounter-alpha",
  lane: "arena",
  deadline_at: "2026-09-08T20:00:00.000Z",
  requested_provides: ["arena.shell"],
  host_capabilities: {
    schema_version: "1",
    host_id: "mech-host",
    host_build: "test-build",
    platform: "macos",
    scripting_backend: "il2cpp",
    execution_kinds: ["recipe"],
    loaders: ["recipe-loader"],
    contracts: ["encounter.module.v1"],
    limits: { memory_mb: 512, preload_seconds: 30, artifact_bytes: 512, actors: 1 },
  },
  input_module_ids: [],
  attempt: 1,
};

function playablePackage() {
  return assembleEncounterPackage({
    host: baseWorkOrder.host_capabilities,
    encounterId: "encounter-alpha",
    packageId: "package-alpha",
    baselineModules: [{
      schema_version: "1",
      module_id: "baseline-core",
      revision: 1,
      execution_kind: "recipe",
      provides: ["combat.core"],
      requires: [],
      conflicts: [],
      compatibility: { host_contract_version: "1" },
      quality: { tier: 0, score: 1 },
      inline_recipe: { kind: "baseline" },
      fallback_module_ids: [],
    }],
    assembledAt: "2026-09-08T19:30:00.000Z",
  }).package;
}

function workOrder(overrides = {}) {
  return { ...structuredClone(baseWorkOrder), ...overrides };
}

const unityHostCapabilities = {
  schema_version: "2",
  host_id: "unity-host",
  host_build: "unity-6000.6.0f1-macos",
  platform: "macos",
  scripting_backend: "il2cpp",
  execution_kinds: ["runtime_asset"],
  loaders: ["unity.assetbundle"],
  contracts: ["encounter.module.v1"],
  limits: { memory_mb: 512, preload_seconds: 30, artifact_bytes: 512, actors: 1 },
  artifact_formats: [{ media_type: "application/vnd.unity.assetbundle", loader: "unity.assetbundle", platform: "macos", build: "unity-6000.6.0f1-macos" }],
};

function unityRuntimeArtifact() {
  return {
    uri: "https://artifacts.example.test/encounter-alpha/baseline-core-macos.bundle",
    sha256: "d".repeat(64),
    media_type: "application/vnd.unity.assetbundle",
    byte_length: 256,
    compatibility: { platforms: ["macos"], builds: ["unity-6000.6.0f1-macos"], loaders: ["unity.assetbundle"] },
  };
}

function unityPlayablePackage() {
  return assembleEncounterPackage({
    host: { ...baseWorkOrder.host_capabilities, execution_kinds: ["runtime_asset"], loaders: ["unity.assetbundle"] },
    encounterId: "encounter-alpha",
    packageId: "package-unity",
    baselineModules: [{
      schema_version: "1", module_id: "baseline-core", revision: 1, execution_kind: "runtime_asset",
      provides: ["combat.core"], requires: ["encounter.module.v1"], conflicts: [],
      compatibility: { host_contract_version: "1", platforms: ["macos"], scripting_backends: ["il2cpp"], bindings: { "unity.assetbundle": "1" } },
      quality: { tier: 0, score: 1 }, artifact: { uri: "https://artifacts.example.test/encounter-alpha/baseline-core-macos.bundle", sha256: "d".repeat(64), media_type: "application/vnd.unity.assetbundle", byte_length: 256 }, fallback_module_ids: [],
    }],
    assembledAt: "2026-09-08T19:30:00.000Z",
  }).package;
}

async function acceptedCatalogRevisionV2() {
  const artifact = unityRuntimeArtifact();
  const revision = {
    schema_version: "2", catalog_revision_id: "catalog-unity-0001", encounter_id: "encounter-alpha", revision: 1, state: "accepted", created_at: "2026-09-08T19:30:00.000Z",
    acceptance: { decision_id: "catalog-decision-0002", policy_id: "runtime-catalog-acceptance.v1", accepted_at: "2026-09-08T19:31:00.000Z" },
    modules: [{ module_id: "baseline-core", revision: 1, runtime_artifacts: [artifact], compatibility: { platforms: ["macos"], scripting_backends: ["il2cpp"], execution_kinds: ["runtime_asset"], loaders: ["unity.assetbundle"], contracts: ["encounter.module.v1"], limits: { artifact_bytes: 512, actors: 1 } } }],
  };
  return { ...revision, catalog_sha256: await canonicalSha256(revision) };
}

async function acceptedAssemblyReceiptV2(packageRecord, catalogRevision) {
  const selected_modules = [{ module_id: "baseline-core", revision: 1, runtime_artifacts: [unityRuntimeArtifact()] }];
  const runtimeManifest = { schema_version: "2", profile: "runtime-artifact-manifest.v2", artifact_set_id: "unity-artifact-set", artifacts: selected_modules };
  const runtime_artifact_manifest = { ...runtimeManifest, manifest_sha256: await canonicalSha256(runtimeManifest) };
  const receipt = {
    schema_version: "2", receipt_id: "assembly-receipt-unity", encounter_id: packageRecord.encounter_id, package_id: packageRecord.package_id, package_revision: packageRecord.revision, package_manifest_sha256: packageRecord.manifest_sha256,
    catalog_revision_id: catalogRevision.catalog_revision_id, catalog_revision_sha256: catalogRevision.catalog_sha256, assembled_at: "2026-09-08T19:32:00.000Z",
    acceptance: { decision_id: "assembly-decision-0002", policy_id: "runtime-assembly-acceptance.v1", accepted_at: "2026-09-08T19:33:00.000Z" },
    selected_modules, runtime_artifact_manifest,
  };
  return { ...receipt, receipt_sha256: await canonicalSha256(receipt) };
}

function storage() {
  const values = new Map();
  const store = { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value) };
  let pending = Promise.resolve();
  return {
    ...store,
    transaction(callback) {
      const transaction = pending.then(() => callback(store));
      pending = transaction.catch(() => undefined);
      return transaction;
    },
  };
}

function coordinator() {
  return new EncounterCoordinator({ storage: storage() }, {
    WORK_DISPATCH_URL: "https://workers.example/dispatch",
    WORK_DISPATCH_TOKEN: "dispatch",
    PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEII2uBd4SxWoOh7s251KvvH03Hyx3kfMAZTwku//Ga3A4",
  });
}

function submit(instance, order, idempotencyKey = "encounter-work-0001") {
  return instance.fetch(new Request("https://coordinator/work-items", {
    method: "POST",
    body: JSON.stringify({ idempotency_key: idempotencyKey, work_order: order }),
  }));
}

function event(workId, sequence, kind, extra = {}) {
  return {
    schema_version: "1",
    event_id: `event-${String(sequence).padStart(4, "0")}-${kind}`,
    work_id: workId,
    encounter_id: "encounter-alpha",
    worker_id: "worker-one",
    sequence,
    occurred_at: "2026-09-08T19:00:00.000Z",
    kind,
    ...extra,
  };
}

function appendEvent(instance, value) {
  return instance.fetch(new Request(`https://coordinator/work-items/${value.work_id}/events`, {
    method: "POST",
    body: JSON.stringify(value),
  }));
}

async function body(result) {
  return result.json();
}

async function acceptedCatalogRevision(overrides = {}) {
  const revision = {
    schema_version: "1",
    catalog_revision_id: "catalog-alpha-0001",
    encounter_id: "encounter-alpha",
    revision: 1,
    state: "accepted",
    created_at: "2026-09-08T19:30:00.000Z",
    acceptance: {
      decision_id: "catalog-decision-0001",
      policy_id: "runtime-catalog-acceptance.v1",
      accepted_at: "2026-09-08T19:31:00.000Z",
    },
    modules: [{
      module_id: "baseline-core",
      revision: 1,
      artifact: {
        uri: "https://artifacts.example.test/encounter-alpha/baseline-core.glb",
        sha256: "a".repeat(64),
        media_type: "model/gltf-binary",
        byte_length: 256,
      },
      compatibility: {
        platforms: ["macos"],
        scripting_backends: ["il2cpp"],
        execution_kinds: ["recipe"],
        loaders: ["recipe-loader"],
        contracts: ["encounter.module.v1"],
        limits: { artifact_bytes: 512, actors: 1 },
      },
    }],
    ...overrides,
  };
  return { ...revision, catalog_sha256: await canonicalSha256(revision) };
}

async function acceptedAssemblyReceipt(packageRecord, catalogRevision, overrides = {}) {
  const artifact = catalogRevision.modules[0].artifact;
  const manifestArtifact = { ...artifact, uri: `sha256:${artifact.sha256}` };
  const manifest = {
    schema_version: "1",
    profile: "glb.assembly.v1",
    assembly_id: "assembly-alpha-0001",
    revision: 1,
    assembled_at: "2026-09-08T19:32:00.000Z",
    coordinate_convention: { handedness: "right", up_axis: "y", unit: "meter", transforms: "parent-relative" },
    runtime_target: { loader: { id: "gltf", version: "2.0" }, target: { platform: "macos", render_pipeline: { id: "urp", version: "17" } } },
    root_slot_id: "root",
    fragments: [{
      slot_id: "root", fragment_id: "baseline-core", revision: 1, selected_as: "primary",
      runtime_artifact: manifestArtifact, runtime_linkage_sha256: "c".repeat(64),
      material_slots: [], markers: [], motion_binding: { kind: "procedural" }, provenance: { producer: "accepted-worker" },
    }],
    attachments: [], missing_slots: [], fallback_provenance: { used_fallback: false, slot_ids: [] }, rejection_reasons: [],
  };
  const assemblyManifest = { ...manifest, manifest_sha256: await canonicalSha256(manifest) };
  const receipt = {
    schema_version: "1",
    receipt_id: "assembly-receipt-0001",
    encounter_id: packageRecord.encounter_id,
    package_id: packageRecord.package_id,
    package_revision: packageRecord.revision,
    package_manifest_sha256: packageRecord.manifest_sha256,
    catalog_revision_id: catalogRevision.catalog_revision_id,
    catalog_revision_sha256: catalogRevision.catalog_sha256,
    assembled_at: "2026-09-08T19:32:00.000Z",
    acceptance: {
      decision_id: "assembly-decision-0001",
      policy_id: "runtime-assembly-acceptance.v1",
      accepted_at: "2026-09-08T19:33:00.000Z",
    },
    selected_modules: [{ module_id: "baseline-core", revision: 1, artifact }],
    assembly_manifest: assemblyManifest,
    ...overrides,
  };
  return { ...receipt, receipt_sha256: await canonicalSha256(receipt) };
}

async function freezeInputs(instance, packageRecord) {
  const catalogRevision = await acceptedCatalogRevision();
  const recorded = await instance.fetch(new Request("https://coordinator/catalog-revisions", {
    method: "POST", body: JSON.stringify({ catalog_revision: catalogRevision }),
  }));
  assert.equal(recorded.status, 201);
  return {
    package: packageRecord,
    catalog_revision: catalogRevision,
    catalog_revision_id: catalogRevision.catalog_revision_id,
    assembly_receipt: await acceptedAssemblyReceipt(packageRecord, catalogRevision),
    host_capabilities: baseWorkOrder.host_capabilities,
  };
}

test("the edge route scopes each work submission to its encounter", async () => {
  let seenName;
  let proxied;
  const payload = { idempotency_key: "encounter-work-0001", work_order: workOrder() };
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { seenName = name; return name; },
      get() { return { fetch: async (_url, init) => { proxied = JSON.parse(init.body); return new Response("{}", { status: 202 }); } }; },
    },
  };
  const result = await worker.fetch(new Request("https://runtime/v1/encounters/encounter-alpha/work-items", {
    method: "POST",
    headers: { authorization: "Bearer ingress", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
  assert.equal(result.status, 202);
  assert.equal(seenName, "encounter-alpha");
  assert.deepEqual(proxied, payload);
});

test("the edge route rejects a work order for a different encounter", async () => {
  let called = false;
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { return name; },
      get() { called = true; return { fetch: async () => new Response("{}") }; },
    },
  };
  const result = await worker.fetch(new Request("https://runtime/v1/encounters/encounter-alpha/work-items", {
    method: "POST",
    headers: { authorization: "Bearer ingress", "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: "encounter-work-0001", work_order: workOrder({ encounter_id: "encounter-beta" }) }),
  }), env);
  assert.equal(result.status, 409);
  assert.equal(called, true);
  assert.equal((await body(result)).error, "encounter_path_mismatch");
});

test("catalog admission requires the separate acceptance authority rather than a host discovery credential", async () => {
  let forwarded = false;
  const env = {
    AGENT_INGRESS_TOKEN: "ingress",
    CATALOG_ACCEPTANCE_TOKEN: "catalog-authority",
    ENCOUNTER_COORDINATOR: {
      idFromName(name) { return name; },
      get() { return { fetch: async () => { forwarded = true; return new Response("{}", { status: 201 }); } }; },
    },
  };
  const request = new Request("https://runtime/v1/encounters/encounter-alpha/catalog-revisions", {
    method: "POST", headers: { authorization: "Bearer ingress", "content-type": "application/json" },
    body: JSON.stringify({ catalog_revision: { encounter_id: "encounter-alpha" } }),
  });
  const result = await worker.fetch(request, env);
  assert.equal(result.status, 401);
  assert.equal((await body(result)).error, "catalog_acceptance_unauthorized");
  assert.equal(forwarded, false);
});

test("the authenticated discovery route returns only a frozen package bound to accepted catalog and assembly revisions", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const packageRecord = playablePackage();
    const inputs = await freezeInputs(instance, packageRecord);
    assert.equal(await compatibleFrozenPackage({ packageRecord, catalogRevision: inputs.catalog_revision, assemblyReceipt: inputs.assembly_receipt, hostCapabilities: baseWorkOrder.host_capabilities }), true);
    const frozen = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify(inputs),
    }));
    assert.equal(frozen.status, 201);

    const request = {
      schema_version: "1",
      request_id: "discovery-request-0001",
      idempotency_key: "discovery-request-0001",
      host_capabilities: baseWorkOrder.host_capabilities,
    };
    const first = await instance.fetch(new Request("https://coordinator/package-discoveries", { method: "POST", body: JSON.stringify(request) }));
    const replay = await instance.fetch(new Request("https://coordinator/package-discoveries", { method: "POST", body: JSON.stringify(request) }));
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    const selected = await body(first);
    assert.equal(selected.status, "selected");
    assert.deepEqual(selected.manifest.artifacts, [{
      module_id: "baseline-core", revision: 1,
      uri: "https://artifacts.example.test/encounter-alpha/baseline-core.glb",
      sha256: "a".repeat(64), media_type: "model/gltf-binary", byte_length: 256,
    }]);
    assert.equal(selected.manifest.catalog_revision_id, inputs.catalog_revision_id);
    assert.equal(selected.manifest.assembly_receipt_id, inputs.assembly_receipt.receipt_id);
    assert.deepEqual(selected.manifest.signature.algorithm, "Ed25519");
    assert.match(selected.manifest.signature.value, /^[A-Za-z0-9_-]{86}$/);
    const unsignedManifest = structuredClone(selected.manifest);
    delete unsignedManifest.signature;
    const publicKey = await crypto.subtle.importKey("spki", Buffer.from("MCowBQYDK2VwAyEA45D06/XjPdHC8dvH1W/4IIhmHRXsmeyPSOBrSDNcBpY=", "base64"), { name: "Ed25519" }, false, ["verify"]);
    assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, Buffer.from(selected.manifest.signature.value, "base64url"), new TextEncoder().encode(canonicalJson(unsignedManifest))), true);
    assert.deepEqual(await body(replay), selected);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("v2 discovery negotiates and signs an immutable Unity AssetBundle only for an exact host format", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const packageRecord = unityPlayablePackage();
    const catalogRevision = await acceptedCatalogRevisionV2();
    const assemblyReceipt = await acceptedAssemblyReceiptV2(packageRecord, catalogRevision);
    const recorded = await instance.fetch(new Request("https://coordinator/catalog-revisions", {
      method: "POST", body: JSON.stringify({ catalog_revision: catalogRevision }),
    }));
    assert.equal(recorded.status, 201);
    const frozen = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST", body: JSON.stringify({ package: packageRecord, catalog_revision_id: catalogRevision.catalog_revision_id, assembly_receipt: assemblyReceipt, host_capabilities: unityHostCapabilities }),
    }));
    assert.equal(frozen.status, 201);

    const selected = await instance.fetch(new Request("https://coordinator/package-discoveries", {
      method: "POST", body: JSON.stringify({ schema_version: "2", request_id: "discovery-unity-0001", idempotency_key: "discovery-unity-0001", host_capabilities: unityHostCapabilities }),
    }));
    assert.equal(selected.status, 200);
    const value = await body(selected);
    assert.equal(value.schema_version, "2");
    assert.equal(value.status, "selected");
    assert.deepEqual(value.manifest.artifacts, [{ module_id: "baseline-core", revision: 1, ...unityRuntimeArtifact() }]);
    const unsignedManifest = structuredClone(value.manifest);
    delete unsignedManifest.signature;
    const publicKey = await crypto.subtle.importKey("spki", Buffer.from("MCowBQYDK2VwAyEA45D06/XjPdHC8dvH1W/4IIhmHRXsmeyPSOBrSDNcBpY=", "base64"), { name: "Ed25519" }, false, ["verify"]);
    assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, Buffer.from(value.manifest.signature.value, "base64url"), new TextEncoder().encode(canonicalJson(unsignedManifest))), true);

    const incompatibleHost = structuredClone(unityHostCapabilities);
    incompatibleHost.host_build = "unity-6000.7.0f1-macos";
    incompatibleHost.artifact_formats[0].build = incompatibleHost.host_build;
    const rejected = await instance.fetch(new Request("https://coordinator/package-discoveries", {
      method: "POST", body: JSON.stringify({ schema_version: "2", request_id: "discovery-unity-0002", idempotency_key: "discovery-unity-0002", host_capabilities: incompatibleHost }),
    }));
    assert.deepEqual(await body(rejected), { schema_version: "2", status: "no_package", encounter_id: "encounter-alpha", request_id: "discovery-unity-0002", reason: "no_accepted_compatible_package" });

    const mixedVersion = await instance.fetch(new Request("https://coordinator/package-discoveries", {
      method: "POST", body: JSON.stringify({ schema_version: "1", request_id: "discovery-unity-0003", idempotency_key: "discovery-unity-0003", host_capabilities: unityHostCapabilities }),
    }));
    assert.equal(mixedVersion.status, 400);
    assert.equal((await body(mixedVersion)).error, "invalid_package_discovery_request");

    for (const [reason, mutate] of [
      ["media", (host) => { host.artifact_formats[0].media_type = "application/test"; }],
      ["loader", (host) => { host.artifact_formats[0].loader = "other-loader"; host.loaders = ["other-loader"]; }],
      ["platform", (host) => { host.platform = "windows"; host.artifact_formats[0].platform = "windows"; }],
      ["bytes", (host) => { host.limits.artifact_bytes = 255; }],
    ]) {
      const incompatible = structuredClone(unityHostCapabilities);
      mutate(incompatible);
      const result = await instance.fetch(new Request("https://coordinator/package-discoveries", {
        method: "POST", body: JSON.stringify({ schema_version: "2", request_id: `discovery-${reason}-0001`, idempotency_key: `discovery-${reason}-0001`, host_capabilities: incompatible }),
      }));
      assert.deepEqual(await body(result), { schema_version: "2", status: "no_package", encounter_id: "encounter-alpha", request_id: `discovery-${reason}-0001`, reason: "no_accepted_compatible_package" });
    }

    const tamperedReceipt = structuredClone(assemblyReceipt);
    tamperedReceipt.selected_modules[0].runtime_artifacts[0].sha256 = "e".repeat(64);
    assert.equal(await compatibleFrozenPackage({ packageRecord, catalogRevision, assemblyReceipt: tamperedReceipt, hostCapabilities: unityHostCapabilities }), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("discovery fails closed for an absent accepted package and never accepts a receipt-shaped report", async () => {
  const instance = coordinator();
  const absent = await instance.fetch(new Request("https://coordinator/package-discoveries", {
    method: "POST",
    headers: { "x-encounter-id": "encounter-alpha" },
    body: JSON.stringify({ schema_version: "1", request_id: "discovery-empty-0001", idempotency_key: "discovery-empty-0001", host_capabilities: baseWorkOrder.host_capabilities }),
  }));
  assert.equal(absent.status, 200);
  assert.deepEqual(await body(absent), {
    schema_version: "1", status: "no_package", encounter_id: "encounter-alpha", request_id: "discovery-empty-0001", reason: "no_accepted_compatible_package",
  });

  const report = await instance.fetch(new Request("https://coordinator/catalog-revisions", {
    method: "POST",
    body: JSON.stringify({ catalog_revision: { schema_version: "1", catalog_revision_id: "report-0001", encounter_id: "encounter-alpha", state: "accepted" } }),
  }));
  assert.equal(report.status, 400);
  assert.equal((await body(report)).error, "invalid_accepted_catalog_revision");

  const sprinter = await acceptedCatalogRevision({
    catalog_revision_id: "catalog-sprinter-0001",
    modules: [{
      ...(await acceptedCatalogRevision()).modules[0],
      artifact: {
        uri: "https://artifacts.example.test/SPRINTER/baseline-core.glb",
        sha256: "b".repeat(64), media_type: "model/gltf-binary", byte_length: 256,
      },
    }],
  });
  const rejectedSource = await instance.fetch(new Request("https://coordinator/catalog-revisions", {
    method: "POST", body: JSON.stringify({ catalog_revision: sprinter }),
  }));
  assert.equal(rejectedSource.status, 400);
  assert.equal((await body(rejectedSource)).error, "invalid_accepted_catalog_revision");
});

test("the coordinator dispatches a v1 work item through the adapter", async () => {
  const oldFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (_url, init) => {
    dispatches.push({ body: JSON.parse(init.body), headers: init.headers });
    return new Response("accepted", { status: 202 });
  };
  try {
    const result = await submit(coordinator(), workOrder());
    assert.equal(result.status, 202);
    assert.deepEqual(dispatches[0].body, workOrder());
    assert.equal(dispatches[0].headers.authorization, "Bearer dispatch");
    assert.equal(dispatches[0].headers["x-work-id"], "arena-shell");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("idempotency replays an identical request and rejects a fingerprint mismatch", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches += 1; return new Response("accepted", { status: 202 }); };
  try {
    const instance = coordinator();
    const first = await submit(instance, workOrder());
    const replay = await submit(instance, workOrder());
    const mismatch = await submit(instance, workOrder({ lane: "combat" }));
    assert.equal(first.status, 202);
    assert.equal(replay.status, 202);
    assert.equal(mismatch.status, 409);
    assert.equal((await body(mismatch)).error, "idempotency_key_reused_with_different_request");
    assert.equal(dispatches, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("independent work items in one encounter dispatch without a component-wide busy lock", async () => {
  const oldFetch = globalThis.fetch;
  const dispatched = [];
  let releaseDispatch;
  const bothStarted = new Promise((resolve) => { releaseDispatch = resolve; });
  let releaseResponses;
  const responsesReleased = new Promise((resolve) => { releaseResponses = resolve; });
  globalThis.fetch = async (_url, init) => {
    dispatched.push(JSON.parse(init.body).work_id);
    if (dispatched.length === 2) releaseDispatch();
    await responsesReleased;
    return new Response("accepted", { status: 202 });
  };
  try {
    const instance = coordinator();
    const submissions = Promise.all([
      submit(instance, workOrder(), "encounter-work-0001"),
      submit(instance, workOrder({ work_id: "combat-plan", lane: "combat", requested_provides: ["combat.attack"] }), "encounter-work-0002"),
    ]);
    await bothStarted;
    releaseResponses();
    const [first, second] = await submissions;
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.deepEqual(dispatched.sort(), ["arena-shell", "combat-plan"]);
    const status = await body(await instance.fetch(new Request("https://coordinator/status")));
    assert.equal(status.work_items.length, 2);
    assert.deepEqual(status.work_items.map((item) => item.status).sort(), ["queued", "queued"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a dispatch failure is durably replayed without a second external dispatch", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  globalThis.fetch = async () => { dispatches += 1; return new Response("unavailable", { status: 503 }); };
  try {
    const instance = coordinator();
    const first = await submit(instance, workOrder());
    const replay = await submit(instance, workOrder());
    assert.equal(first.status, 502);
    assert.equal(replay.status, 502);
    assert.equal(dispatches, 1);
    const blocked = (await body(replay)).work_item;
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.failure, { error_code: "work_dispatch_http_503", retryable: true });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a restarted coordinator recovers a journaled dispatch with the stable work ID", async () => {
  const oldFetch = globalThis.fetch;
  let dispatches = 0;
  let releaseFirstDispatch;
  const firstDispatchResponse = new Promise((resolve) => { releaseFirstDispatch = resolve; });
  let markFirstDispatch;
  const firstDispatchStarted = new Promise((resolve) => { markFirstDispatch = resolve; });
  globalThis.fetch = async () => {
    dispatches += 1;
    if (dispatches === 1) {
      markFirstDispatch();
      return firstDispatchResponse;
    }
    return new Response("accepted", { status: 202 });
  };
  try {
    const state = { storage: storage() };
    const original = new EncounterCoordinator(state, {
      WORK_DISPATCH_URL: "https://workers.example/dispatch",
      WORK_DISPATCH_TOKEN: "dispatch",
    });
    const interrupted = submit(original, workOrder());
    await firstDispatchStarted;
    const restarted = new EncounterCoordinator(state, {
      WORK_DISPATCH_URL: "https://workers.example/dispatch",
      WORK_DISPATCH_TOKEN: "dispatch",
    });
    const status = await body(await restarted.fetch(new Request("https://coordinator/status")));
    assert.equal(dispatches, 2);
    assert.equal(status.work_items[0].status, "queued");
    releaseFirstDispatch(new Response("accepted", { status: 202 }));
    await interrupted;
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("dependencies and resource leases defer work until the prerequisite completes", async () => {
  const oldFetch = globalThis.fetch;
  const dispatched = [];
  globalThis.fetch = async (_url, init) => { dispatched.push(JSON.parse(init.body).work_id); return new Response("accepted", { status: 202 }); };
  try {
    const instance = coordinator();
    await submit(instance, workOrder({ resource_leases: ["host.scene"] }));
    const dependent = await submit(instance, workOrder({
      work_id: "combat-plan",
      lane: "combat",
      requested_provides: ["combat.attack"],
      depends_on_work_ids: ["arena-shell"],
      resource_leases: ["host.scene"],
    }), "encounter-work-0002");
    assert.equal((await body(dependent)).work_item.status, "waiting");
    assert.deepEqual(dispatched, ["arena-shell"]);
    await appendEvent(instance, event("arena-shell", 0, "accepted"));
    await appendEvent(instance, event("arena-shell", 1, "started"));
    await appendEvent(instance, event("arena-shell", 2, "completed"));
    assert.deepEqual(dispatched.sort(), ["arena-shell", "combat-plan"]);
    const status = await body(await instance.fetch(new Request("https://coordinator/status")));
    assert.equal(status.work_items.find((item) => item.work_id === "combat-plan").status, "queued");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("worker events are append-only, ordered, and observable", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    assert.equal((await appendEvent(instance, event("arena-shell", 0, "accepted"))).status, 202);
    assert.equal((await appendEvent(instance, event("arena-shell", 1, "started"))).status, 202);
    const outOfOrder = await appendEvent(instance, event("arena-shell", 1, "heartbeat", { event_id: "event-duplicate-sequence" }));
    assert.equal(outOfOrder.status, 409);
    assert.equal((await body(outOfOrder)).error, "worker_event_out_of_order");
    const events = await body(await instance.fetch(new Request("https://coordinator/work-items/arena-shell/events")));
    assert.deepEqual(events.events.map((item) => item.kind), ["accepted", "started"]);
    assert.equal(events.work_item.status, "running");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("worker lifecycle prevents regressions and binds event attribution to the accepted worker", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const premature = await appendEvent(instance, event("arena-shell", 0, "progress"));
    assert.equal(premature.status, 409);
    assert.equal((await body(premature)).error, "illegal_worker_event_transition");
    await appendEvent(instance, event("arena-shell", 0, "accepted"));
    const wrongWorker = await appendEvent(instance, event("arena-shell", 1, "started", { worker_id: "worker-two" }));
    assert.equal(wrongWorker.status, 409);
    assert.equal((await body(wrongWorker)).error, "worker_identity_mismatch");
    await appendEvent(instance, event("arena-shell", 1, "started"));
    const regression = await appendEvent(instance, event("arena-shell", 2, "accepted"));
    assert.equal(regression.status, 409);
    assert.equal((await body(regression)).error, "illegal_worker_event_transition");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("a failed worker event is visible and terminal", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const failed = await appendEvent(instance, event("arena-shell", 0, "failed", { error_code: "worker_unavailable", retryable: true }));
    assert.equal(failed.status, 202);
    assert.deepEqual((await body(failed)).work_item.failure, { error_code: "worker_unavailable", retryable: true });
    const afterFailure = await appendEvent(instance, event("arena-shell", 1, "heartbeat"));
    assert.equal(afterFailure.status, 409);
    assert.equal((await body(afterFailure)).error, "work_item_terminal");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("freezing persists one immutable assembler-supplied package", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const packageToFreeze = playablePackage();
    const tampered = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify({ package: { ...packageToFreeze, manifest_sha256: "0".repeat(64) } }),
    }));
    assert.equal(tampered.status, 400);
    const firstFreeze = await instance.fetch(new Request("https://coordinator/freeze", { method: "POST", body: JSON.stringify(await freezeInputs(instance, packageToFreeze)) }));
    const frozen = await body(firstFreeze);
    const replayFreeze = await instance.fetch(new Request("https://coordinator/freeze", { method: "POST" }));
    assert.equal(firstFreeze.status, 201);
    assert.equal(replayFreeze.status, 200);
    assert.deepEqual(await body(replayFreeze), frozen);
    assert.equal(frozen.state, "frozen");
    assert.equal(frozen.package_id, packageToFreeze.package_id);
    assert.ok(frozen.frozen_at);
    assert.equal((await submit(instance, workOrder({ work_id: "late-work" }), "encounter-work-late")).status, 409);
    assert.equal((await appendEvent(instance, event("arena-shell", 0, "accepted"))).status, 409);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("freezing accepts only a hash-valid pre-frozen assembler package", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("accepted", { status: 202 });
  try {
    const instance = coordinator();
    await submit(instance, workOrder());
    const frozenPackage = freezeEncounterPackage(playablePackage(), "2026-09-08T19:35:00.000Z");
    const tampered = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify({ package: { ...frozenPackage, manifest_sha256: "0".repeat(64) } }),
    }));
    assert.equal(tampered.status, 400);
    const accepted = await instance.fetch(new Request("https://coordinator/freeze", {
      method: "POST",
      body: JSON.stringify(await freezeInputs(instance, frozenPackage)),
    }));
    assert.equal(accepted.status, 201);
    assert.deepEqual(await body(accepted), frozenPackage);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
