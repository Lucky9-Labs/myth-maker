import { createHash, randomUUID } from "node:crypto";
import { isV1WorkerEvent } from "./worker.js";

const EVIDENCE_LABELS = {
  fixture: "Simulated fixture (not live)",
  local_process: "Local process receipt (observed)",
  local_blender_cli: "Local Blender CLI evidence (observed)",
  adapter_reported: "Coordinator/dispatcher report (unverified)",
  modal_remote: "Modal remote receipt (observed)",
  blender_window: "Blender window/screenshot/stream (observed)",
};

/**
 * In-memory projection for the local build-room. The external coordinator and
 * dispatcher do not need to adopt this class: CoordinatorEventAdapter is the
 * narrow translation boundary for their events.
 */
export class BuildRoom {
  constructor({ now = () => new Date().toISOString(), id = randomStableId, catalogProjection = undefined } = {}) {
    this.now = now;
    this.id = id;
    this.runs = new Map();
    this.idempotency = new Map();
    this.listeners = new Set();
    this.catalogProjection = catalogProjection;
  }

  setCatalogProjection(catalogProjection) {
    if (catalogProjection !== undefined && typeof catalogProjection !== "function") throw new TypeError("catalogProjection must be a function");
    this.catalogProjection = catalogProjection;
    return this;
  }

  submit(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["prompt", "generate_asset", "idempotency_key"].includes(key))) {
      throw new TypeError("build-room request has unknown fields");
    }
    const { prompt, generate_asset: generateAsset = false, idempotency_key: idempotencyKey = undefined } = input;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2000) {
      throw new TypeError("prompt must be a non-empty string of at most 2000 characters");
    }
    if (typeof generateAsset !== "boolean") throw new TypeError("generate_asset must be a boolean when supplied");
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._-]{8,128}$/.test(idempotencyKey))) {
      throw new TypeError("idempotency_key must be 8 to 128 URL-safe characters");
    }
    const normalizedPrompt = prompt.trim();
    const fingerprint = createHash("sha256").update(JSON.stringify({ prompt: normalizedPrompt, generate_asset: generateAsset })).digest("hex");
    if (idempotencyKey) {
      const prior = this.idempotency.get(idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new TypeError("idempotency_key reused with a different build-room request");
        return { ...this.snapshot(prior.encounterId), deduplicated: true };
      }
    }
    const ids = {
      encounterId: this.id("encounter"),
      requestId: this.id("request"),
      workerId: this.id("worker"),
    };
    const submittedAt = this.now();
    this.runs.set(ids.encounterId, {
      ids,
      prompt: normalizedPrompt,
      generateAsset,
      seed: seedFor(normalizedPrompt),
      submittedAt,
      events: [],
      artifacts: new Map(),
      packages: new Map(),
      workGraph: new Map(),
      evidence: { local: [], modal: [], blender: [] },
      steering: [],
      nextCursor: 1,
    });

    this.record(ids.encounterId, {
      eventId: this.id("event"),
      workerId: ids.workerId,
      sequence: 0,
      occurredAt: submittedAt,
      kind: "accepted",
      message: "The local build-room accepted this request. Cloudflare EncounterCoordinator was not contacted.",
      evidence: { kind: "local_process", receipt: { request_id: ids.requestId, observed_at: submittedAt } },
    });
    if (idempotencyKey) this.idempotency.set(idempotencyKey, { encounterId: ids.encounterId, fingerprint });
    const snapshot = this.snapshot(ids.encounterId);
    this.notify(ids.encounterId);
    return { ...snapshot, deduplicated: false };
  }

  record(encounterId, input) {
    const run = this.requireRun(encounterId);
    const event = normaliseEvent(input, run, this.now, this.id, run.nextCursor++);
    run.events.push(event);
    if (event.artifact) upsertRevision(run.artifacts, event.artifact);
    if (event.package) upsertRevision(run.packages, event.package);
    if (["local_process", "local_blender_cli"].includes(event.evidence.kind)) run.evidence.local.push(event.evidence.receipt);
    if (event.evidence.kind === "modal_remote") run.evidence.modal.push(event.evidence.receipt);
    if (event.evidence.kind === "blender_window") run.evidence.blender.push(event.evidence.receipt);
    this.notify(encounterId);
    return event;
  }

  upsertWork(encounterId, input, event) {
    if (!input?.work_id) return;
    validateWorkMetadata(input);
    const run = this.requireRun(encounterId);
    const prior = run.workGraph.get(input.work_id) || {};
    run.workGraph.set(input.work_id, {
      ...prior,
      work_id: input.work_id,
      lane: input.lane || input.work_order?.lane || prior.lane || "unreported",
      depends_on_work_ids: input.depends_on_work_ids || input.work_order?.depends_on_work_ids || prior.depends_on_work_ids || [],
      worker_id: event.workerId,
      status: workerStatus(event.kind),
      started_at: prior.started_at || event.occurredAt,
      updated_at: event.occurredAt,
      evidence_kind: event.evidence.kind,
    });
    this.notify(encounterId);
  }

  snapshot(encounterId) {
    const run = this.requireRun(encounterId);
    return {
      ids: { ...run.ids },
      prompt: run.prompt,
      generate_asset: run.generateAsset,
      seed: run.seed,
      submittedAt: run.submittedAt,
      events: orderedEvents(run.events),
      artifacts: revisions(run.artifacts),
      packages: revisions(run.packages),
      work_graph: [...run.workGraph.values()],
      evidence: {
        local: [...run.evidence.local],
        modal: [...run.evidence.modal],
        blender: [...run.evidence.blender],
      },
      steering: [...run.steering],
      topology: topology(run, this.catalogProjection, this.now()),
    };
  }

  replay(encounterId, afterCursor = undefined) {
    const events = this.snapshot(encounterId).events;
    if (!afterCursor) return events;
    const position = events.findIndex((event) => event.cursor === afterCursor);
    return position < 0 ? events : events.slice(position + 1);
  }

  list() {
    return [...this.runs.keys()].map((encounterId) => this.snapshot(encounterId));
  }

  buildIndex({ terminalLimit = 20 } = {}) {
    const builds = this.list().map(buildSummary).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      active: builds.filter((build) => !build.terminal),
      recent_terminal: builds.filter((build) => build.terminal).slice(0, terminalLimit),
      terminal_limit: terminalLimit,
    };
  }

  buildDetail(requestId) {
    const run = this.list().find((candidate) => candidate.ids.requestId === requestId);
    if (!run) throw new RangeError(`unknown request ${requestId}`);
    return { ...run, navigation_url: `/?build=${encodeURIComponent(requestId)}` };
  }

  steer(requestId, input) {
    const run = this.requireRunByRequest(requestId);
    if (typeof input?.instruction !== "string" || !input.instruction.trim() || input.instruction.length > 2000) {
      throw new TypeError("steer instruction must be 1 to 2000 characters");
    }
    const receipt = {
      steer_id: this.id("steer"),
      status: "queued",
      instruction: input.instruction.trim(),
      work_id: input.work_id || undefined,
      created_at: this.now(),
      source: "local_adapter",
    };
    run.steering.push(receipt);
    this.notify(run.ids.encounterId);
    return receipt;
  }

  recordSteering(input, { trusted = false } = {}) {
    const run = this.requireRunByRequest(input?.request_id);
    const status = input?.status;
    if (!input.steer_id || !["queued", "accepted", "pending", "failed", "committed"].includes(status)) throw new TypeError("invalid steering receipt");
    if (!trusted) throw new TypeError("external steering lifecycle updates require trusted observer provenance");
    if (status === "committed" && !input.successor_response?.created) throw new TypeError("committed steering requires successor response.created");
    const prior = run.steering.find((receipt) => receipt.steer_id === input.steer_id);
    if (!prior) throw new TypeError("unknown steering receipt");
    if (!validSteeringTransition(prior.status, status)) throw new TypeError("illegal steering receipt transition");
    const receipt = {
      ...prior,
      status,
      ...(input.response_id ? { response_id: input.response_id } : {}),
      ...(input.successor_response ? { successor_response: input.successor_response } : {}),
      received_at: this.now(),
      observer: "trusted",
    };
    Object.assign(prior, receipt);
    this.notify(run.ids.encounterId);
    return receipt;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(encounterId) {
    const snapshot = this.snapshot(encounterId);
    for (const listener of this.listeners) listener(encounterId, snapshot);
  }

  exportState() {
    return {
      version: 1,
      idempotency: [...this.idempotency.entries()],
      runs: [...this.runs.values()].map((run) => ({
        ...run,
        artifacts: [...run.artifacts.entries()],
        packages: [...run.packages.entries()],
        workGraph: [...run.workGraph.entries()],
      })),
    };
  }

  restore(state) {
    if (state?.version !== 1 || !Array.isArray(state.runs)) throw new TypeError("invalid build-room state");
    this.runs.clear();
    this.idempotency.clear();
    for (const stored of state.runs) {
      if (!stored?.ids?.encounterId || !Array.isArray(stored.events)) throw new TypeError("invalid stored build-room run");
      this.runs.set(stored.ids.encounterId, {
        ...stored,
        artifacts: new Map(stored.artifacts || []),
        packages: new Map(stored.packages || []),
        workGraph: new Map(Array.isArray(stored.workGraph) ? stored.workGraph : []),
        steering: stored.steering || [],
      });
    }
    for (const [key, value] of state.idempotency || []) {
      if (typeof key === "string" && value?.encounterId && value?.fingerprint) this.idempotency.set(key, value);
    }
    return this;
  }

  requireRun(encounterId) {
    const run = this.runs.get(encounterId);
    if (!run) throw new RangeError(`unknown encounter ${encounterId}`);
    return run;
  }

  requireRunByRequest(requestId) {
    const run = [...this.runs.values()].find((candidate) => candidate.ids.requestId === requestId);
    if (!run) throw new RangeError(`unknown request ${requestId}`);
    return run;
  }
}

/** Translate coordinator or dispatcher payloads without claiming their source is live. */
export class CoordinatorEventAdapter {
  constructor(room, { trustedObservation = () => false } = {}) {
    this.room = room;
    this.trustedObservation = trustedObservation;
  }

  ingest(input, context = {}) {
    const workerEvent = validateAdapterWorkerEvent(input);
    validateWorkMetadata(input);
    const evidence = evidenceFromAdapterInput(input, context, this.trustedObservation);
    const artifact = normaliseRevision(input.artifact, "artifact") || moduleRevision(input.module);
    const event = this.room.record(workerEvent.encounter_id, {
      eventId: workerEvent.event_id,
      workerId: workerEvent.worker_id,
      sequence: workerEvent.sequence,
      occurredAt: workerEvent.occurred_at,
      kind: workerEvent.kind,
      message: workerEvent.message,
      artifact,
      package: normaliseRevision(input.package, "package"),
      evidence,
    });
    this.room.upsertWork(input.encounter_id, input, event);
    return event;
  }
}

const WORKER_EVENT_FIELDS = ["schema_version", "event_id", "work_id", "encounter_id", "worker_id", "sequence", "occurred_at", "kind", "module", "progress", "message", "error_code", "retryable"];
const ADAPTER_FIELDS = new Set([...WORKER_EVENT_FIELDS, "lane", "depends_on_work_ids", "work_order", "source", "receipt", "artifact", "package"]);

function validateAdapterWorkerEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !ADAPTER_FIELDS.has(key))) {
    throw new TypeError("adapter input must contain a closed v1 worker event envelope");
  }
  const workerEvent = Object.fromEntries(WORKER_EVENT_FIELDS.filter((key) => key in input).map((key) => [key, input[key]]));
  if (!isV1WorkerEvent(workerEvent)) throw new TypeError("adapter input requires a valid closed v1 worker event");
  return workerEvent;
}

function validateWorkMetadata(input) {
  const dependencies = input.depends_on_work_ids || input.work_order?.depends_on_work_ids || [];
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.work_id)
    || !/^[a-z][a-z0-9_.-]{0,95}$/.test(input.lane || input.work_order?.lane || "")
    || !Array.isArray(dependencies)
    || !dependencies.every((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    || new Set(dependencies).size !== dependencies.length) throw new TypeError("invalid v1 work graph metadata");
}

export function evidenceLabel(evidence) {
  return EVIDENCE_LABELS[evidence?.kind] || "Unknown evidence source (unverified)";
}

function normaliseEvent(input, run, now, id, cursor) {
  if (!input || !Number.isInteger(input.sequence) || input.sequence < 0) {
    throw new TypeError("event sequence must be a non-negative integer");
  }
  if (typeof input.kind !== "string" || !input.kind) throw new TypeError("event kind is required");
  const evidence = input.evidence || { kind: "adapter_reported" };
  validateEvidence(evidence);
  return {
    eventId: input.eventId || id("event"),
    cursor: `${run.ids.encounterId}:${cursor}`,
    workerId: input.workerId || run.ids.workerId,
    sequence: input.sequence,
    occurredAt: input.occurredAt || now(),
    kind: input.kind,
    message: input.message || "",
    evidence,
    ...(input.artifact ? { artifact: input.artifact } : {}),
    ...(input.package ? { package: input.package } : {}),
  };
}

function evidenceFromAdapterInput(input, context, trustedObservation) {
  const source = input?.source || "adapter_reported";
  if (source === "modal_remote") {
    if (!input.receipt?.request_id || !input.receipt?.observed_at) {
      throw new TypeError("an observed Modal receipt requires request_id and observed_at");
    }
    if (!trustedObservation(input, context)) throw new TypeError("Modal evidence requires a trusted local observer");
    return { kind: "modal_remote", receipt: input.receipt };
  }
  if (source === "blender_window") {
    if (!input.receipt?.observed_at || (!input.receipt.screenshot_path && !input.receipt.stream_url)) {
      throw new TypeError("observed Blender evidence requires screenshot_path or stream_url and observed_at");
    }
    if (!trustedObservation(input, context)) throw new TypeError("Blender evidence requires a trusted local observer");
    return { kind: "blender_window", receipt: input.receipt };
  }
  if (source === "fixture") return { kind: "fixture" };
  return { kind: "adapter_reported", receipt: input.receipt };
}

function validateEvidence(evidence) {
  if (!EVIDENCE_LABELS[evidence?.kind]) throw new TypeError("unknown evidence kind");
  if (["local_process", "local_blender_cli", "modal_remote", "blender_window"].includes(evidence.kind) && !evidence.receipt) {
    throw new TypeError(`${evidence.kind} evidence requires an observed receipt`);
  }
}

function normaliseRevision(value, type) {
  if (!value) return undefined;
  const id = value[`${type}_id`];
  if (typeof id !== "string" || !id || !Number.isInteger(value.revision) || value.revision < 1) {
    throw new TypeError(`${type} requires ${type}_id and a positive integer revision`);
  }
  return { ...value };
}

function moduleRevision(module) {
  if (!module) return undefined;
  return normaliseRevision({ artifact_id: module.module_id, revision: module.revision, artifact: module.artifact }, "artifact");
}

function upsertRevision(entries, entry) {
  const id = entry.artifact_id || entry.package_id;
  const prior = entries.get(id);
  if (!prior || entry.revision >= prior.revision) entries.set(id, entry);
}

function revisions(entries) {
  return [...entries.values()].sort((a, b) => (a.artifact_id || a.package_id).localeCompare(b.artifact_id || b.package_id));
}

function orderedEvents(events) {
  return [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)
    || cursorPosition(a.cursor) - cursorPosition(b.cursor));
}

function cursorPosition(cursor) {
  return Number(cursor.slice(cursor.lastIndexOf(":") + 1));
}

function topology(run, catalogProjection, observedAt) {
  const events = orderedEvents(run.events);
  const workers = new Map();
  for (const event of events) {
    const current = workers.get(event.workerId) || { workerId: event.workerId, events: [] };
    current.events.push(event);
    workers.set(event.workerId, current);
  }
  return {
    work_graph: [...run.workGraph.values()].sort((a, b) => a.work_id.localeCompare(b.work_id)).map((work) => ({
      ...work,
      elapsed_seconds: elapsedSeconds(work, observedAt),
    })),
    workers: [...workers.values()].filter((worker) => worker.events.some((event) => !["fixture", "local_process", "local_blender_cli"].includes(event.evidence.kind))).map((worker) => {
      const last = worker.events.at(-1);
      return {
        worker_id: worker.workerId,
        status: last.kind === "completed" ? "completed" : last.kind === "failed" ? "failed" : "active",
        current_stage: last.kind,
        evidence_kind: last.evidence.kind,
      };
    }),
    catalog: catalogTopology(catalogProjection, run),
  };
}

function elapsedSeconds(work, observedAt) {
  const start = Date.parse(work.started_at);
  const end = Date.parse(["completed", "failed"].includes(work.status) ? work.updated_at : observedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
}

function catalogTopology(catalogProjection, run) {
  const unavailable = {
    semantic_entities: { count: 0, evidence: "not_connected" },
    assets: { count: 0, evidence: "not_connected" },
    animations: { count: 0, evidence: "not_connected" },
    semantic_entity_revisions: { count: 0, evidence: "not_connected" },
    asset_revisions: { count: 0, evidence: "not_connected" },
    animation_revisions: { count: 0, evidence: "not_connected" },
  };
  if (!catalogProjection) return { ...unavailable, package_revisions: { count: run.packages.size, evidence: "local_projection" } };
  const summary = catalogProjection();
  const projected = Object.fromEntries(Object.keys(unavailable).map((key) => [key, {
    count: Number.isInteger(summary?.[key]) && summary[key] >= 0 ? summary[key] : 0,
    evidence: "local_sqlite_query",
  }]));
  return { ...projected, package_revisions: { count: run.packages.size, evidence: "local_projection" } };
}

function workerStatus(kind) {
  if (kind === "completed") return "completed";
  if (kind === "failed" || kind === "cancelled") return "failed";
  if (kind === "accepted") return "accepted";
  return "running";
}

function buildSummary(run) {
  const events = run.events;
  const updatedAt = events.at(-1)?.occurredAt || run.submittedAt;
  const workers = run.topology.work_graph;
  const terminal = workers.length > 0 && workers.every((worker) => ["completed", "failed"].includes(worker.status));
  return {
    encounter_id: run.ids.encounterId,
    request_id: run.ids.requestId,
    submitted_at: run.submittedAt,
    updated_at: updatedAt,
    terminal,
    work_graph: { stages: ["request", "planner", "coordinator", "dispatcher", "workers"], workers, work_items: run.topology.work_graph },
    catalog: run.topology.catalog,
    revisions: { artifacts: run.artifacts.length, packages: run.packages.length, evidence: "reported" },
    evidence_tier: workers.map((worker) => worker.evidence_kind),
    navigation_url: `/?build=${encodeURIComponent(run.ids.requestId)}`,
  };
}

function validSteeringTransition(from, to) {
  if (from === to) return true;
  return {
    queued: new Set(["accepted", "pending", "failed"]),
    accepted: new Set(["committed", "failed"]),
    pending: new Set(["committed", "failed"]),
    failed: new Set(),
    committed: new Set(),
  }[from]?.has(to) || false;
}

function randomStableId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function seedFor(prompt) {
  return createHash("sha256").update(prompt).digest().readUInt32BE(0);
}
