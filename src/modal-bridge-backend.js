import { spawn } from "node:child_process";

/**
 * Invoke the existing Python ModalDraftBackend without putting Modal SDK
 * credentials or the input package in an HTTP response or application log.
 */
export class ModalBridgeBackend {
  constructor({ python = process.env.PYTHON_BIN || "python3", bridgePath = "modal/railway_modal_bridge.py", timeoutMs = 13 * 60_000 } = {}) {
    this.python = python;
    this.bridgePath = bridgePath;
    this.timeoutMs = timeoutMs;
  }

  async launch(order) {
    const child = spawn(this.python, [this.bridgePath], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ work_order: order }));
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Modal bridge timed out")); }, this.timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    if (exit !== 0) throw new Error(`Modal bridge failed (${exit}): ${stderr.trim().slice(0, 800) || "no diagnostic"}`);
    try {
      const result = JSON.parse(stdout);
      if (!result || typeof result.worker_id !== "string" || !Array.isArray(result.events)) throw new Error("missing worker receipt");
      return result;
    } catch (error) {
      throw new Error(`Modal bridge returned invalid receipt: ${error.message}`);
    }
  }
}
