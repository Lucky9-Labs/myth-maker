const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESPONSE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const STEERING_STATUSES = new Set(["queued", "accepted", "pending", "required_input", "committed", "failed", "unsupported"]);
const ACTIVE_STATUSES = new Set(["queued", "accepted", "pending", "required_input"]);

function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function copy(value) { return structuredClone(value); }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validInput(input) {
  if (!Array.isArray(input) || input.length !== 1 || !isObject(input[0]) || input[0].role !== "user" || !Array.isArray(input[0].content) || input[0].content.length < 1 || input[0].content.length > 8) return false;
  return input[0].content.every((part) => isObject(part) && (
    (part.type === "input_text" && typeof part.text === "string" && part.text.length > 0 && part.text.length <= 12000 && Object.keys(part).every((key) => ["type", "text"].includes(key)))
    || (part.type === "input_image" && ((typeof part.image_url === "string" && part.image_url.length <= 8192) || (typeof part.file_id === "string" && part.file_id.length <= 256)) && (part.image_url === undefined || (typeof part.image_url === "string" && part.image_url.length <= 8192)) && (part.file_id === undefined || (typeof part.file_id === "string" && part.file_id.length <= 256)) && (part.detail === undefined || ["low", "high", "auto"].includes(part.detail)) && Object.keys(part).every((key) => ["type", "image_url", "file_id", "detail"].includes(key)))
    || (part.type === "input_file" && ((typeof part.file_id === "string" && part.file_id.length <= 256) || (typeof part.file_url === "string" && part.file_url.length <= 2048)) && (part.file_id === undefined || (typeof part.file_id === "string" && part.file_id.length <= 256)) && (part.file_url === undefined || (typeof part.file_url === "string" && part.file_url.length <= 2048)) && (part.filename === undefined || (typeof part.filename === "string" && part.filename.length <= 255)) && Object.keys(part).every((key) => ["type", "file_id", "file_url", "filename"].includes(key)))
  ));
}

function boundedInput(input) {
  const content = input[0].content;
  if (content.length === 1 && content[0].type === "input_text") return { text: content[0].text };
  return { content: copy(content) };
}

function supportsSteering(attempt) {
  return attempt.mode === "single_agent" && attempt.model_supports_steering === true
    && attempt.conversation_mode !== true && attempt.automatic_compaction !== true;
}

function unsupportedReason(attempt) {
  if (attempt.mode !== "single_agent") return "multi_agent_mode_unsupported";
  if (attempt.model_supports_steering !== true) return "model_unsupported";
  if (attempt.conversation_mode === true) return "conversation_mode_unsupported";
  if (attempt.automatic_compaction === true) return "automatic_compaction_unsupported";
  return "steering_unsupported";
}

export class InMemorySteeringStore {
  constructor() { this.attempts = new Map(); this.receipts = new Map(); this.events = new Map(); }
  async getAttempt(id) { return copy(this.attempts.get(id)); }
  async putAttempt(attempt) { this.attempts.set(attempt.attempt_id, copy(attempt)); }
  async listAttempts() { return [...this.attempts.values()].map(copy); }
  async getReceipt(id) { return copy(this.receipts.get(id)); }
  async putReceipt(receipt) { this.receipts.set(receipt.client_steering_id, copy(receipt)); }
  async listReceipts(workId) { return [...this.receipts.values()].filter((receipt) => workId === undefined || receipt.work_id === workId).map(copy).sort((a, b) => a.requested_at.localeCompare(b.requested_at)); }
  async appendEvent(id, event) { this.events.set(id, [...(this.events.get(id) || []), copy(event)]); }
  async listEvents(id) { return (this.events.get(id) || []).map(copy); }
  async commitTransition(receipt, event) { await this.putReceipt(receipt); await this.appendEvent(receipt.client_steering_id, event); }
}

// This deep module is deliberately independent from Durable Object storage. Its
// store adapter gives the coordinator durable receipts while tests use this fake.
export class ResponsesSteeringGateway {
  constructor({ store = new InMemorySteeringStore(), now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.lanes = new Map();
    this.boundLanes = new WeakSet();
  }

  async recordAttempt(attempt, lane) {
    const fields = new Set(["attempt_id", "encounter_id", "work_id", "worker_id", "lane_id", "response_id", "mode", "model_supports_steering", "conversation_mode", "automatic_compaction", "response_status"]);
    if (!isObject(attempt) || !Object.keys(attempt).every((field) => fields.has(field)) || ![attempt.attempt_id, attempt.encounter_id, attempt.work_id, attempt.worker_id, attempt.lane_id].every((id) => typeof id === "string" && ID.test(id)) || typeof attempt.response_id !== "string" || !RESPONSE_ID.test(attempt.response_id)) throw new Error("invalid_steering_attempt");
    const record = { ...copy(attempt), response_status: attempt.response_status || "in_progress", recorded_at: this.now() };
    const existing = await this.store.getAttempt(record.attempt_id);
    if (existing) {
      const { recorded_at: _ignored, ...prior } = existing;
      const { recorded_at: _alsoIgnored, ...candidate } = record;
      if (canonicalJson(prior) !== canonicalJson(candidate)) throw new Error("steering_attempt_id_reused_with_different_attempt");
      return existing;
    }
    await this.store.putAttempt(record);
    if (lane) this.attachLane(record.lane_id, lane);
    return record;
  }

  attachLane(laneId, lane) {
    if (!ID.test(laneId) || !lane || typeof lane.send !== "function") throw new Error("invalid_responses_websocket_lane");
    this.lanes.set(laneId, lane);
    if (typeof lane.addEventListener !== "function" || this.boundLanes.has(lane)) return;
    this.boundLanes.add(lane);
    lane.addEventListener("message", (message) => {
      const data = typeof message.data === "string" ? message.data : null;
      if (!data) return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      void this.handleServerEvent(laneId, event).catch(() => this.handleDisconnect(laneId));
    });
    lane.addEventListener("close", () => { void this.handleDisconnect(laneId); });
    lane.addEventListener("error", () => { void this.handleDisconnect(laneId); });
  }

  async requestSteer(attemptId, request) {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new Error("steering_attempt_not_found");
    if (!isObject(request) || !ID.test(request.client_steering_id || "") || !validInput(request.input)) throw new Error("invalid_steering_request");
    const inputHash = await sha256(request.input);
    const existing = await this.store.getReceipt(request.client_steering_id);
    if (existing) {
      if (existing.input_sha256 !== inputHash || existing.attempt_id !== attemptId) throw new Error("client_steering_id_reused_with_different_request");
      return existing;
    }
    const inFlight = (await this.store.listReceipts(undefined)).find((receipt) => receipt.attempt_id === attemptId && receipt.response_id === attempt.response_id && ACTIVE_STATUSES.has(receipt.status));
    if (inFlight) throw new Error("steering_request_already_pending");
    const receipt = {
      schema_version: "1", client_steering_id: request.client_steering_id, attempt_id: attemptId,
      encounter_id: attempt.encounter_id, work_id: attempt.work_id, worker_id: attempt.worker_id,
      response_id: attempt.response_id, lane_id: attempt.lane_id, input_sha256: inputHash,
      input: boundedInput(request.input), requested_at: this.now(), status: "queued",
    };
    if (!supportsSteering(attempt)) return this.transition(receipt, "unsupported", { error_code: unsupportedReason(attempt) });
    const lane = this.lanes.get(attempt.lane_id);
    if (!lane) return this.transition(receipt, "pending", { reconciliation: "transport_ack_uncertain", error_code: "steering_transport_unavailable_after_reconnect" });
    const frame = attempt.response_status === "completed"
      ? { type: "response.create", previous_response_id: attempt.response_id, input: request.input }
      : { type: "response.steer", previous_response_id: attempt.response_id, input: request.input };
    // Persist before writing: after a crash/reconnect the request is failed,
    // never replayed, because the server may have received the frame.
    const queued = await this.transition(receipt, "queued", { transport: frame.type });
    try { lane.send(JSON.stringify(frame)); } catch { return this.transition(queued, "pending", { reconciliation: "transport_ack_uncertain", error_code: "steering_transport_send_uncertain" }); }
    return queued;
  }

  async enqueueSteer(attemptId, request) {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new Error("steering_attempt_not_found");
    if (!isObject(request) || !ID.test(request.client_steering_id || "") || !validInput(request.input)) throw new Error("invalid_steering_request");
    const inputHash = await sha256(request.input);
    const existing = await this.store.getReceipt(request.client_steering_id);
    if (existing) {
      if (existing.input_sha256 !== inputHash || existing.attempt_id !== attemptId) throw new Error("client_steering_id_reused_with_different_request");
      return existing;
    }
    const inFlight = (await this.store.listReceipts(undefined)).find((receipt) => receipt.attempt_id === attemptId && receipt.response_id === attempt.response_id && ACTIVE_STATUSES.has(receipt.status));
    if (inFlight) throw new Error("steering_request_already_pending");
    const receipt = { schema_version: "1", client_steering_id: request.client_steering_id, attempt_id: attemptId, encounter_id: attempt.encounter_id, work_id: attempt.work_id, worker_id: attempt.worker_id, response_id: attempt.response_id, lane_id: attempt.lane_id, input_sha256: inputHash, input: boundedInput(request.input), requested_at: this.now(), status: "queued" };
    if (!supportsSteering(attempt)) return this.transition(receipt, "unsupported", { error_code: unsupportedReason(attempt) });
    return this.transition(receipt, "queued", { transport: attempt.response_status === "completed" ? "response.create" : "response.steer" });
  }

  async importReceipt(receipt) {
    if (!isObject(receipt) || !ID.test(receipt.client_steering_id || "")) throw new Error("invalid_steering_receipt_report");
    const existing = await this.store.getReceipt(receipt.client_steering_id);
    if (!existing || existing.attempt_id !== receipt.attempt_id || existing.lane_id !== receipt.lane_id || existing.response_id !== receipt.response_id || existing.input_sha256 !== receipt.input_sha256) throw new Error("steering_receipt_report_scope_mismatch");
    const fields = { ...receipt };
    delete fields.status; delete fields.client_steering_id; delete fields.attempt_id; delete fields.encounter_id; delete fields.work_id; delete fields.worker_id; delete fields.response_id; delete fields.lane_id; delete fields.input_sha256; delete fields.input; delete fields.requested_at;
    return this.transition(existing, receipt.status, fields);
  }

  async transition(receipt, status, fields = {}) {
    if (!STEERING_STATUSES.has(status)) throw new Error("invalid_steering_status");
    const persisted = await this.store.getReceipt(receipt.client_steering_id);
    const current = persisted || receipt;
    const allowed = { queued: new Set(["queued", "accepted", "pending", "required_input", "failed", "unsupported"]), accepted: new Set(["accepted", "pending", "required_input", "committed", "failed"]), pending: new Set(["pending", "required_input", "committed", "failed"]), required_input: new Set(["required_input", "pending", "committed", "failed"]), committed: new Set(["committed"]), failed: new Set(["failed"]), unsupported: new Set(["unsupported"]) };
    if (!allowed[current.status || "queued"].has(status)) return current;
    const next = { ...current, ...fields, status, updated_at: this.now() };
    const event = { status, occurred_at: next.updated_at, ...fields };
    if (typeof this.store.commitTransition === "function") await this.store.commitTransition(next, event);
    else { await this.store.putReceipt(next); await this.store.appendEvent(next.client_steering_id, event); }
    return next;
  }

  async getReceipt(id) {
    const receipt = await this.store.getReceipt(id);
    return receipt && { ...receipt, events: await this.store.listEvents(id) };
  }

  async listReceipts(workId) { return Promise.all((await this.store.listReceipts(workId)).map((receipt) => this.getReceipt(receipt.client_steering_id))); }

  async handleDisconnect(laneId) {
    this.lanes.delete(laneId);
    const affected = [];
    for (const receipt of await this.store.listReceipts(undefined)) {
      // A dropped socket cannot prove that OpenAI did not receive the steer.
      // Keep a reconciliation record instead of treating it as terminal or
      // replaying a command that may already have taken effect.
      if (receipt.lane_id === laneId && ACTIVE_STATUSES.has(receipt.status)) affected.push(await this.transition(receipt, "pending", { reconciliation: "transport_ack_uncertain", error_code: "steering_transport_reconnect_uncertain" }));
    }
    return affected;
  }

  async handleServerEvent(laneId, event) {
    if (!isObject(event) || typeof event.type !== "string") return [];
    const response = event.response || {};
    // The Responses steering beta nests its correlation values under `steer`.
    // Legacy root-level fields remain accepted only for old recorded fixtures.
    const steer = isObject(event.steer) ? event.steer : isObject(response.steer) ? response.steer : {};
    const previous = steer.previous_response_id || event.previous_response_id || response.previous_response_id;
    const serverSteeringId = steer.id;
    if (event.type === "response.completed" && typeof response.id === "string") {
      const attempts = await this.store.listAttempts();
      await Promise.all(attempts.filter((attempt) => attempt.lane_id === laneId && attempt.response_id === response.id).map((attempt) => this.store.putAttempt({ ...attempt, response_status: "completed", updated_at: this.now() })));
      return [];
    }
    if (!previous) return [];
    const matching = (await this.store.listReceipts(undefined)).filter((receipt) => receipt.lane_id === laneId && ACTIVE_STATUSES.has(receipt.status));
    const target = matching.filter((receipt) => receipt.response_id === previous && (!serverSteeringId || !receipt.server_steering_id || receipt.server_steering_id === serverSteeringId)).sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    const correlation = serverSteeringId ? { server_steering_id: serverSteeringId } : {};
    if (event.type === "response.steer.accepted") return target.length ? [await this.transition(target[0], "accepted", { accepted_at: this.now(), ...correlation })] : [];
    if (event.type === "response.steer.pending") return target.length ? [await this.transition(target[0], "pending", { pending_at: this.now(), ...correlation })] : [];
    if (event.type === "response.steer.failed") return target.length ? [await this.transition(target[0], "failed", { error_code: steer.error?.code || "responses_steering_failed", ...correlation })] : [];
    if (event.type === "response.created" && typeof response.id === "string" && previous) {
      const committed = [];
      for (const receipt of target.slice(0, 1)) committed.push(await this.transition(receipt, "committed", { committed_at: this.now(), successor_response_id: response.id }));
      for (const receipt of committed) {
        const attempt = await this.store.getAttempt(receipt.attempt_id);
        await this.store.putAttempt({ ...attempt, response_id: response.id, response_status: "in_progress", updated_at: this.now() });
      }
      return committed;
    }
    if (event.type === "response.incomplete" && response.incomplete_details?.reason === "steered") return Promise.all(target.map((receipt) => this.transition(receipt, "pending", { pending_reason: "steered", ...correlation })));
    if (event.type === "response.required_input" || (event.type === "response.incomplete" && response.incomplete_details?.reason === "tool_use")) {
      const stubs = steer.required_input || event.required_input || response.required_input || [];
      return Promise.all(target.map((receipt) => this.transition(receipt, "required_input", { pending_reason: "required_tool_input", required_input: copy(stubs), ...correlation })));
    }
    if (event.type === "error" || event.type === "response.failed") return Promise.all(target.map((receipt) => this.transition(receipt, "failed", { error_code: "responses_steering_failed" })));
    return [];
  }

  async resolveRequiredInput(attemptId, savedResults) {
    const attempt = await this.store.getAttempt(attemptId);
    if (!attempt) throw new Error("steering_attempt_not_found");
    const candidates = (await this.store.listReceipts(undefined)).filter((receipt) => receipt.attempt_id === attemptId && receipt.response_id === attempt.response_id && receipt.status === "required_input");
    if (!candidates.length) return [];
    const lane = this.lanes.get(attempt.lane_id);
    if (!lane) return Promise.all(candidates.map((receipt) => this.transition(receipt, "pending", { reconciliation: "transport_ack_uncertain", error_code: "steering_transport_reconnect_uncertain" })));
    const emitted = [];
    for (const receipt of candidates) {
      if (receipt.continuation_sent_at) { emitted.push(receipt); continue; }
      const stubs = Array.isArray(receipt.required_input) ? receipt.required_input : [];
      const input = stubs.map((stub) => savedResults?.[stub.id || stub.call_id]).filter((value) => value !== undefined);
      if (input.length !== stubs.length) throw new Error("required_input_result_missing");
      const queued = await this.transition(receipt, "pending", { continuation_sent_at: this.now(), continuation_input_hash: await sha256(input) });
      try { lane.send(JSON.stringify({ type: "response.create", previous_response_id: receipt.response_id, input })); }
      catch { emitted.push(await this.transition(queued, "pending", { reconciliation: "transport_ack_uncertain", error_code: "steering_transport_send_uncertain" })); continue; }
      emitted.push(queued);
    }
    return emitted;
  }
}

/**
 * Owns a real Responses socket in the worker process. The coordinator never
 * receives this object: it receives authenticated attempt/receipt reports.
 */
export class ResponsesSteeringWorker {
  constructor({ reporter, gateway = new ResponsesSteeringGateway() } = {}) {
    if (!reporter || typeof reporter.registerAttempt !== "function" || typeof reporter.reportReceipt !== "function") throw new TypeError("steering worker needs an authenticated reporter");
    this.reporter = reporter;
    this.gateway = gateway;
  }

  async registerAttempt(attempt, socket) {
    const recorded = await this.gateway.recordAttempt(attempt, socket);
    await this.reporter.registerAttempt(attempt);
    return recorded;
  }

  async acceptCommand({ attempt_id, request }) {
    const receipt = await this.gateway.requestSteer(attempt_id, request);
    await this.reporter.reportReceipt(receipt);
    return receipt;
  }

  async receive(laneId, event) {
    const receipts = await this.gateway.handleServerEvent(laneId, event);
    await Promise.all(receipts.map((receipt) => this.reporter.reportReceipt(receipt)));
    return receipts;
  }

  async disconnect(laneId) {
    const receipts = await this.gateway.handleDisconnect(laneId);
    await Promise.all(receipts.map((receipt) => this.reporter.reportReceipt(receipt)));
    return receipts;
  }

  async resolveRequiredInput(attemptId, savedResults) {
    const receipts = await this.gateway.resolveRequiredInput(attemptId, savedResults);
    await Promise.all(receipts.map((receipt) => this.reporter.reportReceipt(receipt)));
    return receipts;
  }
}

export function createCoordinatorSteeringReporter({ coordinatorUrl, workerToken, fetcher = fetch } = {}) {
  if (!coordinatorUrl || !workerToken) throw new TypeError("coordinatorUrl and workerToken are required");
  const base = coordinatorUrl.replace(/\/$/, "");
  async function post(path, body) {
    const result = await fetcher(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${workerToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!result.ok) throw new Error(`coordinator_steering_report_failed:${result.status}`);
  }
  return {
    registerAttempt(attempt) { return post(`/v1/encounters/${attempt.encounter_id}/work-items/${attempt.work_id}/steering-attempts`, attempt); },
    reportReceipt(receipt) { return post(`/v1/encounters/${receipt.encounter_id}/work-items/${receipt.work_id}/steering-receipts`, receipt); },
  };
}

export function createSteeringWorkerCommandHandler({ worker, workerToken } = {}) {
  if (!worker || typeof worker.acceptCommand !== "function" || !workerToken) throw new TypeError("worker and workerToken are required");
  return async (request) => {
    if (request.method !== "POST") return steeringResponse({ error: "not_found" }, 404);
    if (request.headers.get("authorization") !== `Bearer ${workerToken}`) return steeringResponse({ error: "unauthorized" }, 401);
    let command;
    try { command = await request.json(); } catch { return steeringResponse({ error: "invalid_steering_command" }, 400); }
    try { return steeringResponse({ receipt: await worker.acceptCommand(command) }, 202); }
    catch (error) { return steeringResponse({ error: error.message || "invalid_steering_command" }, 409); }
  };
}

function steeringResponse(value, status) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } }); }
