import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerProgram = path.join(path.dirname(fileURLToPath(import.meta.url)), "local-worker-process.js");

/** Offline backend that launches one Node process per work order. */
export class LocalWorkerBackend {
  constructor({ workDurationMs = 100 } = {}) {
    if (!Number.isInteger(workDurationMs) || workDurationMs < 0) {
      throw new TypeError("workDurationMs must be a non-negative integer");
    }
    this.workDurationMs = workDurationMs;
  }

  launch(order, { onEvent } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerProgram, JSON.stringify(order), String(this.workDurationMs)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const events = [];
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        const lines = stdout.split("\n");
        stdout = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line);
          events.push(event);
          onEvent?.(event);
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (stdout.trim()) {
          const event = JSON.parse(stdout);
          events.push(event);
          onEvent?.(event);
        }
        if (code !== 0) {
          reject(new Error(`local worker ${order.work_id} exited ${code}: ${stderr.trim()}`));
          return;
        }
        const completed = events.at(-1);
        if (!completed || completed.kind !== "completed") {
          reject(new Error(`local worker ${order.work_id} produced no terminal completion event`));
          return;
        }
        resolve({ worker_id: completed.worker_id, events });
      });
    });
  }
}
