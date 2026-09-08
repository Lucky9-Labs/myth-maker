import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { BuildRoom, CoordinatorEventAdapter } from "./build-room.js";
import { planEncounterWork } from "./workgraph-planner.js";
import { EncounterDispatcher } from "./encounter-dispatcher.js";
import { LocalWorkerBackend } from "./local-worker-backend.js";
import { LocalBlenderSliceBackend } from "./local-blender-slice-backend.js";
import { assembleEncounterPackage, freezeEncounterPackage } from "./encounter-package-assembler.js";
import { createSqliteCatalog } from "./catalog-sqlite.js";
import { ingestGlbRuntimeCandidate } from "./glb-runtime-candidate-ingress.js";

export function createBuildRoomServer({ room = new BuildRoom(), persist = () => {}, catalog = createSqliteCatalog(), artifactRoot = ".local-blender-artifacts", blenderBackend = new LocalBlenderSliceBackend({ outputDir: artifactRoot }) } = {}) {
  if (!catalog || typeof catalog.projectionSummary !== "function") throw new TypeError("catalog must expose projectionSummary()");
  room.setCatalogProjection(() => catalog.projectionSummary());
  const adapter = new CoordinatorEventAdapter(room, { trustedObservation: (_input, request) => trustedObserver(request) });
  const absoluteArtifactRoot = existsSync(artifactRoot) ? realpathSync(artifactRoot) : resolve(artifactRoot);
  const streams = new Map();
  const buildStreams = new Set();
  room.subscribe((encounterId, snapshot) => {
    for (const response of streams.get(encounterId) || []) stream(response, snapshot);
    for (const response of buildStreams) stream(response, room.buildIndex());
  });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") return html(response);
      if (request.method === "GET" && url.pathname === "/favicon.ico") { response.writeHead(204); return response.end(); }
      if (request.method === "GET" && url.pathname.startsWith("/generated/")) return generatedArtifact(response, absoluteArtifactRoot, url.pathname.slice("/generated/".length));
      if (request.method === "GET" && url.pathname === "/api/health") return json(response, 200, { status: "ok", encounters: room.list().length });
      if (request.method === "GET" && url.pathname === "/api/builds") return json(response, 200, room.buildIndex());
      if (request.method === "GET" && url.pathname === "/api/builds/stream") {
        const projection = room.buildIndex();
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        buildStreams.add(response);
        stream(response, projection);
        request.on("close", () => buildStreams.delete(response));
        return;
      }
      const steerMatch = url.pathname.match(/^\/api\/builds\/([^/]+)\/steer$/);
      if (request.method === "POST" && steerMatch) {
        const receipt = room.steer(steerMatch[1], await body(request));
        persist(room);
        return json(response, 202, receipt);
      }
      const buildMatch = url.pathname.match(/^\/api\/builds\/([^/]+)$/);
      if (request.method === "GET" && buildMatch) return json(response, 200, room.buildDetail(buildMatch[1]));
      if (request.method === "POST" && url.pathname === "/api/ingest/steering") {
        const receipt = room.recordSteering(await body(request), { trusted: trustedObserver(request) });
        persist(room);
        return json(response, 201, receipt);
      }
      if (request.method === "POST" && url.pathname === "/api/encounters") {
        const run = room.submit(await body(request));
        persist(room);
        if (!run.deduplicated) launchLocalBuild(room, run, persist, catalog, blenderBackend, absoluteArtifactRoot).catch((error) => recordLocalFailure(room, run, error, persist));
        return json(response, run.deduplicated ? 200 : 201, run);
      }
      const freezeMatch = url.pathname.match(/^\/api\/encounters\/([^/]+)\/freeze$/);
      if (request.method === "POST" && freezeMatch) {
        const snapshot = freezeCurrentPackage(room, freezeMatch[1]);
        persist(room);
        return json(response, 201, snapshot);
      }
      const upgradeMatch = url.pathname.match(/^\/api\/encounters\/([^/]+)\/upgrades$/);
      if (request.method === "POST" && upgradeMatch) {
        const upgrade = room.requestNextUpgrade(upgradeMatch[1], await body(request));
        persist(room);
        if (!upgrade.deduplicated) {
          launchLocalBuild(room, upgrade, persist, catalog, blenderBackend, absoluteArtifactRoot, upgrade.upgrade.revision)
            .catch((error) => recordLocalFailure(room, upgrade, error, persist, upgrade.upgrade.revision));
        }
        return json(response, upgrade.deduplicated ? 200 : 202, upgrade);
      }
      const streamMatch = url.pathname.match(/^\/api\/encounters\/([^/]+)\/stream$/);
      if (request.method === "GET" && streamMatch) {
        const encounterId = streamMatch[1];
        room.requireRun(encounterId);
        const projection = room.snapshot(encounterId);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const group = streams.get(encounterId) || new Set();
        group.add(response);
        streams.set(encounterId, group);
        stream(response, projection);
        request.on("close", () => { group.delete(response); if (group.size === 0) streams.delete(encounterId); });
        return;
      }
      const match = url.pathname.match(/^\/api\/encounters\/([^/]+)$/);
      if (request.method === "GET" && match) {
        const snapshot = room.snapshot(match[1]);
        const after = url.searchParams.get("after");
        return json(response, 200, { ...snapshot, events: room.replay(match[1], after || undefined) });
      }
      if (request.method === "POST" && ["/api/ingest/coordinator", "/api/ingest/dispatcher"].includes(url.pathname)) {
        const event = adapter.ingest(await body(request), request);
        persist(room);
        return json(response, 201, event);
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (response.headersSent) return response.destroy();
      return json(response, error instanceof RangeError ? 404 : 400, { error: error.message });
    }
  });
  return server;
}

async function launchLocalBuild(room, run, persist, catalog, blenderBackend, artifactRoot, revision = 1) {
  const spec = localSpec(run.ids.encounterId, run.seed, revision, run.compile_profile, run.deadline_at);
  const graph = planEncounterWork(spec);
  const localBackend = new LocalWorkerBackend({ workDurationMs: 5 });
  const backend = {
    launch(order, options) {
      return run.generate_asset && order.lane === "body-source" ? blenderBackend.launch(order, { ...options, revision }) : localBackend.launch(order, options);
    },
  };
  const dispatcher = new EncounterDispatcher({ backend });
  let result;
  try {
    result = await dispatcher.dispatch(graph);
  } catch (error) {
    const rootOrders = graph.work_orders.filter((order) => !(order.depends_on_work_ids || []).length);
    const rootReceipts = await Promise.all(rootOrders.map((order) => dispatcher.lookup(order.work_id)));
    if (rootReceipts.some((receipt) => !receipt)) throw error;
    result = {
      encounter_id: graph.encounter_id,
      receipts: rootReceipts,
      events: rootReceipts.flatMap((receipt) => receipt.events),
      deduplicated_work_ids: [],
      recovered_with_baseline_fallback: true,
    };
  }
  const bodyOrder = graph.work_orders.find((order) => order.lane === "body-source");
  const manifest = run.generate_asset ? blenderBackend.resultFor(bodyOrder.work_id) : undefined;
  const candidate = manifest ? ingestGlbRuntimeCandidate({ module: manifest.module, loaderProfile: manifest.loader_profile }) : undefined;
  const animationCandidate = manifest ? bindEmbeddedAnimationCandidate(manifest, candidate) : undefined;
  if (manifest) {
    const priorAsset = catalog.getAsset(manifest.asset_id);
    if (priorAsset) catalog.appendAssetRevision(catalogAsset(manifest, priorAsset));
    else catalog.createAsset(catalogAsset(manifest));
    const priorAnimation = catalog.getAnimation(manifest.animation.animation_id);
    if (priorAnimation) catalog.appendAnimationRevision(catalogAnimation(manifest, priorAnimation));
    else catalog.createAnimation(catalogAnimation(manifest));
  }
  for (const order of graph.work_orders) {
    for (const event of result.events.filter((candidate) => candidate.work_id === order.work_id)) {
      const isBlender = order.lane === "body-source" && event.worker_id.startsWith("blender-cli-");
      const projected = room.record(run.ids.encounterId, {
        eventId: event.event_id, workerId: event.worker_id, sequence: event.sequence, occurredAt: event.occurred_at,
        kind: event.kind, message: event.message,
        ...(isBlender && manifest && event.kind === "candidate_produced" ? { artifact: artifactRevision(manifest, artifactUrl(artifactRoot, manifest.visual.path)) } : {}),
        evidence: isBlender
          ? manifest
            ? { kind: "local_blender_cli", receipt: { ...manifest.worker_receipt, work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at, source: manifest.source, runtime: manifest.runtime, visual: manifest.visual, source_inspection: manifest.source_inspection, embedded_animation: manifest.animation.embedded_glb, concept_first_lineage: manifest.concept_first_lineage, manifest_path: manifest.manifest_path } }
            : { kind: "local_blender_cli_failed", receipt: { work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at, failure: event.message, note: "Local Blender CLI failed; assembler retained the baseline fallback." } }
          : { kind: "local_process", receipt: { work_id: order.work_id, worker_id: event.worker_id, observed_at: event.occurred_at } },
      });
      room.upsertWork(run.ids.encounterId, order, projected);
    }
  }
  if (result.recovered_with_baseline_fallback) {
    const skipped = graph.work_orders.find((order) => order.lane === "validation");
    const projected = room.record(run.ids.encounterId, {
      workerId: "local-dispatcher", sequence: 0, kind: "cancelled", occurredAt: new Date().toISOString(),
      message: "Validation lane skipped because a prerequisite failed; assembler retained the declared baseline fallback.",
      evidence: { kind: "local_process", receipt: { process: "encounter-dispatcher", observed_at: new Date().toISOString() } },
    });
    room.upsertWork(run.ids.encounterId, skipped, projected);
  }
  const packageId = `package-${run.ids.encounterId.slice(-24)}`;
  const priorPackage = room.snapshot(run.ids.encounterId).packages.filter((entry) => entry.package_id === packageId).at(-1)?.package_record;
  const packageResult = assembleEncounterPackage({
    host: spec.host_capabilities,
    encounterId: run.ids.encounterId,
    packageId,
    baselineModules: baselineModules(run.ids.encounterId),
    candidateModules: candidate && animationCandidate ? [candidate.module, animationCandidate.module] : [],
    previousPackage: priorPackage,
    assembledAt: new Date().toISOString(),
  });
  room.record(run.ids.encounterId, {
    workerId: "local-assembler", sequence: 0, kind: "completed", occurredAt: new Date().toISOString(),
    message: candidate && animationCandidate ? `Local assembler re-evaluated encounter package revision ${packageResult.package.revision} and selected checked local Blender body and embedded-animation candidates; host-game acceptance remains absent.` : "Local assembler preserved the compatible baseline fallback after terminal worker receipts.",
    package: {
      package_id: packageResult.package.package_id,
      revision: packageResult.package.revision,
      state: packageResult.package.state,
      selection: packageResult.package.module_ids,
      fallback: packageResult.package.fallback_provenance,
      rejections: packageResult.rejections,
      manifest_sha256: packageResult.package.manifest_sha256,
      package_record: packageResult.package,
      assembly_receipt: assemblyReceipt(packageResult.package, manifest, priorPackage),
      outcomes: packageOutcomes(packageResult.package, packageResult.rejections),
    },
    evidence: { kind: "local_process", receipt: { process: "encounter-package-assembler", observed_at: new Date().toISOString() } },
  });
  if (run.freeze_current_package) freezeCurrentPackage(room, run.ids.encounterId);
  if (revision > 1) {
    room.record(run.ids.encounterId, {
      workerId: "local-coordinator", sequence: revision + 1000, kind: "completed", occurredAt: new Date().toISOString(),
      message: `Local coordinator re-evaluated the same encounter, selected package revision ${packageResult.package.revision}, and preserved package revision ${revision - 1} as immutable fallback history.`,
      evidence: { kind: "local_process", receipt: { process: "local-encounter-coordinator", upgrade_revision: revision, package_manifest_sha256: packageResult.package.manifest_sha256, observed_at: new Date().toISOString() } },
    });
    room.completeUpgrade(run.ids.encounterId, revision);
  }
  persist(room);
}

function assemblyReceipt(packageRecord, manifest, previousPackage = undefined) {
  const withoutHash = {
    schema_version: "1",
    receipt_id: `assembly-${packageRecord.package_id.slice(-40)}`,
    package_id: packageRecord.package_id,
    package_revision: packageRecord.revision,
    package_manifest_sha256: packageRecord.manifest_sha256,
    assembled_at: packageRecord.assembled_at,
    selected_modules: manifest ? [{
      module_id: manifest.module.module_id,
      revision: manifest.module.revision,
      artifact_sha256: manifest.runtime.sha256,
    }, {
      module_id: manifest.animation.module.module_id,
      revision: manifest.animation.module.revision,
      artifact_sha256: manifest.animation.module.artifact.sha256,
      binding: manifest.animation.rig_binding,
    }] : packageRecord.module_ids.map((module_id) => ({ module_id, revision: 1, artifact_sha256: null })),
    fallback_provenance: packageRecord.fallback_provenance,
    validation: manifest ? [{
      kind: "glb.v1-checked",
      status: "passed",
      artifact_sha256: manifest.runtime.sha256,
      evidence_scope: "local_blender_cli_only",
    }, {
      kind: "embedded-glb-animation",
      status: manifest.animation.embedded_glb.status,
      artifact_sha256: manifest.animation.module.artifact.sha256,
      evidence_scope: "local_blender_cli_only",
      target_channel_count: manifest.animation.embedded_glb.target_channel_count,
    }] : [{ kind: "baseline-contract", status: "passed", artifact_sha256: null, evidence_scope: "local_process_only" }],
    concept_first_lineage: manifest ? {
      enforcement: "bootstrap-waiver-not-runtime-enforced",
      lineage: manifest.concept_first_lineage,
    } : undefined,
    host_acceptance: "not_observed",
    ...(previousPackage ? { preserved_fallback_history: { package_revision: previousPackage.revision, package_manifest_sha256: previousPackage.manifest_sha256 } } : {}),
  };
  return { ...withoutHash, receipt_sha256: createHash("sha256").update(JSON.stringify(withoutHash)).digest("hex") };
}

function catalogAsset(manifest, prior = undefined) {
  return {
    assetId: manifest.asset_id, revision: prior ? prior.revision : 1, createdAt: manifest.created_at,
    functionalTags: ["body.generated"], aestheticTags: ["aesthetic.ocean.demo"],
    compatibility: { platforms: ["local"], loaders: ["gltf", "urp"], contracts: ["encounter-module.v1"], bindingIds: [] },
    sourceReceipt: { receiptId: `${manifest.work_id}-source-${manifest.source.artifact.sha256.slice(0, 16)}`, uri: manifest.source.artifact.uri, sha256: manifest.source.artifact.sha256, receivedAt: manifest.created_at },
    runtimeArtifact: { uri: manifest.runtime.uri, sha256: manifest.runtime.sha256, mediaType: manifest.runtime.media_type, byteLength: manifest.runtime.byte_length },
    visualArtifact: { uri: `sha256:${manifest.visual.sha256}`, sha256: manifest.visual.sha256, mediaType: manifest.visual.media_type, byteLength: manifest.visual.byte_length },
    sourceAcceptanceState: "accepted", runtimeAcceptanceState: "candidate",
    conceptFirstLineage: manifest.concept_first_lineage,
    provenance: { producer: "local-blender-cli", createdAt: manifest.created_at, label: "newly-produced-local-blender", ...(prior ? { parentRefs: [{ domain: "asset", stableId: prior.assetId, revision: prior.revision, contentSha256: prior.contentSha256 }] } : {}) },
  };
}

function catalogAnimation(manifest, prior = undefined) {
  const animation = manifest.animation;
  return {
    animationId: animation.animation_id, revision: prior ? prior.revision : 1, createdAt: manifest.created_at,
    kind: animation.kind, durationMs: animation.duration_ms,
    functionalTags: ["animation.generated", "animation.embedded-glb", "body.generated"], aestheticTags: ["aesthetic.ocean.demo"],
    compatibility: { platforms: ["local"], loaders: ["gltf", "urp", "animation.binding.encounter-body.v1"], contracts: ["encounter-module.v1"], bindingIds: [animation.rig_binding.rig_binding_id] },
    rigBinding: { rigBindingId: animation.rig_binding.rig_binding_id, modelBindingId: animation.rig_binding.model_binding_id },
    sourceReceipt: { receiptId: `${manifest.work_id}-animation-source-${manifest.source.artifact.sha256.slice(0, 16)}`, uri: manifest.source.artifact.uri, sha256: manifest.source.artifact.sha256, receivedAt: manifest.created_at },
    runtimeArtifact: { uri: manifest.runtime.uri, sha256: manifest.runtime.sha256, mediaType: manifest.runtime.media_type, byteLength: manifest.runtime.byte_length },
    sourceAcceptanceState: "accepted", runtimeAcceptanceState: "candidate",
    conceptFirstLineage: manifest.concept_first_lineage,
    provenance: { producer: "local-blender-animation-export", createdAt: manifest.created_at, label: "embedded-glb-animation", ...(prior ? { parentRefs: [{ domain: "animation", stableId: prior.animationId, revision: prior.revision, contentSha256: prior.contentSha256 }] } : {}) },
  };
}

function artifactRevision(manifest, thumbnailUrl) {
  return { artifact_id: manifest.asset_id, revision: manifest.revision, source_sha256: manifest.source.artifact.sha256,
    runtime_sha256: manifest.runtime.sha256, visual_sha256: manifest.visual.sha256, profile: manifest.loader_profile.profile, thumbnail_url: thumbnailUrl,
    origin: "newly-produced-local-blender", acceptance: "host-unaccepted-candidate" };
}

function artifactUrl(root, path) { return `/generated/${encodeURIComponent(relative(root, path).split(sep).join("/"))}`; }

function recordLocalFailure(room, run, error, persist, revision = undefined) {
  room.record(run.ids.encounterId, { workerId: "local-dispatcher", sequence: 0, kind: "failed", occurredAt: new Date().toISOString(), message: `Local dispatcher failed: ${error.message}`, evidence: { kind: "local_process", receipt: { process: "encounter-dispatcher", observed_at: new Date().toISOString() } } });
  if (revision) room.completeUpgrade(run.ids.encounterId, revision);
  persist(room);
}

function localSpec(encounterId, seed = 1, attempt = 1, compileProfile = "standard", deadlineAt = "2026-12-31T00:00:00Z") {
  const desiredRoles = compileProfile === "high_fanout" ? ["pressure", "support", "control"] : ["pressure"];
  return { schema_version: "2", encounter_id: encounterId, seed, attempt, deadline_at: deadlineAt, host_capabilities: { schema_version: "1", host_id: "local-build-room", host_build: "local-blender-v1", platform: "local", scripting_backend: "il2cpp", execution_kinds: ["recipe", "runtime_asset"], loaders: ["gltf", "urp", "animation.binding.encounter-body.v1"], contracts: ["encounter-module.v1"], limits: { memory_mb: 1024, preload_seconds: 30, artifact_bytes: 50000000 } }, objective: { kind: "survive", parameters: {} }, arena_envelope: { bounds: { width: 1, height: 1, depth: 1 }, navigation_profiles: ["ground"] }, desired_roles: desiredRoles, production_gate: bootstrapProductionGate() };
}

function bootstrapProductionGate() {
  return { kind: "bootstrap_waiver", waiver: { kind: "bootstrap_waiver", bounded_reason: "The D0 local Blender path predates concept-first lineage and remains pre-gate bootstrap evidence only.", approver: "local-demo-owner", approved_at: "2026-09-08T00:00:00Z", expires_at: "2026-12-31T00:00:00Z", requested_provides: ["encounter.body.source", "encounter.body.segment.source", "encounter.critical-spot.module", "encounter.motion.clip", "encounter.material.binding", "encounter.arena.envelope", "encounter.combat.recipe", "encounter.assembly.receipt", "encounter.validation.report"], not_concept_compliant: true } };
}

function baselineModules(encounterId) {
  return [
    { schema_version: "1", module_id: `baseline-${encounterId.slice(-24)}`, revision: 1, execution_kind: "recipe", provides: ["encounter.body"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "known-playable-baseline" }, fallback_module_ids: [] },
    { schema_version: "1", module_id: `baseline-animation-${encounterId.slice(-14)}`, revision: 1, execution_kind: "recipe", provides: ["encounter.animation"], requires: [], conflicts: [], compatibility: { host_contract_version: "1" }, quality: { tier: 0, score: 1 }, inline_recipe: { kind: "known-playable-animation-baseline" }, fallback_module_ids: [] },
  ];
}

function bindEmbeddedAnimationCandidate(manifest, bodyCandidate) {
  const animation = manifest?.animation;
  if (!animation?.module || !bodyCandidate?.module || animation.module.execution_kind !== "runtime_asset"
    || animation.module.artifact?.sha256 !== bodyCandidate.module.artifact?.sha256
    || animation.module.compatibility?.bindings?.[animation.rig_binding?.rig_binding_id] !== bodyCandidate.module.module_id
    || animation.embedded_glb?.status !== "passed" || animation.embedded_glb?.target_channel_count < 1) {
    throw new TypeError("embedded animation candidate is not bound to the checked body runtime artifact");
  }
  return { module: structuredClone(animation.module), binding: structuredClone(animation.rig_binding) };
}

function packageOutcomes(packageRecord, rejections) {
  return {
    selected: [...packageRecord.module_ids],
    rejected: rejections.map((rejection) => ({ module_id: rejection.module_id, reasons: [...rejection.reasons] })),
    fallback: structuredClone(packageRecord.fallback_provenance),
  };
}

function freezeCurrentPackage(room, encounterId) {
  const snapshot = room.snapshot(encounterId);
  const current = snapshot.packages.at(-1);
  if (!current?.package_record) throw new TypeError("a current package is required before freezing");
  if (current.package_record.state === "frozen") return snapshot;
  const frozenAt = new Date().toISOString();
  const frozen = freezeEncounterPackage(current.package_record, frozenAt);
  room.record(encounterId, {
    workerId: "local-assembler",
    sequence: 1,
    kind: "completed",
    occurredAt: frozenAt,
    message: `Local assembler froze current package revision ${frozen.revision}; later candidates cannot replace this package snapshot.`,
    package: {
      ...current,
      state: frozen.state,
      selection: [...frozen.module_ids],
      fallback: structuredClone(frozen.fallback_provenance),
      manifest_sha256: frozen.manifest_sha256,
      package_record: frozen,
      outcomes: packageOutcomes(frozen, current.rejections || []),
      freeze_receipt: {
        source: "local_process",
        observed_at: frozenAt,
        package_id: frozen.package_id,
        revision: frozen.revision,
        manifest_sha256: frozen.manifest_sha256,
        frozen_from_assembly_receipt_sha256: current.assembly_receipt?.receipt_sha256,
      },
    },
    evidence: { kind: "local_process", receipt: { process: "encounter-package-assembler", observed_at: frozenAt, action: "freeze-current-package", package_manifest_sha256: frozen.manifest_sha256 } },
  });
  return room.snapshot(encounterId);
}

function generatedArtifact(response, root, encodedRelativePath) {
  const relativePath = decodeURIComponent(encodedRelativePath);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path)) return json(response, 404, { error: "generated_artifact_not_found" });
  const type = path.endsWith(".png") ? "image/png" : path.endsWith(".glb") ? "model/gltf-binary" : "application/octet-stream";
  response.writeHead(200, { "content-type": type, "cache-control": "immutable" });
  response.end(readFileSync(path));
}

export function loadBuildRoom(statePath) {
  const room = new BuildRoom();
  if (!existsSync(statePath)) return room;
  return room.restore(JSON.parse(readFileSync(statePath, "utf8")));
}

export function persistBuildRoom(statePath, room) {
  const absolutePath = resolve(statePath);
  const temporaryPath = `${absolutePath}.next`;
  const state = JSON.stringify(room.exportState());
  writeFileSync(temporaryPath, state, "utf8");
  renameSync(temporaryPath, absolutePath);
}

function trustedObserver(request) {
  const token = process.env.BUILD_ROOM_OBSERVER_TOKEN;
  return Boolean(token) && request.headers.get("x-build-room-observer-token") === token;
}

function stream(response, snapshot) {
  if (response.destroyed || response.writableEnded) return;
  try {
    response.write(`event: projection\ndata: ${JSON.stringify(snapshot)}\n\n`);
  } catch {
    // A disconnected EventSource is not an API failure and must not take down the viewer.
  }
}

function body(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let received = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > 100_000) {
        if (!rejected) reject(new TypeError("request body too large"));
        rejected = true;
        request.resume();
        return;
      }
      if (!rejected) raw += chunk;
    });
    request.on("end", () => {
      if (rejected) return;
      try { resolve(JSON.parse(raw || "{}")); } catch { reject(new TypeError("invalid JSON")); }
    });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function html(response) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(PAGE.replace("<!-- client -->", CLIENT_SCRIPT));
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Myth Maker Build Room</title>
<style>
  :root { color-scheme: dark; font-family: Inter, Avenir Next, Avenir, ui-sans-serif, system-ui, sans-serif; background: #07101f; color: #e4f3f4; }
  * { box-sizing: border-box; } body { max-width: 1440px; min-height: 100vh; margin: 0 auto; padding: clamp(18px, 4vw, 54px); background: radial-gradient(circle at 52% 7%, #123d56 0, transparent 30rem), #07101f; }
  h1, h2, h3, p { margin-top: 0; } h1 { font-size: clamp(1.4rem, 3vw, 2.3rem); letter-spacing: -.04em; } h2 { font-size: 1.05rem; letter-spacing: -.02em; } .muted { color: #91a9b8; }
  .masthead { display: flex; align-items: baseline; justify-content: space-between; gap: 24px; margin-bottom: 28px; } .quiet { font-size: .82rem; color: #91a9b8; }
  .composer { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 16px; padding: 16px; margin-bottom: 26px; border: 1px solid #22516b; background: rgba(7, 22, 39, .88); box-shadow: 0 18px 50px rgba(0, 0, 0, .22); }
  .composer label { display: block; font-size: .84rem; color: #b7d7df; } textarea { width: 100%; min-height: 56px; margin-top: 8px; resize: vertical; background: #07111d; color: inherit; border: 1px solid #35657a; padding: 11px; font: inherit; } textarea:focus-visible, button:focus-visible, summary:focus-visible, a:focus-visible { outline: 3px solid #8effec; outline-offset: 3px; }
  .form-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; } .form-actions label { color: #91a9b8; white-space: nowrap; } button { padding: 11px 16px; border: 1px solid #83e7dc; background: #a0fff2; color: #06202a; font: 700 .9rem/1 inherit; cursor: pointer; } button:hover { background: #cbfff8; }
  .loop-panel { position: relative; padding: clamp(16px, 3vw, 32px); overflow-x: auto; border: 1px solid #214e68; background: linear-gradient(120deg, rgba(12, 42, 62, .9), rgba(4, 15, 29, .95)); }
  .loop-flow { display: flex; align-items: stretch; min-width: 1100px; padding: 4px 0 18px; } .loop-edge { position: relative; width: clamp(24px, 3vw, 48px); flex: 0 0 clamp(24px, 3vw, 48px); align-self: center; height: 2px; background: #3d7787; opacity: .78; } .loop-edge::after { content: ""; position: absolute; right: -1px; top: -4px; border: 5px solid transparent; border-left-color: #86f4e9; }
  .loop-node { position: relative; z-index: 1; display: flex; flex: 1 0 125px; min-height: 180px; flex-direction: column; border: 1px solid #315e73; background: rgba(4, 17, 31, .78); } .loop-node.current { border-color: #78e8e1; box-shadow: 0 0 0 1px #4cc8c6, 0 0 28px rgba(74, 221, 214, .30); } .loop-node.absent, .loop-node.pending { border-style: dashed; border-color: #355265; background: rgba(7, 18, 31, .42); } .node-head { display: flex; justify-content: space-between; gap: 8px; padding: 10px; border-bottom: 1px solid #234d63; } .node-head h2 { margin: 0; font-size: .9rem; } .glyph { color: #9affef; } .absent .glyph, .pending .glyph { color: #69818d; } .node-body { display: grid; flex: 1; place-items: center; min-height: 86px; overflow: hidden; color: #a7d3d6; font-size: .82rem; text-align: center; } .node-body img { display: block; width: 100%; height: 104px; object-fit: cover; } .node-foot { min-height: 42px; padding: 8px 10px; border-top: 1px solid #234d63; color: #9fc7ce; font-size: .75rem; } .absent .node-foot, .pending .node-foot { color: #647b88; }
  .loop-meta { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; padding-top: 14px; color: #9bb8c4; font-size: .82rem; } .loop-meta strong { color: #bdfcf3; } .quiet-lanes { display: flex; gap: 10px; flex-wrap: wrap; } .quiet-lane { color: #647b88; font-size: .76rem; } .lane-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px; margin-top: 15px; } .lane-card { padding: 9px; border: 1px solid #315e73; background: rgba(4, 17, 31, .55); color: #a9c8ce; font-size: .76rem; } .lane-card strong { color: #c8f5f0; } .lane-card code { display: block; margin-top: 4px; } .loop-gates { display: flex; gap: 10px; margin-top: 13px; } .loop-gates .loop-node { flex: 0 1 230px; min-height: 72px; } .loop-gates .node-body { display: none; } .loop-gates .node-foot { min-height: auto; border-top: 0; }
  details.drawer { margin-top: 22px; border-top: 1px solid #31586c; border-bottom: 1px solid #31586c; background: rgba(3, 14, 27, .66); } summary { padding: 14px 4px; cursor: pointer; color: #c8f5f0; font-weight: 650; } .drawer-body { padding: 4px 4px 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 22px; } .drawer-body h3 { margin-bottom: 8px; color: #a1e9e3; } .drawer-body ul { margin: 0; padding-left: 18px; } .drawer-body li { margin: 6px 0; color: #acc2cc; } code { color: #a8fcf0; overflow-wrap: anywhere; font-size: .8rem; }
  .build-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; } .build-link { display: block; padding: 14px; border: 1px solid #315e73; color: inherit; text-decoration: none; background: rgba(4, 18, 32, .65); } .build-link:hover { border-color: #82eade; } .empty-note { padding: 30px 4px; color: #819aa7; }
  @media (max-width: 800px) { .composer { grid-template-columns: 1fr; } .loop-panel { margin-inline: -4px; } .loop-meta, .masthead { align-items: flex-start; flex-direction: column; gap: 8px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; } }
</style>
<body>
  <header class="masthead"><div><h1>Myth Maker / Build Room</h1><p class="muted">Compose a playable encounter from observed pieces.</p></div><span class="quiet">D0 assembly surface</span></header>
  <form id="submit" class="composer"><label for="prompt">What should this encounter do?<textarea id="prompt" required placeholder="Describe the encounter to assemble…"></textarea></label><div class="form-actions"><label><input id="generate-asset" type="checkbox" checked> Include local render</label><label><input id="high-fanout" type="checkbox"> High-fanout compile</label><label>Deadline <input id="deadline-seconds" type="number" min="1" max="86400" value="1800"> sec</label><label><input id="freeze-current-package" type="checkbox"> Freeze current package</label><button>Assemble encounter</button></div></form>
  <main id="empty">Preparing assembly table…</main>
  <script><!-- client --></script>
</body>
</html>`;

const CLIENT_SCRIPT = String.raw`
  const main = document.querySelector("main");
  let active;
  let activeRequest;
  let activeSource;
  let dashboardSource;
  const labels = {
    fixture: "Simulated fixture (not live)",
    local_process: "Local process receipt (observed)",
    local_blender_cli: "Local Blender CLI evidence (observed)",
    local_blender_cli_failed: "Local Blender CLI failure (observed local process)",
    adapter_reported: "Coordinator/dispatcher report (unverified)",
    modal_remote: "Modal remote receipt (observed)",
    blender_window: "Blender window/screenshot/stream (observed)",
  };

  document.querySelector("#submit").addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = document.querySelector("#prompt").value;
    const response = await fetch("/api/encounters", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, generate_asset: document.querySelector("#generate-asset").checked, compile_profile: document.querySelector("#high-fanout").checked ? "high_fanout" : "standard", deadline_seconds: Number(document.querySelector("#deadline-seconds").value), freeze_current_package: document.querySelector("#freeze-current-package").checked }),
    });
    const run = await response.json();
    if (!response.ok) return alert(run.error);
    active = run.ids.encounterId;
    activeRequest = run.ids.requestId;
    history.pushState({}, "", "/?build=" + encodeURIComponent(run.ids.requestId));
    render(run);
    watch(active);
    document.querySelector("#prompt").value = "";
  });

  function esc(value) { const node = document.createElement("div"); node.textContent = String(value ?? ""); return node.innerHTML; }
  function json(value) { return esc(JSON.stringify(value, null, 2)); }
  function statusGlyph(status) { return { completed: "✓", active: "●", blocked: "×", pending: "○", absent: "○" }[status] || "○"; }
  function stateLabel(status) { return { completed: "complete", active: "active", blocked: "blocked", pending: "pending", absent: "absent" }[status] || "absent"; }
  function latestRevision(rows) { return rows && rows.length ? [...rows].sort((a, b) => a.revision - b.revision).at(-1) : undefined; }
  function bodyRevisions(run) { return run ? run.artifacts.filter((artifact) => artifact.thumbnail_url) : []; }
  function workerState(run, lane) {
    const work = run && run.topology.work_graph.find((entry) => entry.lane === lane);
    if (!work) return "pending";
    return work.status === "completed" ? "completed" : work.status === "failed" ? "blocked" : "active";
  }
  function loopNode(title, status, body, foot, current) {
    return "<article class=\"loop-node " + esc(status) + (current ? " current" : "") + "\"><header class=\"node-head\"><h2>" + esc(title) + "</h2><span class=\"glyph\" aria-label=\"" + esc(stateLabel(status)) + "\">" + statusGlyph(status) + "</span></header><div class=\"node-body\">" + body + "</div><footer class=\"node-foot\">" + foot + "</footer></article>";
  }
  function edge() { return "<span class=\"loop-edge\" aria-hidden=\"true\"></span>"; }
  function quietLane(run, label, lane) {
    const count = run ? run.topology.work_graph.filter((entry) => entry.lane === lane || entry.lane.startsWith(lane + "-")).length : 0;
    return "<span class=\"quiet-lane\">" + esc(label) + " · " + (count ? count + " lane receipt" + (count === 1 ? "" : "s") : "no lane receipt") + "</span>";
  }
  function clock(seconds) { const value = Math.max(0, Math.ceil(seconds)); return Math.floor(value / 60) + "m " + String(value % 60).padStart(2, "0") + "s"; }
  function deadlineTimer(run) { return run ? "<span data-role=\"deadline-timer\" data-deadline=\"" + esc(run.deadline_at) + "\">Deadline timer: " + clock(run.remaining_seconds) + " remaining</span>" : "<span>Deadline timer starts with a request.</span>"; }
  function refreshDeadlineTimers() { document.querySelectorAll("[data-role=deadline-timer]").forEach((node) => { const seconds = (Date.parse(node.dataset.deadline) - Date.now()) / 1000; node.textContent = "Deadline timer: " + clock(seconds) + " remaining"; }); }
  function laneCards(run) {
    if (!run || !run.topology.work_graph.length) return "<span class=\"quiet-lane\">No lane receipts yet.</span>";
    return run.topology.work_graph.map((work) => "<article class=\"lane-card\"><strong>" + esc(work.lane) + " · " + esc(work.status) + "</strong><code>Component: " + esc(work.component) + "</code><code>Worker: " + esc(work.worker_id) + "</code></article>").join("");
  }
  function assembly(run) {
    const artifacts = bodyRevisions(run);
    const body = latestRevision(artifacts);
    const revisionOne = artifacts.find((artifact) => artifact.revision === 1) || body;
    const revisionTwo = artifacts.find((artifact) => artifact.revision === 2);
    const packageRevision = run && latestRevision(run.packages);
    const packageFrozen = packageRevision && packageRevision.state === "frozen";
    const latestRevisionNumber = body && body.revision;
    const hasRevisionTwo = Boolean(revisionTwo || latestRevisionNumber >= 2);
    const allWorkComplete = run && run.topology.work_graph.length > 0 && run.topology.work_graph.every((work) => work.status === "completed");
    const plannerStatus = !run ? "pending" : allWorkComplete ? "completed" : "active";
    const blenderStatus = body ? "completed" : workerState(run, "body-source");
    const catalogStatus = body ? "completed" : "pending";
    const revisionStatus = hasRevisionTwo ? "completed" : run && run.upgrade?.active ? "active" : "pending";
    const packageStatus = packageRevision ? "completed" : "pending";
    const unityReceipt = packageRevision && packageRevision.assembly_receipt;
    const unityStatus = unityReceipt && unityReceipt.host_acceptance === "not_observed" ? "absent" : "pending";
    const nodes = [
      loopNode("Coordinator / planner", plannerStatus, "<span>local orchestration</span>", run ? "request projected" : "awaiting request", Boolean(run)),
      loopNode("Blender body" + (revisionOne ? " · r" + revisionOne.revision : ""), blenderStatus, revisionOne ? "<img data-role=\"observed-thumbnail\" src=\"" + esc(revisionOne.thumbnail_url) + "\" alt=\"Observed local render for body revision " + esc(revisionOne.revision) + "\">" : "<span>no candidate yet</span>", revisionOne ? "local CLI candidate" : "body-source lane", Boolean(revisionOne)),
      loopNode("Immutable catalog" + (revisionOne ? " · r" + revisionOne.revision : ""), catalogStatus, revisionOne ? "<span class=\"glyph\" aria-hidden=\"true\">◆</span>" : "<span>no asset receipt</span>", revisionOne ? "asset revision recorded" : "awaiting artifact", Boolean(revisionOne)),
      loopNode(hasRevisionTwo ? "Next revision / Blender · r2" : "Request next revision", revisionStatus, hasRevisionTwo ? "<img src=\"" + esc(revisionTwo.thumbnail_url) + "\" alt=\"Observed local render for body revision 2\">" : "<span>bounded local upgrade</span>", hasRevisionTwo ? "Blender revision observed" : run && run.upgrade?.active ? "worker running" : "ready after package r1", hasRevisionTwo || Boolean(run && run.upgrade?.active)),
      loopNode("Catalog asset" + (revisionTwo ? " · r" + revisionTwo.revision : " · r2"), revisionTwo ? "completed" : "pending", revisionTwo ? "<span class=\"glyph\" aria-hidden=\"true\">◆</span>" : "<span>awaiting revision 2</span>", revisionTwo ? "immutable revision" : "no asset receipt", hasRevisionTwo),
      loopNode("Package assembler" + (packageRevision ? " · r" + packageRevision.revision : ""), packageStatus, packageRevision ? "<span class=\"glyph\" aria-hidden=\"true\">✦</span>" : "<span>no package receipt</span>", packageRevision ? packageFrozen ? "local package frozen" : "local package selected" : "awaiting compatible candidate", Boolean(packageRevision)),
      loopNode("Unity judge", unityStatus, "<span>no host receipt</span>", unityReceipt ? "host acceptance not observed" : "no package receipt", false),
    ];
    const flow = nodes.map((node, index) => (index ? edge() : "") + node).join("");
    const conceptGate = loopNode("Concept-first gate", "pending", "", "runtime enforcement pending", false);
    const caption = run ? "Current path is highlighted; node state comes from this build's local events and receipts." : "Submit a build to project its real local worker and revision receipts.";
    return "<section aria-label=\"Encounter asset build loop\"><div class=\"loop-panel\"><div class=\"loop-flow\">" + flow + "</div><div class=\"loop-meta\"><span><strong>Asset revision loop</strong> · local evidence only</span><span>" + caption + "</span></div><div class=\"quiet-lanes\">" + deadlineTimer(run) + quietLane(run, "Material", "material") + quietLane(run, "Arena", "arena") + "</div><div class=\"lane-grid\" aria-label=\"Lane and component status\">" + laneCards(run) + "</div><div class=\"loop-gates\">" + conceptGate + "</div></div></section>";
  }
  function eventRows(events) { return events.map((entry) => "<li><strong>" + esc(entry.kind) + "</strong> · " + esc(labels[entry.evidence.kind] || "Unknown evidence source") + "<br>" + esc(entry.message) + "</li>").join(""); }
  function workRows(work) { return work.length ? "<ul>" + work.map((item) => "<li><code>" + esc(item.work_id) + "</code> · " + esc(item.lane) + " · " + esc(item.status) + " · " + esc(item.elapsed_seconds) + "s elapsed<br>Component <code>" + esc(item.component) + "</code>; worker <code>" + esc(item.worker_id) + "</code>; depends on " + (item.depends_on_work_ids.length ? item.depends_on_work_ids.map(esc).join(", ") : "request") + "</li>").join("") + "</ul>" : "<p class=\"muted\">No worker receipts yet.</p>"; }
  function artifactRows(rows, key) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row[key]) + "</code> · rev " + esc(row.revision) + "<br>" + json(row) + "</li>").join("") + "</ul>" : "<p class=\"muted\">None observed.</p>"; }
  function steerRows(rows) { return rows.length ? "<ul>" + rows.map((row) => "<li><code>" + esc(row.steer_id) + "</code> · " + esc(row.status) + "</li>").join("") + "</ul>" : "<p class=\"muted\">No steering receipts.</p>"; }
  function catalogRows(catalog) { return "<ul>" + Object.entries(catalog).map(([name, row]) => "<li>" + esc(name.replaceAll("_", " ")) + ": " + esc(row.count) + " · " + esc(row.evidence) + "</li>").join("") + "</ul>"; }
  function outcomeRows(run) { const current = latestRevision(run.packages); const outcomes = current && current.outcomes; if (!outcomes) return "<p class=\"muted\">No package outcome yet.</p>"; return "<ul><li><strong>Selected</strong>: " + outcomes.selected.map(esc).join(", ") + "</li><li><strong>Rejected</strong>: " + (outcomes.rejected.length ? outcomes.rejected.map((row) => esc(row.module_id) + " (" + row.reasons.map(esc).join(", ") + ")").join(", ") : "none") + "</li><li><strong>Fallback</strong>: " + (outcomes.fallback.used_fallback ? esc(outcomes.fallback.module_ids.join(", ")) : "not used") + "</li></ul>"; }
  function details(run) {
    return "<details class=\"drawer\"><summary>Build details and evidence</summary><div class=\"drawer-body\"><section><h3>Identity</h3><ul><li>encounter <code>" + esc(run.ids.encounterId) + "</code></li><li>request <code>" + esc(run.ids.requestId) + "</code></li><li>correlation <code>" + esc(run.ids.workerId) + "</code></li><li>profile <code>" + esc(run.compile_profile) + "</code></li><li>deadline <code>" + esc(run.deadline_at) + "</code></li></ul><h3>Workers and dependencies</h3>" + workRows(run.topology.work_graph) + "</section><section><h3>Artifacts, receipts, and hashes</h3>" + artifactRows(run.artifacts, "artifact_id") + "<h3>Package outcomes</h3>" + outcomeRows(run) + "<h3>Package receipt</h3>" + artifactRows(run.packages, "package_id") + "</section><section><h3>Event log</h3><ul>" + eventRows(run.events) + "</ul><h3>Catalog counters</h3>" + catalogRows(run.topology.catalog) + "</section><section><h3>Steer this build</h3><form id=\"steer\"><label for=\"steer-instruction\">Instruction<textarea id=\"steer-instruction\" required placeholder=\"Optional steering instruction…\"></textarea></label><button>Queue steer</button></form>" + steerRows(run.steering) + "</section></div></details>";
  }
  function buildCard(build) { return "<a class=\"build-link\" href=\"" + esc(build.navigation_url) + "\"><strong>" + esc(build.terminal ? "Completed assembly" : "Active assembly") + "</strong><br><span class=\"quiet\">" + esc(build.encounter_id) + "</span></a>"; }
  function renderDashboard(index) {
    const builds = index.active.concat(index.recent_terminal);
    main.innerHTML = assembly() + (builds.length ? "<details class=\"drawer\"><summary>Open a recent assembly</summary><div class=\"build-list\">" + builds.map(buildCard).join("") + "</div></details>" : "<p class=\"empty-note\">No assemblies yet. A local render is optional and remains local evidence only.</p>");
  }
  async function submitSteer(event) { event.preventDefault(); const instruction = document.querySelector("#steer-instruction").value; const response = await fetch("/api/builds/" + encodeURIComponent(activeRequest) + "/steer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) }); if (!response.ok) alert((await response.json()).error); }
  async function requestUpgrade() { const button = document.querySelector("#upgrade"); button.disabled = true; const response = await fetch("/api/encounters/" + encodeURIComponent(active) + "/upgrades", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const result = await response.json(); if (!response.ok) { button.disabled = false; return alert(result.error); } render(result); }
  async function requestFreeze() { const button = document.querySelector("#freeze"); button.disabled = true; const response = await fetch("/api/encounters/" + encodeURIComponent(active) + "/freeze", { method: "POST" }); const result = await response.json(); if (!response.ok) { button.disabled = false; return alert(result.error); } render(result); }
  function render(run) {
    main.innerHTML = assembly(run) + details(run);
    const inspector = main.querySelector(".drawer .drawer-body");
    const upgrade = document.createElement("section");
    upgrade.innerHTML = "<h3>Request next revision</h3><p class=\"muted\">Creates one bounded local revision; earlier source, render, GLB, and package receipts remain inspectable above.</p><button id=\"upgrade\" " + (!run.generate_asset || run.upgrade?.active ? "disabled" : "") + ">Request next revision</button>";
    inspector.append(upgrade);
    const currentPackage = latestRevision(run.packages);
    const freeze = document.createElement("section");
    freeze.innerHTML = "<h3>Freeze current package</h3><p class=\"muted\">Creates an immutable local package snapshot from the current selected package; it is not host-game acceptance.</p><button id=\"freeze\" " + (!currentPackage || currentPackage.state === "frozen" ? "disabled" : "") + ">Freeze current package</button>";
    inspector.append(freeze);
    document.querySelector("#steer").addEventListener("submit", submitSteer);
    document.querySelector("#upgrade").addEventListener("click", requestUpgrade);
    document.querySelector("#freeze").addEventListener("click", requestFreeze);
    refreshDeadlineTimers();
  }
  setInterval(refreshDeadlineTimers, 1000);

  function watch(encounterId) {
    dashboardSource?.close(); dashboardSource = undefined;
    activeSource?.close();
    activeSource = new EventSource("/api/encounters/" + encodeURIComponent(encounterId) + "/stream");
    activeSource.addEventListener("projection", (event) => render(JSON.parse(event.data)));
  }
  function watchDashboard() {
    activeSource?.close(); activeSource = undefined;
    dashboardSource?.close();
    dashboardSource = new EventSource("/api/builds/stream");
    dashboardSource.addEventListener("projection", (event) => renderDashboard(JSON.parse(event.data)));
  }
  async function start() {
    const requestId = new URLSearchParams(location.search).get("build");
    if (requestId) { const response = await fetch("/api/builds/" + encodeURIComponent(requestId)); if (response.ok) { const run = await response.json(); active = run.ids.encounterId; activeRequest = run.ids.requestId; render(run); watch(active); return; } }
    const response = await fetch("/api/builds");
    renderDashboard(await response.json());
    watchDashboard();
  }
  start();
`;

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const port = Number(process.env.BUILD_ROOM_PORT || 4173);
  const statePath = process.env.BUILD_ROOM_STATE_PATH || ".build-room-state.json";
  const room = loadBuildRoom(statePath);
  createBuildRoomServer({ room, persist: (nextRoom) => persistBuildRoom(statePath, nextRoom) })
    .listen(port, "127.0.0.1", () => console.log(`Myth Maker build room: http://127.0.0.1:${port}`));
}
