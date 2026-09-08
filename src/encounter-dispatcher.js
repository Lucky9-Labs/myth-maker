import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { assertEncounterWorkGraph, assertEncounterWorkOrder } from "./workgraph-planner.js";
import { isV1WorkerEvent } from "./worker.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ACTIVE = new Set(["started", "heartbeat", "progress", "candidate_produced"]);

export class EventDeliveryError extends Error {}
export class InvalidWorkerEventsError extends Error {}

/** Work dispatcher with a receipt and event outbox distinct from event delivery. */
export class EncounterDispatcher {
  constructor({ backend, receiptStore = new InMemoryReceiptStore() } = {}) {
    if (!backend || typeof backend.launch !== "function") throw new TypeError("dispatcher needs a worker backend with launch(order)");
    if (!["get", "claim", "finish", "markDelivered", "listUndelivered"].every((method) => typeof receiptStore?.[method] === "function")) throw new TypeError("receiptStore needs async receipt/outbox methods");
    this.backend = backend;
    this.receiptStore = receiptStore;
  }

  async lookup(workId) { return clone(await this.receiptStore.get(workId)); }

  async dispatchWorkOrder(order) {
    assertEncounterWorkOrder(order);
    const claim = await this.receiptStore.claim(order.work_id, digest(order));
    if (claim.kind !== "claimed") return { receipt: clone(claim.receipt), events: [], deduplicated: true };
    const observed = [];
    try {
      const result = await this.backend.launch(order, { onEvent: (event) => observed.push(event) });
      const events = result.events?.map(clone) || observed;
      validateEvents(order, events);
      const receipt = makeReceipt(order, result.worker_id, events);
      await this.receiptStore.finish(order.work_id, receipt, claim.leaseToken);
      return { receipt: clone(receipt), events: events.map(clone), deduplicated: false };
    } catch (error) {
      if (error instanceof InvalidWorkerEventsError) {
        await this.receiptStore.finish(order.work_id, invalidReceipt(order, error.message), claim.leaseToken);
        throw error;
      }
      const failure = failureEvent(order, observed, error);
      const events = [...observed, failure];
      try { validateEvents(order, events); }
      catch (validationError) {
        await this.receiptStore.finish(order.work_id, invalidReceipt(order, validationError.message), claim.leaseToken);
        throw validationError;
      }
      const receipt = makeReceipt(order, failure.worker_id, events);
      await this.receiptStore.finish(order.work_id, receipt, claim.leaseToken);
      return { receipt: clone(receipt), events: receipt.events.map(clone), deduplicated: false };
    }
  }

  async dispatch(graph) {
    assertEncounterWorkGraph(graph);
    const pending = new Map(graph.work_orders.map((order) => [order.work_id, order]));
    const receipts = new Map(), events = [], deduplicated = [];
    while (pending.size) {
      const ready = [...pending.values()].filter((order) => (order.depends_on_work_ids || []).every((id) => receipts.get(id)?.status === "completed"));
      if (!ready.length) throw new Error("no ready work orders; dependency receipts are incomplete");
      ready.forEach((order) => pending.delete(order.work_id));
      await Promise.all(ready.map(async (order) => { const result = await this.dispatchWorkOrder(order); receipts.set(order.work_id, result.receipt); events.push(...result.events); if (result.deduplicated) deduplicated.push(order.work_id); }));
    }
    return { encounter_id: graph.encounter_id, receipts: graph.work_orders.map((order) => clone(receipts.get(order.work_id))), events: events.map(clone), deduplicated_work_ids: deduplicated.sort() };
  }

  async flush(workId, eventSink) {
    const receipt = await this.receiptStore.get(workId);
    if (!receipt || receipt.status === "invalid") throw new InvalidWorkerEventsError("work receipt is not deliverable");
    for (const entry of receipt.outbox) {
      if (entry.delivered) continue;
      try { await eventSink.append(workId, entry.event); }
      catch (error) { throw new EventDeliveryError(`event ${entry.event.event_id} delivery failed: ${error.message || error}`); }
      await this.receiptStore.markDelivered(workId, entry.event.event_id);
    }
    return this.lookup(workId);
  }

  async recoverDeliveries(eventSink) { for (const receipt of await this.receiptStore.listUndelivered()) await this.flush(receipt.work_id, eventSink); }
}

export class InMemoryReceiptStore {
  constructor() { this.records = new Map(); }
  async get(workId) { return clone(this.records.get(workId)); }
  async claim(workId, requestFingerprint) {
    const prior = this.records.get(workId);
    if (prior) { if (prior.request_fingerprint !== requestFingerprint) throw new Error("work_id reused with a different work order"); return { kind: "existing", receipt: clone(prior) }; }
    this.records.set(workId, { work_id: workId, request_fingerprint: requestFingerprint, status: "dispatching", events: [], outbox: [] });
    return { kind: "claimed" };
  }
  async finish(workId, receipt) { this.records.set(workId, clone(receipt)); }
  async markDelivered(workId, eventId) { this.records.get(workId).outbox.find((entry) => entry.event.event_id === eventId).delivered = true; }
  async listUndelivered() { return [...this.records.values()].filter((record) => record.outbox?.some((entry) => !entry.delivered)).map(clone); }
}

/** Restartable local receipt/outbox proof store. Production Railway needs a leased database equivalent. */
export class JsonReceiptStore {
  constructor(path) { this.path = path; this.lockPath = `${path}.lock`; }
  async get(workId) { return clone((await this.#read())[workId]); }
  async claim(workId, requestFingerprint) { return this.#mutate((records) => { const prior = records[workId]; if (prior) { if (prior.request_fingerprint !== requestFingerprint) throw new Error("work_id reused with a different work order"); return { kind: "existing", receipt: clone(prior) }; } records[workId] = { work_id: workId, request_fingerprint: requestFingerprint, status: "dispatching", events: [], outbox: [] }; return { kind: "claimed" }; }); }
  async finish(workId, receipt) { await this.#mutate((records) => { records[workId] = clone(receipt); }); }
  async markDelivered(workId, eventId) { await this.#mutate((records) => { records[workId].outbox.find((entry) => entry.event.event_id === eventId).delivered = true; }); }
  async listUndelivered() { return Object.values(await this.#read()).filter((record) => record.outbox?.some((entry) => !entry.delivered)).map(clone); }
  async #read() { try { return JSON.parse(await readFile(this.path, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; } }
  async #mutate(callback) { await mkdir(this.lockPath); try { const records = await this.#read(); const value = callback(records); const temporary = `${this.path}.tmp`; await writeFile(temporary, JSON.stringify(records)); await rename(temporary, this.path); return value; } finally { await rm(this.lockPath, { recursive: true, force: true }); } }
}

function makeReceipt(order, workerId, events) { return { work_id: order.work_id, encounter_id: order.encounter_id, worker_id: workerId, status: events.at(-1).kind, request_fingerprint: digest(order), events: events.map(clone), outbox: events.map((event) => ({ event: clone(event), delivered: false })) }; }
function invalidReceipt(order, reason) { return { work_id: order.work_id, encounter_id: order.encounter_id, status: "invalid", request_fingerprint: digest(order), events: [], outbox: [], invalid_reason: reason }; }
function failureEvent(order, events, error) { const last = events.at(-1); const workerId = last?.worker_id || "dispatch-backend"; return { schema_version: "1", event_id: `evt-${createHash("sha256").update(`${order.work_id}:launch-failed`).digest("hex").slice(0, 32)}`, work_id: order.work_id, encounter_id: order.encounter_id, worker_id: workerId, sequence: (last?.sequence ?? -1) + 1, occurred_at: new Date().toISOString(), kind: "failed", error_code: "worker_launch_failed", retryable: true, message: String(error.message || error).slice(0, 2000) }; }
function validateEvents(order, events) { if (!Array.isArray(events) || !events.length) throw new InvalidWorkerEventsError("backend returned no WorkerEvents"); let worker, sequence = -1, state = "dispatching"; for (const event of events) { if (!isV1WorkerEvent(event) || event.work_id !== order.work_id || event.encounter_id !== order.encounter_id || event.sequence <= sequence) throw new InvalidWorkerEventsError("backend event does not match the closed v1 WorkerEvent envelope"); if (worker && worker !== event.worker_id) throw new InvalidWorkerEventsError("backend events must bind one worker"); worker ||= event.worker_id; sequence = event.sequence; if (state === "dispatching" && event.kind === "accepted") state = "accepted"; else if (state === "accepted" && event.kind === "started") state = "running"; else if (state === "running" && ACTIVE.has(event.kind)) state = "running"; else if (["dispatching", "accepted", "running"].includes(state) && TERMINAL.has(event.kind)) state = "terminal"; else throw new InvalidWorkerEventsError("backend event lifecycle is illegal"); } if (state !== "terminal") throw new InvalidWorkerEventsError("backend events must end terminally"); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
