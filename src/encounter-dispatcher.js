import { assertEncounterWorkGraph } from "./workgraph-planner.js";

/**
 * Dispatch a graph through a pluggable worker backend.
 *
 * Receipts are keyed by stable v1 work ID. Repeated coordinator deliveries
 * return the original receipt; simultaneous deliveries share one launch.
 */
export class EncounterDispatcher {
  constructor({ backend, receiptStore = new Map() } = {}) {
    if (!backend || typeof backend.launch !== "function") {
      throw new TypeError("dispatcher needs a worker backend with launch(order)");
    }
    this.backend = backend;
    this.receiptStore = receiptStore;
    this.inflight = new Map();
  }

  lookup(workId) {
    return clone(this.receiptStore.get(workId));
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
    const stored = this.receiptStore.get(order.work_id);
    if (stored) return { receipt: clone(stored), deduplicated: true };
    const running = this.inflight.get(order.work_id);
    if (running) return { receipt: clone(await running), deduplicated: true };

    const execution = this.backend.launch(order, { onEvent: (event) => allEvents.push(event) })
      .then((result) => {
        const receipt = {
          work_id: order.work_id,
          encounter_id: order.encounter_id,
          worker_id: result.worker_id,
          status: "completed",
          events: result.events.map(clone),
        };
        this.receiptStore.set(order.work_id, receipt);
        return receipt;
      })
      .finally(() => this.inflight.delete(order.work_id));
    this.inflight.set(order.work_id, execution);
    return { receipt: clone(await execution), deduplicated: false };
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
