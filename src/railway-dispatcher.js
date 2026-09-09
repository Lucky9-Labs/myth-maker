import { assertDispatchWorkOrder, EventDeliveryError, InvalidWorkerEventsError } from "./encounter-dispatcher.js";

/**
 * HTTP adapter for the Railway control-plane service.
 *
 * The coordinator's WorkDispatcherAdapter sends a raw v1 EncounterWorkOrder
 * with `x-work-id`. The handler verifies both identities before invoking the
 * injected dispatcher. Production Railway wiring must provide a receipt store
 * that survives restarts; `Map` is intentionally only the local/test default.
 */
export function createRailwayDispatchHandler({ dispatcher, dispatchToken, eventSink, defer = false, onBackgroundError = console.error } = {}) {
  if (!dispatcher || typeof dispatcher.dispatchWorkOrder !== "function") {
    throw new TypeError("Railway handler needs an EncounterDispatcher");
  }
  if (!dispatchToken || typeof dispatchToken !== "string") {
    throw new TypeError("Railway handler needs the coordinator dispatch token");
  }
  if (!eventSink || typeof eventSink.append !== "function") {
    throw new TypeError("Railway handler needs an ordered coordinator event sink");
  }
  return async function handle(request) {
    if (request.method !== "POST") return response({ error: "not_found" }, 404);
    if (request.headers.get("authorization") !== `Bearer ${dispatchToken}`) {
      return response({ error: "unauthorized" }, 401);
    }
    let workOrder;
    try { workOrder = await request.json(); } catch { return response({ error: "invalid_work_order" }, 400); }
    const suppliedWorkId = request.headers.get("x-work-id");
    if (!suppliedWorkId || suppliedWorkId !== workOrder?.work_id) {
      return response({ error: "work_id_header_mismatch" }, 409);
    }
    const dispatchAndFlush = async () => {
      const dispatched = await dispatcher.dispatchWorkOrder(workOrder);
      // The coordinator's event IDs are idempotent. Replaying a stored receipt
      // after an interrupted callback is therefore safe, and posting serially
      // preserves the per-worker sequence required by its state machine.
      await dispatcher.flush(workOrder.work_id, eventSink);
      return response(dispatched, dispatched.deduplicated ? 200 : 202);
    };
    if (defer) {
      // A Cloudflare Durable Object cannot process this callback while it is
      // still awaiting its outbound dispatch request. Validate before the
      // acknowledgement, then persist the receipt and deliver its ordered
      // outbox after the coordinator has committed the queued work item.
      try { assertDispatchWorkOrder(workOrder); }
      catch (error) { return response({ error: "invalid_work_order", detail: error.message }, 400); }
      void dispatchAndFlush().catch((error) => onBackgroundError(`Railway dispatch ${workOrder.work_id}: ${error.message || error}`));
      return response({ work_id: workOrder.work_id, status: "accepted" }, 202);
    }
    try {
      return await dispatchAndFlush();
    } catch (error) {
      // This exposes only the downstream HTTP status, never a token or event
      // payload, but makes a live outbox failure diagnosable from Railway's
      // bounded receiver response.
      if (error instanceof EventDeliveryError) return response({ error: "worker_event_delivery_failed", detail: error.message }, 502);
      if (error instanceof InvalidWorkerEventsError) return response({ error: "invalid_worker_events" }, 422);
      return response({ error: "invalid_work_order", detail: error.message }, 400);
    }
  };
}

/** Build the authenticated callback used by a deployed Railway service. */
export function createCoordinatorEventSink({ coordinatorUrl, ingressToken, fetcher = fetch } = {}) {
  if (!coordinatorUrl || !ingressToken) throw new TypeError("coordinatorUrl and ingressToken are required");
  const base = coordinatorUrl.replace(/\/$/, "");
  return {
    async append(workId, event) {
      const result = await fetcher(`${base}/v1/encounters/${event.encounter_id}/work-items/${workId}/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${ingressToken}`, "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!result.ok) throw new Error(`coordinator event callback failed: ${result.status}`);
    },
  };
}

function response(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
