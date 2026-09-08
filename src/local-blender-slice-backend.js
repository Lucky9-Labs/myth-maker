import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../modal/local_blender_asset_slice.py", import.meta.url));

/**
 * Dispatcher backend for one actual local Blender CLI work order. It emits
 * closed v1 lifecycle events while retaining the immutable result manifest for
 * the Build Room adapter. Modal and host-game execution are intentionally not
 * involved.
 */
export class LocalBlenderSliceBackend {
  constructor({ outputDir = ".local-blender-artifacts", python = "python3", seedFor = stableSeed } = {}) {
    this.outputDir = resolve(outputDir);
    this.python = python;
    this.seedFor = seedFor;
    this.results = new Map();
  }

  resultFor(workId) { return structuredClone(this.results.get(workId)); }

  async launch(order, { onEvent } = {}) {
    const workerId = `blender-cli-${createHash("sha256").update(order.work_id).digest("hex").slice(0, 32)}`;
    const events = [];
    const emit = (sequence, kind, details = {}) => {
      const event = {
        schema_version: "1",
        event_id: `evt-${createHash("sha256").update(`${order.work_id}:${order.attempt}:${workerId}:${sequence}`).digest("hex").slice(0, 32)}`,
        work_id: order.work_id,
        encounter_id: order.encounter_id,
        worker_id: workerId,
        sequence,
        occurred_at: new Date().toISOString(),
        kind,
        ...details,
      };
      events.push(event);
      onEvent?.(event);
    };
    emit(0, "accepted", { message: "Local Blender CLI worker accepted the generic body-source work order." });
    emit(1, "started", { message: "Local Blender CLI generation and immutable source checkpoint started." });
    try {
      await mkdir(this.outputDir, { recursive: true });
      const manifest = await invoke(this.python, [script, "--output-dir", this.outputDir, "--encounter-id", order.encounter_id,
        "--work-id", order.work_id, "--worker-id", workerId, "--seed", String(this.seedFor(order))]);
      validateManifest(manifest, order, workerId);
      this.results.set(order.work_id, manifest);
      emit(2, "candidate_produced", { module: manifest.module, message: `Local Blender CLI produced immutable .blend ${manifest.source.artifact.sha256} and checked GLB ${manifest.runtime.sha256}.` });
      emit(3, "completed", { message: "Local Blender CLI conversion completed; runtime candidate remains unaccepted by a host game." });
      return { worker_id: workerId, events };
    } catch (error) {
      emit(2, "failed", { error_code: "local_blender_cli_failed", retryable: true, message: String(error.message || error).slice(0, 2000) });
      return { worker_id: workerId, events };
    }
  }
}

function invoke(program, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`local Blender slice exited ${code}: ${stderr.trim().slice(-1000)}`));
      try { resolvePromise(JSON.parse(stdout)); }
      catch { reject(new Error("local Blender slice emitted no parseable manifest")); }
    });
  });
}

function validateManifest(manifest, order, workerId) {
  if (!manifest || manifest.schema_version !== "1" || manifest.kind !== "local_blender_generated_asset"
    || manifest.evidence_scope !== "local_blender_cli_only" || manifest.work_id !== order.work_id
    || manifest.encounter_id !== order.encounter_id || manifest.worker_id !== workerId
    || !manifest.source?.artifact?.sha256 || !manifest.runtime?.sha256 || !manifest.visual?.sha256
    || !manifest.module || !manifest.loader_profile || !manifest.worker_receipt?.commands?.length) {
    throw new Error("local Blender slice returned an incomplete manifest");
  }
}

function stableSeed(order) {
  return createHash("sha256").update(JSON.stringify({ encounter_id: order.encounter_id, work_id: order.work_id, attempt: order.attempt }))
    .digest().readUInt32BE(0);
}
