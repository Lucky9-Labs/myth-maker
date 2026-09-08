import { createHash } from "node:crypto";
import { assertEncounterWorkGraph, assertEncounterWorkOrder } from "./workgraph-planner.js";

/**
 * Dispatch a graph through a pluggable worker backend.
 *
 * Receipts are keyed by stable v1 work ID. Repeated coordinator deliveries
 * return the original receipt; simultaneous deliveries share one launch.
 */
export class EncounterDispatcher {
  constructor({ backend, receiptStore = new InMemoryReceiptStore() } = {}) {
    if (!backend || typeof backend.launch !== "function") {
      throw new TypeError("dispatcher needs a worker backend with launch(order)");
    }
    this.backend = backend;
    this.receiptStore = receiptStore;
    if (typeof receiptStore.get !== "function" || typeof receiptStore.claim !== "function" || typeof receiptStore.complete !== "function") {
      throw new TypeError("receiptStore must provide atomic get, claim, and complete operations");
    }
  }

  lookup(workId) {
    return clone(this.receiptStore.get(workId));
  }

  async dispatchWorkOrder(order) {
    assertEncounterWorkOrder(order);
    const events = [];
    const result = await this.#dispatchWork(order, events);
    return {
      receipt: clone(result.receipt),
      events: events.map(clone),
      deduplicated: result.deduplicated,
    };
  }

  async dispatch(graph) {
    assertEncounterWorkGraph(graph);
    const allEvents = [];
    const deduplicated = [];
    const pending = new Map(graph.work_orders.map((order) => [order.work_id, order]));
    const receipts = new Map();

    while (pending.size > 0) {
      const ready = [...pending.values()].filter((order) => (order.depends_on_work_ids || [])
        .every((dependency) => receipts.get(dependency)?.status === "completed" || this.receiptStore.get(dependency)?.status === "completed"));
      if (ready.length === 0) throw new Error("no ready work orders; dependency receipts are incomplete");
      for (const order of ready) pending.delete(order.work_id);
      const resolved = await Promise.all(ready.map(async (order) => {
        const result = await this.#dispatchWork(order, allEvents);
        if (result.deduplicated) deduplicated.push(order.work_id);
        receipts.set(order.work_id, result.receipt);
      }));
      void resolved;
    }

    return {
      encounter_id: graph.encounter_id,
      receipts: graph.work_orders.map((order) => clone(receipts.get(order.work_id))),
      events: allEvents.map(clone),
      deduplicated_work_ids: deduplicated.sort(),
    };
  }

  async #dispatchWork(order, allEvents) {
    const claim = this.receiptStore.claim(order.work_id);
    if (claim.kind === "completed") return { receipt: clone(claim.receipt), deduplicated: true };
    if (claim.kind === "running") return { receipt: clone(await claim.completion), deduplicated: true };

    const workEvents = [];
    const execution = this.backend.launch(order, { onEvent: (event) => { workEvents.push(event); allEvents.push(event); } })
      .then((result) => {
        const terminal = result.events.at(-1);
        if (!terminal || !["completed", "failed", "cancelled"].includes(terminal.kind)) {
          throw new Error(`worker ${order.work_id} did not return a terminal WorkerEvent`);
        }
        const receipt = {
          work_id: order.work_id,
          encounter_id: order.encounter_id,
          worker_id: result.worker_id,
          status: terminal.kind,
          events: result.events.map(clone),
        };
        this.receiptStore.complete(order.work_id, receipt);
        return receipt;
      })
      .catch((error) => {
        const last = workEvents.at(-1);
        const workerId = last?.worker_id || "dispatch-backend";
        const failure = {
          schema_version: "1",
          event_id: `evt-${createHash("sha256").update(`${order.work_id}:launch-failed`).digest("hex").slice(0, 32)}`,
          work_id: order.work_id,
          encounter_id: order.encounter_id,
          worker_id: workerId,
          sequence: (last?.sequence ?? -1) + 1,
          occurred_at: new Date().toISOString(),
          kind: "failed",
          error_code: "worker_launch_failed",
          retryable: true,
          message: String(error.message || error).slice(0, 2000),
        };
        workEvents.push(failure);
        allEvents.push(failure);
        const receipt = { work_id: order.work_id, encounter_id: order.encounter_id, worker_id: workerId, status: "failed", events: workEvents.map(clone) };
        this.receiptStore.complete(order.work_id, receipt);
        return receipt;
      });
    return { receipt: clone(await execution), deduplicated: false };
  }
}

/** Local/test implementation of the atomic-claim receipt-store contract. */
export class InMemoryReceiptStore {
  constructor() {
    this.receipts = new Map();
    this.claims = new Map();
  }

  get(workId) { return this.receipts.get(workId); }

  claim(workId) {
    const receipt = this.receipts.get(workId);
    if (receipt) return { kind: "completed", receipt };
    const claim = this.claims.get(workId);
    if (claim) return { kind: "running", completion: claim.completion };
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    this.claims.set(workId, { completion, resolve });
    return { kind: "claimed" };
  }

  complete(workId, receipt) {
    this.receipts.set(workId, receipt);
    const claim = this.claims.get(workId);
    if (claim) claim.resolve(receipt);
    this.claims.delete(workId);
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
