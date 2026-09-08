import { createHash } from "node:crypto";

const [orderText, durationText] = process.argv.slice(2);
const order = JSON.parse(orderText);
const durationMs = Number(durationText);
const workerId = `local-${createHash("sha256").update(order.work_id).digest("hex").slice(0, 32)}`;

function emit(sequence, kind, details = {}) {
  const identity = `${order.work_id}:${order.attempt}:${workerId}:${sequence}`;
  process.stdout.write(`${JSON.stringify({
    schema_version: "1",
    event_id: `evt-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`,
    work_id: order.work_id,
    encounter_id: order.encounter_id,
    worker_id: workerId,
    sequence,
    occurred_at: new Date().toISOString(),
    kind,
    ...details,
  })}\n`);
}

emit(0, "accepted", { message: "Local worker accepted work order." });
emit(1, "started", { message: "Local worker process started." });
setTimeout(() => {
  emit(2, "completed", { message: "Local worker process completed recipe-only work." });
}, Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0);
