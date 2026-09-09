import { freezeEncounterPackage } from "./encounter-package-assembler.js";
import {
  acceptedAssemblyReceipt,
  acceptedCatalogRevision,
  compatibleFrozenPackage,
  createSignedManifest,
  noPackageResponse,
  selectNewestCompatible,
  validDiscoveryRequest,
} from "./package-discovery.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SEMANTIC_TAG = /^[a-z][a-z0-9_.-]{0,95}$/;
const CONTRACT_NAME = /^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$/;
const EXECUTION_KINDS = new Set(["recipe", "runtime_asset", "managed_plugin", "remote_logic"]);
const EVENT_KINDS = new Set(["accepted", "started", "heartbeat", "progress", "candidate_produced", "completed", "failed", "cancelled"]);
const TERMINAL_WORK_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnly(value, fields) {
  return Object.keys(value).every((key) => fields.has(key));
}

function isDateTime(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isIdArray(value) {
  return Array.isArray(value) && value.every((item) => ID.test(item)) && new Set(value).size === value.length;
}

function isTagArray(value, minimum = 0) {
  return Array.isArray(value) && value.length >= minimum
    && value.every((item) => SEMANTIC_TAG.test(item)) && new Set(value).size === value.length;
}

function validCapabilities(value) {
  const fields = new Set(["schema_version", "host_id", "host_build", "platform", "scripting_backend", "execution_kinds", "loaders", "contracts", "limits"]);
  if (!isObject(value) || !hasOnly(value, fields)
    || value.schema_version !== "1" || !ID.test(value.host_id)
    || typeof value.host_build !== "string" || value.host_build.length === 0 || value.host_build.length > 128
    || typeof value.platform !== "string" || value.platform.length === 0 || value.platform.length > 64
    || !["mono", "il2cpp"].includes(value.scripting_backend)
    || !Array.isArray(value.execution_kinds) || value.execution_kinds.length === 0
    || !value.execution_kinds.every((kind) => EXECUTION_KINDS.has(kind))
    || new Set(value.execution_kinds).size !== value.execution_kinds.length
    || !isTagArray(value.loaders)
    || !Array.isArray(value.contracts) || !value.contracts.every((contract) => CONTRACT_NAME.test(contract))
    || new Set(value.contracts).size !== value.contracts.length) return false;

  const limitFields = new Set(["memory_mb", "preload_seconds", "artifact_bytes", "actors"]);
  return isObject(value.limits) && hasOnly(value.limits, limitFields)
    && Number.isInteger(value.limits.memory_mb) && value.limits.memory_mb >= 1
    && Number.isInteger(value.limits.preload_seconds) && value.limits.preload_seconds >= 0
    && (value.limits.artifact_bytes === undefined || (Number.isInteger(value.limits.artifact_bytes) && value.limits.artifact_bytes >= 0))
    && (value.limits.actors === undefined || (Number.isInteger(value.limits.actors) && value.limits.actors >= 1));
}

function validWorkOrder(value) {
  const fields = new Set(["schema_version", "work_id", "encounter_id", "lane", "deadline_at", "requested_provides", "host_capabilities", "input_module_ids", "depends_on_work_ids", "resource_leases", "attempt", "instruction"]);
  return isObject(value) && hasOnly(value, fields)
    && value.schema_version === "1"
    && ID.test(value.work_id) && ID.test(value.encounter_id) && SEMANTIC_TAG.test(value.lane)
    && isDateTime(value.deadline_at) && isTagArray(value.requested_provides, 1)
    && validCapabilities(value.host_capabilities) && isIdArray(value.input_module_ids)
    && (value.depends_on_work_ids === undefined || isIdArray(value.depends_on_work_ids))
    && (value.resource_leases === undefined || isTagArray(value.resource_leases))
    && Number.isInteger(value.attempt) && value.attempt >= 1
    && (value.instruction === undefined || (typeof value.instruction === "string" && value.instruction.length <= 16000));
}

function validArtifact(value) {
  const fields = new Set(["uri", "sha256", "media_type", "byte_length"]);
  if (!isObject(value) || !hasOnly(value, fields) || typeof value.uri !== "string" || value.uri.length > 2048 || !SHA256.test(value.sha256)
    || typeof value.media_type !== "string" || value.media_type.length === 0 || value.media_type.length > 128) return false;
  try { new URL(value.uri); } catch { return false; }
  return value.byte_length === undefined || (Number.isInteger(value.byte_length) && value.byte_length >= 0);
}

function validCompatibility(value) {
  const fields = new Set(["host_contract_version", "platforms", "scripting_backends", "bindings"]);
  if (!isObject(value) || !hasOnly(value, fields) || value.host_contract_version !== "1") return false;
  if (value.platforms !== undefined && (!Array.isArray(value.platforms)
    || !value.platforms.every((platform) => typeof platform === "string" && platform.length > 0)
    || new Set(value.platforms).size !== value.platforms.length)) return false;
  if (value.scripting_backends !== undefined && (!Array.isArray(value.scripting_backends)
    || !value.scripting_backends.every((backend) => ["mono", "il2cpp"].includes(backend))
    || new Set(value.scripting_backends).size !== value.scripting_backends.length)) return false;
  return value.bindings === undefined || (isObject(value.bindings)
    && Object.entries(value.bindings).every(([key, binding]) => SEMANTIC_TAG.test(key)
      && typeof binding === "string" && binding.length > 0 && binding.length <= 128));
}

function validQuality(value) {
  const fields = new Set(["tier", "score", "evidence"]);
  return isObject(value) && hasOnly(value, fields)
    && Number.isInteger(value.tier) && value.tier >= 0 && value.tier <= 4
    && typeof value.score === "number" && value.score >= 0
    && (value.evidence === undefined || (Array.isArray(value.evidence)
      && value.evidence.every((evidence) => typeof evidence === "string" && evidence.length <= 512)));
}

function validProvenance(value) {
  const fields = new Set(["producer", "created_at", "parent_module_ids", "label"]);
  return isObject(value) && hasOnly(value, fields)
    && typeof value.producer === "string" && value.producer.length > 0 && value.producer.length <= 128
    && isDateTime(value.created_at)
    && (value.parent_module_ids === undefined || isIdArray(value.parent_module_ids))
    && (value.label === undefined || (typeof value.label === "string" && value.label.length <= 128));
}

function validModule(value) {
  const fields = new Set(["schema_version", "module_id", "revision", "execution_kind", "provides", "requires", "conflicts", "compatibility", "quality", "artifact", "entrypoint", "inline_recipe", "fallback_module_ids", "provenance"]);
  if (!isObject(value) || !hasOnly(value, fields) || value.schema_version !== "1"
    || !ID.test(value.module_id) || !Number.isInteger(value.revision) || value.revision < 1
    || !EXECUTION_KINDS.has(value.execution_kind) || !isTagArray(value.provides, 1)
    || !Array.isArray(value.requires) || !value.requires.every((contract) => CONTRACT_NAME.test(contract))
    || new Set(value.requires).size !== value.requires.length || !isTagArray(value.conflicts)
    || !isIdArray(value.fallback_module_ids) || !validCompatibility(value.compatibility) || !validQuality(value.quality)
    || (value.artifact !== undefined && !validArtifact(value.artifact))
    || (value.entrypoint !== undefined && (typeof value.entrypoint !== "string" || value.entrypoint.length === 0 || value.entrypoint.length > 256))
    || (value.inline_recipe !== undefined && !isObject(value.inline_recipe))
    || (value.provenance !== undefined && !validProvenance(value.provenance))) return false;
  if (value.execution_kind === "recipe" && !isObject(value.inline_recipe)) return false;
  if (value.execution_kind !== "recipe" && !validArtifact(value.artifact)) return false;
  return value.execution_kind !== "managed_plugin" || (typeof value.entrypoint === "string" && value.entrypoint.length > 0);
}

function validWorkerEvent(value) {
  const fields = new Set(["schema_version", "event_id", "work_id", "encounter_id", "worker_id", "sequence", "occurred_at", "kind", "module", "progress", "message", "error_code", "retryable"]);
  if (!isObject(value) || !hasOnly(value, fields) || value.schema_version !== "1"
    || !ID.test(value.event_id) || !ID.test(value.work_id) || !ID.test(value.encounter_id) || !ID.test(value.worker_id)
    || !Number.isInteger(value.sequence) || value.sequence < 0 || !isDateTime(value.occurred_at) || !EVENT_KINDS.has(value.kind)
    || (value.progress !== undefined && (typeof value.progress !== "number" || value.progress < 0 || value.progress > 1))
    || (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 2000))
    || (value.error_code !== undefined && !SEMANTIC_TAG.test(value.error_code))
    || (value.retryable !== undefined && typeof value.retryable !== "boolean")) return false;
  if (value.module !== undefined && !validModule(value.module)) return false;
  if (value.kind === "candidate_produced" && !validModule(value.module)) return false;
  return value.kind !== "failed" || (SEMANTIC_TAG.test(value.error_code) && typeof value.retryable === "boolean");
}

// External worker adapters use the coordinator's complete closed-v1 envelope
// check before recording an event locally, rather than maintaining a drift-prone
// partial copy of this contract validation.
export function isV1WorkerEvent(value) { return validWorkerEvent(value); }

function validPlayablePackage(value) {
  const fields = new Set(["schema_version", "package_id", "encounter_id", "revision", "state", "assembled_at", "frozen_at", "module_ids", "manifest_sha256", "fallback_provenance", "rejection_reasons"]);
  if (!isObject(value) || !hasOnly(value, fields) || value.schema_version !== "1"
    || !ID.test(value.package_id) || !ID.test(value.encounter_id)
    || !Number.isInteger(value.revision) || value.revision < 1
    || !["candidate", "preloading", "ready", "frozen", "rejected"].includes(value.state)
    || !isDateTime(value.assembled_at) || !Array.isArray(value.module_ids) || value.module_ids.length === 0 || !isIdArray(value.module_ids)
    || !SHA256.test(value.manifest_sha256) || !isObject(value.fallback_provenance)) return false;
  const fallbackFields = new Set(["used_fallback", "module_ids"]);
  if (!hasOnly(value.fallback_provenance, fallbackFields)
    || typeof value.fallback_provenance.used_fallback !== "boolean" || !isIdArray(value.fallback_provenance.module_ids)) return false;
  if (value.frozen_at !== undefined && !isDateTime(value.frozen_at)) return false;
  if (value.state === "frozen" && !isDateTime(value.frozen_at)) return false;
  return value.rejection_reasons === undefined || (Array.isArray(value.rejection_reasons)
    && value.rejection_reasons.every((reason) => typeof reason === "string" && reason.length > 0 && reason.length <= 512));
}

function validSubmission(value) {
  return isObject(value) && hasOnly(value, new Set(["idempotency_key", "work_order"]))
    && IDEMPOTENCY_KEY.test(value.idempotency_key || "") && validWorkOrder(value.work_order);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function fingerprint(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hasValidFrozenManifest(value) {
  const packageWithoutHash = { ...value };
  delete packageWithoutHash.manifest_sha256;
  return value.manifest_sha256 === await fingerprint(packageWithoutHash);
}

function authorized(request, env) {
  return Boolean(env.AGENT_INGRESS_TOKEN) && request.headers.get("authorization") === `Bearer ${env.AGENT_INGRESS_TOKEN}`;
}

function catalogAuthorized(request, env) {
  return Boolean(env.CATALOG_ACCEPTANCE_TOKEN) && request.headers.get("x-catalog-acceptance-token") === env.CATALOG_ACCEPTANCE_TOKEN;
}

async function requestBody(request) {
  try { return await request.json(); } catch { return null; }
}

function workKey(workId) { return `work:${workId}`; }
function eventKey(workId) { return `events:${workId}`; }
function catalogKey(catalogRevisionId) { return `catalog:${catalogRevisionId}`; }
function discoveryKey(idempotencyKey) { return `package-discovery:${idempotencyKey}`; }

function workSummary(work) {
  return {
    work_id: work.work_order.work_id,
    lane: work.work_order.lane,
    status: work.status,
    attempt: work.work_order.attempt,
    event_count: work.event_count,
    last_event_sequence: work.last_event_sequence,
    created_at: work.created_at,
    updated_at: work.updated_at,
    ...(work.worker_id ? { worker_id: work.worker_id } : {}),
    ...(work.failure ? { failure: work.failure } : {}),
  };
}

function eventStatus(current, event) {
  const transitions = {
    dispatching: { accepted: "accepted", failed: "failed", cancelled: "cancelled" },
    queued: { accepted: "accepted", failed: "failed", cancelled: "cancelled" },
    accepted: { started: "running", failed: "failed", cancelled: "cancelled" },
    running: {
      heartbeat: "running",
      progress: "running",
      candidate_produced: "running",
      completed: "completed",
      failed: "failed",
      cancelled: "cancelled",
    },
  };
  return transitions[current]?.[event.kind] || null;
}

export class WorkDispatcherAdapter {
  constructor(env, fetcher) {
    this.url = env.WORK_DISPATCH_URL;
    this.token = env.WORK_DISPATCH_TOKEN;
    this.fetcher = fetcher;
  }

  async dispatch(workOrder) {
    let dispatchUrl;
    try { dispatchUrl = new URL(this.url); } catch { return { ok: false, error_code: "work_dispatch_url_invalid" }; }
    if (dispatchUrl.protocol !== "https:") return { ok: false, error_code: "work_dispatch_url_invalid" };
    if (typeof this.token !== "string" || this.token.length === 0) return { ok: false, error_code: "work_dispatch_token_missing" };
    try {
      const fetcher = this.fetcher || ((input, init) => fetch(input, init));
      const dispatched = await fetcher(dispatchUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "x-work-id": workOrder.work_id },
        body: JSON.stringify(workOrder),
      });
      return { ok: dispatched.ok, status: dispatched.status };
    } catch {
      return { ok: false, error_code: "work_dispatch_network_error" };
    }
  }
}

export class EncounterCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.dispatcher = new WorkDispatcherAdapter(env);
    this.dispatches = new Map();
  }

  async transaction(callback) {
    if (typeof this.state.storage.transaction === "function") return this.state.storage.transaction(callback);
    return callback(this.state.storage);
  }

  async encounterStatus() {
    const encounter = await this.state.storage.get("encounter");
    if (!encounter) return { status: "idle" };
    const workItems = await Promise.all(encounter.work_ids.map(async (workId) => workSummary(await this.state.storage.get(workKey(workId)))));
    return { encounter_id: encounter.encounter_id, state: encounter.state, work_items: workItems, ...(encounter.freeze_result ? { freeze_result: encounter.freeze_result } : {}) };
  }

  async dispatchable(storage, encounter, work) {
    const dependencies = work.work_order.depends_on_work_ids || [];
    for (const dependencyId of dependencies) {
      const dependency = await storage.get(workKey(dependencyId));
      if (!dependency || dependency.status !== "completed") return false;
    }
    const leases = encounter.active_leases || {};
    return (work.work_order.resource_leases || []).every((lease) => !leases[lease]);
  }

  reserveLeases(encounter, work) {
    const activeLeases = { ...(encounter.active_leases || {}) };
    for (const lease of work.work_order.resource_leases || []) activeLeases[lease] = work.work_order.work_id;
    return { ...encounter, active_leases: activeLeases };
  }

  releaseLeases(encounter, work) {
    const activeLeases = { ...(encounter.active_leases || {}) };
    for (const lease of work.work_order.resource_leases || []) {
      if (activeLeases[lease] === work.work_order.work_id) delete activeLeases[lease];
    }
    return { ...encounter, active_leases: activeLeases };
  }

  async submit(submission) {
    if (!validSubmission(submission)) return response({ error: "invalid_work_submission" }, 400);
    const workOrder = submission.work_order;
    const requestFingerprint = await fingerprint(workOrder);
    const idempotencyKey = `idempotency:${submission.idempotency_key}`;
    const admitted = await this.transaction(async (storage) => {
      const encounter = await storage.get("encounter");
      if (encounter?.state === "frozen") return { error: { error: "encounter_frozen", encounter_id: encounter.encounter_id }, status: 409 };
      const prior = await storage.get(idempotencyKey);
      if (prior) {
        if (prior.fingerprint !== requestFingerprint) return { error: { error: "idempotency_key_reused_with_different_request" }, status: 409 };
        return prior.dispatch_pending ? { dispatch: await storage.get(workKey(prior.work_id)) } : { replay: prior };
      }
      if (await storage.get(workKey(workOrder.work_id))) return { error: { error: "work_id_already_exists", work_id: workOrder.work_id }, status: 409 };
      const openEncounter = encounter || { encounter_id: workOrder.encounter_id, state: "open", work_ids: [], active_leases: {} };
      if (openEncounter.encounter_id !== workOrder.encounter_id) return { error: { error: "wrong_encounter" }, status: 409 };
      const now = new Date().toISOString();
      const waitingWork = { work_order: workOrder, status: "waiting", event_count: 0, last_event_sequence: -1, created_at: now, updated_at: now, idempotency_key: idempotencyKey, request_fingerprint: requestFingerprint };
      const ready = await this.dispatchable(storage, openEncounter, waitingWork);
      const work = ready ? { ...waitingWork, status: "dispatching" } : waitingWork;
      const pending = { fingerprint: requestFingerprint, work_id: workOrder.work_id, dispatch_pending: ready, response: { work_item: workSummary(work) }, status: 202 };
      const updatedEncounter = ready ? this.reserveLeases(openEncounter, work) : openEncounter;
      await storage.put("encounter", { ...updatedEncounter, work_ids: [...openEncounter.work_ids, workOrder.work_id] });
      await storage.put(workKey(workOrder.work_id), work);
      await storage.put(idempotencyKey, pending);
      return ready ? { dispatch: work } : { replay: pending };
    });
    if (admitted.error) return response(admitted.error, admitted.status);
    if (admitted.replay) return response(admitted.replay.response, admitted.replay.status);
    return this.dispatchWork(admitted.dispatch, idempotencyKey, requestFingerprint);
  }

  async dispatchWork(work, idempotencyKey, requestFingerprint) {
    const existing = this.dispatches.get(work.work_order.work_id);
    if (existing) return existing;
    const dispatch = (async () => {
      let dispatched;
      try { dispatched = await this.dispatcher.dispatch(work.work_order); } catch { dispatched = { ok: false }; }
      const result = await this.transaction(async (storage) => {
        const current = await storage.get(workKey(work.work_order.work_id));
        const settled = current.status === "dispatching"
          ? (dispatched.ok
            ? { ...current, status: "queued", updated_at: new Date().toISOString() }
            : { ...current, status: "blocked", updated_at: new Date().toISOString(), failure: { error_code: dispatchFailureCode(dispatched), retryable: true } })
          : current;
        const status = dispatched.ok || settled.status !== "blocked" ? 202 : 502;
        const responseBody = { work_item: workSummary(settled) };
        const encounter = await storage.get("encounter");
        await storage.put(workKey(work.work_order.work_id), settled);
        await storage.put(idempotencyKey, { fingerprint: requestFingerprint, work_id: work.work_order.work_id, dispatch_pending: false, response: responseBody, status });
        const scheduled = TERMINAL_WORK_STATUSES.has(settled.status)
          ? await this.promoteReadyWork(storage, this.releaseLeases(encounter, settled))
          : [];
        if (!TERMINAL_WORK_STATUSES.has(settled.status)) await storage.put("encounter", encounter);
        return { responseBody, status, scheduled };
      });
      await Promise.all(result.scheduled.map((readyWork) => this.dispatchWork(readyWork, readyWork.idempotency_key, readyWork.request_fingerprint)));
      return response(result.responseBody, result.status);
    })();
    this.dispatches.set(work.work_order.work_id, dispatch);
    try { return await dispatch; } finally { this.dispatches.delete(work.work_order.work_id); }
  }

  async promoteReadyWork(storage, encounter) {
    if (!encounter || encounter.state === "frozen") return [];
    let updatedEncounter = encounter;
    const workItems = [];
    for (const workId of encounter.work_ids) {
        const work = await storage.get(workKey(workId));
        if (work.status !== "waiting" || !await this.dispatchable(storage, updatedEncounter, work)) continue;
        const dispatching = { ...work, status: "dispatching", updated_at: new Date().toISOString() };
        updatedEncounter = this.reserveLeases(updatedEncounter, dispatching);
        await storage.put(workKey(workId), dispatching);
        await storage.put(dispatching.idempotency_key, {
          fingerprint: dispatching.request_fingerprint,
          work_id: workId,
          dispatch_pending: true,
          response: { work_item: workSummary(dispatching) },
          status: 202,
        });
        workItems.push(dispatching);
    }
    await storage.put("encounter", updatedEncounter);
    return workItems;
  }

  async scheduleReadyWork() {
    const ready = await this.transaction(async (storage) => this.promoteReadyWork(storage, await storage.get("encounter")));
    await Promise.all(ready.map((work) => this.dispatchWork(work, work.idempotency_key, work.request_fingerprint)));
  }

  async recoverDispatches() {
    const pending = await this.transaction(async (storage) => {
      const encounter = await storage.get("encounter");
      if (!encounter || encounter.state === "frozen") return [];
      const workItems = await Promise.all(encounter.work_ids.map(async (workId) => storage.get(workKey(workId))));
      return workItems.filter((work) => work.status === "dispatching");
    });
    await Promise.all(pending.map((work) => this.dispatchWork(work, work.idempotency_key, work.request_fingerprint)));
  }

  async appendEvent(workId, event) {
    if (!validWorkerEvent(event)) return response({ error: "invalid_worker_event" }, 400);
    const eventFingerprint = await fingerprint(event);
    const eventIdKey = `event-id:${event.event_id}`;
    const appended = await this.transaction(async (storage) => {
      const encounter = await storage.get("encounter");
      if (!encounter) return { value: { error: "encounter_not_found" }, status: 404 };
      if (encounter.state === "frozen") return { value: { error: "encounter_frozen", encounter_id: encounter.encounter_id }, status: 409 };
      const work = await storage.get(workKey(workId));
      if (!work) return { value: { error: "work_item_not_found" }, status: 404 };
      if (event.encounter_id !== encounter.encounter_id || event.work_id !== workId) return { value: { error: "worker_event_scope_mismatch" }, status: 409 };
      const prior = await storage.get(eventIdKey);
      if (prior) return prior.fingerprint === eventFingerprint
        ? { value: { event: prior.event, idempotent_replay: true }, status: 200 }
        : { value: { error: "event_id_reused_with_different_event" }, status: 409 };
      if (TERMINAL_WORK_STATUSES.has(work.status)) return { value: { error: "work_item_terminal", work_id: workId }, status: 409 };
      if (event.sequence <= work.last_event_sequence) return { value: { error: "worker_event_out_of_order", expected_sequence_after: work.last_event_sequence }, status: 409 };
      if (work.worker_id && work.worker_id !== event.worker_id) return { value: { error: "worker_identity_mismatch", work_id: workId }, status: 409 };
      const nextStatus = eventStatus(work.status, event);
      if (!nextStatus) return { value: { error: "illegal_worker_event_transition", work_id: workId, status: work.status, kind: event.kind }, status: 409 };
      const events = (await storage.get(eventKey(workId))) || [];
      const updated = {
        ...work,
        status: nextStatus,
        event_count: work.event_count + 1,
        last_event_sequence: event.sequence,
        updated_at: new Date().toISOString(),
        ...(event.kind === "accepted" ? { worker_id: event.worker_id } : {}),
        ...(event.kind === "failed" ? { failure: { error_code: event.error_code, retryable: event.retryable } } : {}),
      };
      await storage.put(workKey(workId), updated);
      const scheduled = TERMINAL_WORK_STATUSES.has(updated.status)
        ? await this.promoteReadyWork(storage, this.releaseLeases(encounter, updated))
        : [];
      await storage.put(eventKey(workId), [...events, event]);
      await storage.put(eventIdKey, { fingerprint: eventFingerprint, event });
      return { value: { event, work_item: workSummary(updated) }, status: 202, scheduled };
    });
    await Promise.all((appended.scheduled || []).map((readyWork) => this.dispatchWork(readyWork, readyWork.idempotency_key, readyWork.request_fingerprint)));
    return response(appended.value, appended.status);
  }

  async freeze(value) {
    const frozen = await this.transaction(async (storage) => {
      const encounter = await storage.get("encounter");
      if (!encounter) return { value: { error: "encounter_not_found" }, status: 404 };
      if (encounter.freeze_result) return { value: encounter.freeze_result, status: 200 };
      const candidate = value?.package;
      if (!validPlayablePackage(candidate) || !["ready", "frozen"].includes(candidate.state)) return { value: { error: "invalid_playable_encounter_package" }, status: 400 };
      if (candidate.encounter_id !== encounter.encounter_id) return { value: { error: "package_encounter_mismatch" }, status: 409 };
      if (!ID.test(value?.catalog_revision_id || "")) return { value: { error: "catalog_revision_not_found" }, status: 400 };
      const catalogRevision = await storage.get(catalogKey(value.catalog_revision_id));
      const assemblyReceipt = await acceptedAssemblyReceipt(value?.assembly_receipt);
      if (!catalogRevision || !assemblyReceipt) return { value: { error: "invalid_accepted_assembly_receipt" }, status: 400 };
      let freezeResult;
      try {
        freezeResult = candidate.state === "ready"
          ? freezeEncounterPackage(candidate, new Date().toISOString())
          : await hasValidFrozenManifest(candidate) ? candidate : null;
      } catch {
        freezeResult = null;
      }
      if (!freezeResult) return { value: { error: "invalid_playable_encounter_package" }, status: 400 };
      if (!(await compatibleFrozenPackage({ packageRecord: candidate, catalogRevision, assemblyReceipt, hostCapabilities: value?.host_capabilities }))) {
        return { value: { error: "package_catalog_assembly_mismatch" }, status: 409 };
      }
      await storage.put("encounter", {
        ...encounter,
        state: "frozen",
        freeze_result: freezeResult,
        discoverable_package: { package_record: freezeResult, assembly_package_record: candidate, catalog_revision: catalogRevision, assembly_receipt: assemblyReceipt },
      });
      return { value: freezeResult, status: 201 };
    });
    return response(frozen.value, frozen.status);
  }

  async recordCatalogRevision(value) {
    const catalogRevision = await acceptedCatalogRevision(value?.catalog_revision);
    if (!catalogRevision) return response({ error: "invalid_accepted_catalog_revision" }, 400);
    const recorded = await this.transaction(async (storage) => {
      const encounter = await storage.get("encounter");
      if (!encounter) return { value: { error: "encounter_not_found" }, status: 404 };
      if (encounter.state === "frozen") return { value: { error: "encounter_frozen", encounter_id: encounter.encounter_id }, status: 409 };
      if (catalogRevision.encounter_id !== encounter.encounter_id) return { value: { error: "catalog_encounter_mismatch" }, status: 409 };
      const prior = await storage.get(catalogKey(catalogRevision.catalog_revision_id));
      if (prior) return prior.catalog_sha256 === catalogRevision.catalog_sha256
        ? { value: { catalog_revision: prior, idempotent_replay: true }, status: 200 }
        : { value: { error: "catalog_revision_id_reused_with_different_revision" }, status: 409 };
      await storage.put(catalogKey(catalogRevision.catalog_revision_id), catalogRevision);
      return { value: { catalog_revision: catalogRevision }, status: 201 };
    });
    return response(recorded.value, recorded.status);
  }

  async discoverPackage(value, expectedEncounterId = undefined) {
    if (!validDiscoveryRequest(value)) return response({ error: "invalid_package_discovery_request" }, 400);
    if (!this.env.PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY) return response({ error: "package_discovery_signing_unavailable" }, 503);
    const requestFingerprint = await fingerprint(value);
    const discovered = await this.transaction(async (storage) => {
      const prior = await storage.get(discoveryKey(value.idempotency_key));
      if (prior) return prior.fingerprint === requestFingerprint
        ? { value: prior.response, status: 200 }
        : { value: { error: "idempotency_key_reused_with_different_request" }, status: 409 };
      const encounter = await storage.get("encounter");
      const noPackage = noPackageResponse(expectedEncounterId || encounter?.encounter_id || "unknown-encounter", value.request_id, value.schema_version);
      if (!encounter || (expectedEncounterId && encounter.encounter_id !== expectedEncounterId) || !encounter.discoverable_package) {
        await storage.put(discoveryKey(value.idempotency_key), { fingerprint: requestFingerprint, response: noPackage });
        return { value: noPackage, status: 200 };
      }
      const candidates = encounter.discoverable_packages || [encounter.discoverable_package];
      const compatibleCandidates = await Promise.all(candidates.map(async (record) => ({
        ...record,
        compatible: record.package_record.state === "frozen" && await compatibleFrozenPackage({
          packageRecord: record.assembly_package_record,
          catalogRevision: record.catalog_revision,
          assemblyReceipt: record.assembly_receipt,
          hostCapabilities: value.host_capabilities,
        }),
      })));
      const record = selectNewestCompatible(compatibleCandidates);
      if (!record) {
        await storage.put(discoveryKey(value.idempotency_key), { fingerprint: requestFingerprint, response: noPackage });
        return { value: noPackage, status: 200 };
      }
      const manifest = await createSignedManifest({
        packageRecord: record.package_record,
        catalogRevision: record.catalog_revision,
        assemblyReceipt: record.assembly_receipt,
        request: value,
        hostCapabilities: value.host_capabilities,
        signingPrivateKey: this.env.PACKAGE_DISCOVERY_SIGNING_PRIVATE_KEY,
        issuedAt: new Date().toISOString(),
      });
      if (!manifest) return { value: { error: "package_discovery_signing_unavailable" }, status: 503 };
      const responseValue = { schema_version: value.schema_version, status: "selected", manifest };
      await storage.put(discoveryKey(value.idempotency_key), { fingerprint: requestFingerprint, response: responseValue });
      return { value: responseValue, status: 200 };
    });
    return response(discovered.value, discovered.status);
  }

  async fetch(request) {
    await this.recoverDispatches();
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") return response(await this.encounterStatus());
    if (request.method === "POST" && url.pathname === "/work-items") return this.submit(await requestBody(request));
    if (request.method === "POST" && url.pathname === "/catalog-revisions") return this.recordCatalogRevision(await requestBody(request));
    if (request.method === "POST" && url.pathname === "/freeze") return this.freeze(await requestBody(request));
    if (request.method === "POST" && url.pathname === "/package-discoveries") return this.discoverPackage(await requestBody(request), request.headers.get("x-encounter-id") || undefined);
    const eventMatch = url.pathname.match(/^\/work-items\/([a-z0-9][a-z0-9-]{0,63})\/events$/);
    if (eventMatch && request.method === "POST") return this.appendEvent(eventMatch[1], await requestBody(request));
    if (eventMatch && request.method === "GET") {
      const work = await this.state.storage.get(workKey(eventMatch[1]));
      if (!work) return response({ error: "work_item_not_found" }, 404);
      return response({ work_item: workSummary(work), events: (await this.state.storage.get(eventKey(eventMatch[1]))) || [] });
    }
    return response({ error: "not_found" }, 404);
  }
}

function dispatchFailureCode(dispatched) {
  if (["work_dispatch_url_invalid", "work_dispatch_token_missing", "work_dispatch_network_error"].includes(dispatched?.error_code)) {
    return dispatched.error_code;
  }
  return Number.isInteger(dispatched?.status) && dispatched.status >= 100 && dispatched.status <= 599
    ? `work_dispatch_http_${dispatched.status}`
    : "work_dispatch_failed";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!authorized(request, env)) return response({ error: "unauthorized" }, 401);
    const workMatch = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63})\/work-items$/);
    const eventMatch = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63})\/work-items\/([a-z0-9][a-z0-9-]{0,63})\/events$/);
    const freezeMatch = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63})\/freeze$/);
    const catalogMatch = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63})\/catalog-revisions$/);
    const discoveryMatch = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63})\/package-discoveries$/);
    const statusMatch = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63})$/);
    const encounterId = workMatch?.[1] || eventMatch?.[1] || freezeMatch?.[1] || catalogMatch?.[1] || discoveryMatch?.[1] || statusMatch?.[1];
    if (!encounterId) return response({ error: "not_found" }, 404);
    const coordinator = env.ENCOUNTER_COORDINATOR.get(env.ENCOUNTER_COORDINATOR.idFromName(encounterId));
    if (workMatch && request.method === "POST") {
      const requestText = await request.text();
      let submission;
      try { submission = JSON.parse(requestText); } catch { submission = null; }
      if (submission?.work_order?.encounter_id !== encounterId) return response({ error: "encounter_path_mismatch" }, 409);
      return coordinator.fetch("https://encounter-coordinator/work-items", { method: "POST", headers: { "content-type": "application/json" }, body: requestText });
    }
    if (eventMatch && request.method === "POST") return coordinator.fetch(`https://encounter-coordinator/work-items/${eventMatch[2]}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: await request.text() });
    if (freezeMatch && request.method === "POST") {
      const requestText = await request.text();
      let requestValue;
      try { requestValue = JSON.parse(requestText); } catch { requestValue = null; }
      if (requestValue?.package?.encounter_id !== undefined && requestValue.package.encounter_id !== encounterId) return response({ error: "encounter_path_mismatch" }, 409);
      return coordinator.fetch("https://encounter-coordinator/freeze", { method: "POST", headers: { "content-type": "application/json" }, body: requestText });
    }
    if (catalogMatch && request.method === "POST") {
      if (!catalogAuthorized(request, env)) return response({ error: "catalog_acceptance_unauthorized" }, 401);
      const requestText = await request.text();
      let requestValue;
      try { requestValue = JSON.parse(requestText); } catch { requestValue = null; }
      if (requestValue?.catalog_revision?.encounter_id !== encounterId) return response({ error: "encounter_path_mismatch" }, 409);
      return coordinator.fetch("https://encounter-coordinator/catalog-revisions", { method: "POST", headers: { "content-type": "application/json" }, body: requestText });
    }
    if (discoveryMatch && request.method === "POST") {
      const requestText = await request.text();
      return coordinator.fetch("https://encounter-coordinator/package-discoveries", { method: "POST", headers: { "content-type": "application/json", "x-encounter-id": encounterId }, body: requestText });
    }
    if (statusMatch && request.method === "GET") return coordinator.fetch("https://encounter-coordinator/status");
    return response({ error: "not_found" }, 404);
  },
};
