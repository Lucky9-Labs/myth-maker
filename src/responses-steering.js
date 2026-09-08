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
}

// This deep module is deliberately independent from Durable Object storage. Its
// store adapter gives the coordinator durable receipts while tests use this fake.
export class ResponsesSteeringGateway {
  constructor({ store = new InMemorySteeringStore(), now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.lanes = new Map();
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
    if (lane) this.lanes.set(record.lane_id, lane);
    return record;
  }

  attachLane(laneId, lane) {
    if (!ID.test(laneId) || !lane || typeof lane.send !== "function") throw new Error("invalid_responses_websocket_lane");
    this.lanes.set(laneId, lane);
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
    if (!lane) return this.transition(receipt, "failed", { error_code: "steering_transport_unavailable_after_reconnect" });
    const frame = attempt.response_status === "completed"
      ? { type: "response.create", previous_response_id: attempt.response_id, input: request.input }
      : { type: "response.steer", previous_response_id: attempt.response_id, input: request.input };
    // Persist before writing: after a crash/reconnect the request is failed,
    // never replayed, because the server may have received the frame.
    const queued = await this.transition(receipt, "queued", { transport: frame.type });
    try { lane.send(JSON.stringify(frame)); } catch { return this.transition(queued, "failed", { error_code: "steering_transport_send_failed" }); }
    return queued;
  }

  async transition(receipt, status, fields = {}) {
    if (!STEERING_STATUSES.has(status)) throw new Error("invalid_steering_status");
    const persisted = await this.store.getReceipt(receipt.client_steering_id);
    const current = persisted || receipt;
    const allowed = { queued: new Set(["queued", "accepted", "pending", "required_input", "failed", "unsupported"]), accepted: new Set(["accepted", "pending", "required_input", "committed", "failed"]), pending: new Set(["pending", "required_input", "committed", "failed"]), required_input: new Set(["required_input", "committed", "failed"]), committed: new Set(["committed"]), failed: new Set(["failed"]), unsupported: new Set(["unsupported"]) };
    if (!allowed[current.status || "queued"].has(status)) return current;
    const next = { ...current, ...fields, status, updated_at: this.now() };
    await this.store.putReceipt(next);
    await this.store.appendEvent(next.client_steering_id, { status, occurred_at: next.updated_at, ...fields });
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
      if (receipt.lane_id === laneId && ACTIVE_STATUSES.has(receipt.status)) affected.push(await this.transition(receipt, "failed", { error_code: "steering_transport_reconnect_uncertain" }));
    }
    return affected;
  }

  async handleServerEvent(laneId, event) {
    if (!isObject(event) || typeof event.type !== "string") return [];
    const response = event.response || {};
    const previous = event.previous_response_id || response.previous_response_id;
    if (event.type === "response.completed" && typeof response.id === "string") {
      const attempts = await this.store.listAttempts();
      await Promise.all(attempts.filter((attempt) => attempt.lane_id === laneId && attempt.response_id === response.id).map((attempt) => this.store.putAttempt({ ...attempt, response_status: "completed", updated_at: this.now() })));
      return [];
    }
    if (!previous) return [];
    const matching = (await this.store.listReceipts(undefined)).filter((receipt) => receipt.lane_id === laneId && ACTIVE_STATUSES.has(receipt.status));
    const target = matching.filter((receipt) => !previous || receipt.response_id === previous).sort((a, b) => a.requested_at.localeCompare(b.requested_at));
    if (event.type === "response.steer.accepted") return target.length ? [await this.transition(target[0], "accepted", { accepted_at: this.now() })] : [];
    if (event.type === "response.created" && typeof response.id === "string" && previous) {
      const committed = [];
      for (const receipt of target.slice(0, 1)) committed.push(await this.transition(receipt, "committed", { committed_at: this.now(), successor_response_id: response.id }));
      for (const receipt of committed) {
        const attempt = await this.store.getAttempt(receipt.attempt_id);
        await this.store.putAttempt({ ...attempt, response_id: response.id, response_status: "in_progress", updated_at: this.now() });
      }
      return committed;
    }
    if (event.type === "response.incomplete" && response.incomplete_details?.reason === "steered") return Promise.all(target.map((receipt) => this.transition(receipt, "pending", { pending_reason: "steered" })));
    if (event.type === "response.required_input" || (event.type === "response.incomplete" && response.incomplete_details?.reason === "tool_use")) return Promise.all(target.map((receipt) => this.transition(receipt, "required_input", { pending_reason: "required_tool_input" })));
    if (event.type === "error" || event.type === "response.failed") return Promise.all(target.map((receipt) => this.transition(receipt, "failed", { error_code: "responses_steering_failed" })));
    return [];
  }
}
