const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,128}$/;

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function validSubmission(value) {
  return value && ID.test(value.project_id) && ID.test(value.component_id)
    && IDEMPOTENCY_KEY.test(value.idempotency_key || "")
    && typeof value.agent_id === "string" && value.agent_id.length > 0
    && value.computer_use && typeof value.computer_use === "object";
}

function authorized(request, env) {
  return Boolean(env.AGENT_INGRESS_TOKEN)
    && request.headers.get("authorization") === `Bearer ${env.AGENT_INGRESS_TOKEN}`;
}

async function requestBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export class EncounterCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/status") {
      return response((await this.state.storage.get("job")) || { status: "idle" });
    }
    if (request.method !== "POST" || url.pathname !== "/submit") {
      return response({ error: "not_found" }, 404);
    }

    const submission = await requestBody(request);
    if (!validSubmission(submission)) {
      return response({ error: "invalid_submission" }, 400);
    }

    const idempotencyStorageKey = `idempotency:${submission.idempotency_key}`;
    const prior = await this.state.storage.get(idempotencyStorageKey);
    if (prior) return response(prior, 200);

    const active = await this.state.storage.get("job");
    if (active && ["dispatching", "running"].includes(active.status)) {
      return response({ error: "component_busy", job_id: active.job_id }, 409);
    }

    const job = {
      job_id: crypto.randomUUID(),
      project_id: submission.project_id,
      component_id: submission.component_id,
      agent_id: submission.agent_id,
      status: "dispatching",
      created_at: new Date().toISOString(),
    };
    await this.state.storage.put("job", job);

    const dispatch = await fetch(this.env.COMPUTER_USE_DISPATCH_URL, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.env.COMPUTER_USE_DISPATCH_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...job, computer_use: submission.computer_use }),
    });
    if (!dispatch.ok) {
      const failed = { ...job, status: "blocked", stop_reason: "computer_use_dispatch_failed" };
      await this.state.storage.put("job", failed);
      return response(failed, 502);
    }

    const accepted = { ...job, status: "queued" };
    await this.state.storage.put("job", accepted);
    await this.state.storage.put(idempotencyStorageKey, accepted);
    return response(accepted, 202);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!authorized(request, env)) return response({ error: "unauthorized" }, 401);
    if (request.method === "POST" && url.pathname === "/v1/encounters") {
      const submission = await requestBody(request);
      if (!validSubmission(submission)) return response({ error: "invalid_submission" }, 400);
      const objectId = env.ENCOUNTER_COORDINATOR.idFromName(`${submission.project_id}:${submission.component_id}`);
      return env.ENCOUNTER_COORDINATOR.get(objectId).fetch("https://encounter-coordinator/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission),
      });
    }
    const match = url.pathname.match(/^\/v1\/encounters\/([a-z0-9][a-z0-9-]{0,63}):([a-z0-9][a-z0-9-]{0,63})$/);
    if (request.method === "GET" && match) {
      const objectId = env.ENCOUNTER_COORDINATOR.idFromName(`${match[1]}:${match[2]}`);
      return env.ENCOUNTER_COORDINATOR.get(objectId).fetch("https://encounter-coordinator/status");
    }
    return response({ error: "not_found" }, 404);
  },
};
