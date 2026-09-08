import { randomUUID } from "node:crypto";

const EVIDENCE_LABELS = {
  fixture: "Simulated fixture (not live)",
  local_process: "Local process receipt (observed)",
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
  constructor({ now = () => new Date().toISOString(), id = randomStableId } = {}) {
    this.now = now;
    this.id = id;
    this.runs = new Map();
  }

  submit({ prompt }) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 2000) {
      throw new TypeError("prompt must be a non-empty string of at most 2000 characters");
    }
    const ids = {
      encounterId: this.id("encounter"),
      requestId: this.id("request"),
      workerId: this.id("worker"),
    };
    const submittedAt = this.now();
    this.runs.set(ids.encounterId, {
      ids,
      prompt: prompt.trim(),
      submittedAt,
      events: [],
      artifacts: new Map(),
      packages: new Map(),
      evidence: { local: [], modal: [], blender: [] },
      nextCursor: 1,
    });

    this.record(ids.encounterId, {
      eventId: this.id("event"),
      workerId: ids.workerId,
      sequence: 0,
      occurredAt: submittedAt,
      kind: "accepted",
      message: "The local build-room accepted this request. No coordinator was contacted.",
      evidence: { kind: "local_process", receipt: { request_id: ids.requestId, observed_at: submittedAt } },
    });
    this.record(ids.encounterId, {
      eventId: this.id("event"),
      workerId: ids.workerId,
      sequence: 1,
      occurredAt: submittedAt,
      kind: "progress",
      message: "Simulated fixture: previewing the pipeline only; no remote worker was started.",
      evidence: { kind: "fixture" },
    });
    return this.snapshot(ids.encounterId);
  }

  record(encounterId, input) {
    const run = this.requireRun(encounterId);
    const event = normaliseEvent(input, run, this.now, this.id, run.nextCursor++);
    run.events.push(event);
    if (event.artifact) upsertRevision(run.artifacts, event.artifact);
    if (event.package) upsertRevision(run.packages, event.package);
    if (event.evidence.kind === "local_process") run.evidence.local.push(event.evidence.receipt);
    if (event.evidence.kind === "modal_remote") run.evidence.modal.push(event.evidence.receipt);
    if (event.evidence.kind === "blender_window") run.evidence.blender.push(event.evidence.receipt);
    return event;
  }

  snapshot(encounterId) {
    const run = this.requireRun(encounterId);
    return {
      ids: { ...run.ids },
      prompt: run.prompt,
      submittedAt: run.submittedAt,
      events: orderedEvents(run.events),
      artifacts: revisions(run.artifacts),
      packages: revisions(run.packages),
      evidence: {
        local: [...run.evidence.local],
        modal: [...run.evidence.modal],
        blender: [...run.evidence.blender],
      },
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

  requireRun(encounterId) {
    const run = this.runs.get(encounterId);
    if (!run) throw new RangeError(`unknown encounter ${encounterId}`);
    return run;
  }
}

/** Translate coordinator or dispatcher payloads without claiming their source is live. */
export class CoordinatorEventAdapter {
  constructor(room) {
    this.room = room;
  }

  ingest(input) {
    const evidence = evidenceFromAdapterInput(input);
    return this.room.record(input.encounter_id, {
      eventId: input.event_id,
      workerId: input.worker_id,
      sequence: input.sequence,
      occurredAt: input.occurred_at,
      kind: input.kind,
      message: input.message,
      artifact: normaliseRevision(input.artifact, "artifact"),
      package: normaliseRevision(input.package, "package"),
      evidence,
    });
  }
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

function evidenceFromAdapterInput(input) {
  const source = input?.source || "adapter_reported";
  if (source === "modal_remote") {
    if (!input.receipt?.request_id || !input.receipt?.observed_at) {
      throw new TypeError("an observed Modal receipt requires request_id and observed_at");
    }
    return { kind: "modal_remote", receipt: input.receipt };
  }
  if (source === "blender_window") {
    if (!input.receipt?.observed_at || (!input.receipt.screenshot_path && !input.receipt.stream_url)) {
      throw new TypeError("observed Blender evidence requires screenshot_path or stream_url and observed_at");
    }
    return { kind: "blender_window", receipt: input.receipt };
  }
  if (source === "fixture") return { kind: "fixture" };
  return { kind: "adapter_reported", receipt: input.receipt };
}

function validateEvidence(evidence) {
  if (!EVIDENCE_LABELS[evidence?.kind]) throw new TypeError("unknown evidence kind");
  if (["local_process", "modal_remote", "blender_window"].includes(evidence.kind) && !evidence.receipt) {
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

function upsertRevision(entries, entry) {
  const id = entry.artifact_id || entry.package_id;
  const prior = entries.get(id);
  if (!prior || entry.revision >= prior.revision) entries.set(id, entry);
}

function revisions(entries) {
  return [...entries.values()].sort((a, b) => (a.artifact_id || a.package_id).localeCompare(b.artifact_id || b.package_id));
}

function orderedEvents(events) {
  return [...events].sort((a, b) => a.sequence - b.sequence
    || a.occurredAt.localeCompare(b.occurredAt)
    || a.cursor.localeCompare(b.cursor));
}

function randomStableId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
