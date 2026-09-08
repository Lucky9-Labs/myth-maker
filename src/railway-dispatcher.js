/**
 * HTTP adapter for the Railway control-plane service.
 *
 * The coordinator's WorkDispatcherAdapter sends a raw v1 EncounterWorkOrder
 * with `x-work-id`. The handler verifies both identities before invoking the
 * injected dispatcher. Production Railway wiring must provide a receipt store
 * that survives restarts; `Map` is intentionally only the local/test default.
 */
export function createRailwayDispatchHandler({ dispatcher } = {}) {
  if (!dispatcher || typeof dispatcher.dispatchWorkOrder !== "function") {
    throw new TypeError("Railway handler needs an EncounterDispatcher");
  }
  return async function handle(request) {
    if (request.method !== "POST") return response({ error: "not_found" }, 404);
    let workOrder;
    try { workOrder = await request.json(); } catch { return response({ error: "invalid_work_order" }, 400); }
    const suppliedWorkId = request.headers.get("x-work-id");
    if (!suppliedWorkId || suppliedWorkId !== workOrder?.work_id) {
      return response({ error: "work_id_header_mismatch" }, 409);
    }
    try {
      const dispatched = await dispatcher.dispatchWorkOrder(workOrder);
      return response(dispatched, dispatched.deduplicated ? 200 : 202);
    } catch (error) {
      return response({ error: "invalid_work_order", detail: error.message }, 400);
    }
  };
}

function response(value, status) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
