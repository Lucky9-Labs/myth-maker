#!/usr/bin/env node
/**
 * Local-only launcher for the Kraken two-worker GUI isolation gate.
 *
 * It deliberately provisions desktops, ownership records, and input copies only.
 * Geometry and saves must be performed inside the assigned Blender/noVNC desktop.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const image = "mech-local-blender:5.2.1-trial-20260907";
const workers = {
  "kraken-mantle-core": { port: 16081, component: "kraken-mantle-core", role: "central mantle/head and Mount_T01 through Mount_T08" },
  "kraken-tentacle-01": { port: 16082, component: "kraken-tentacle-01", role: "one complete numbered tentacle with T01_Root and T01_Tip" },
  "kraken-assembly": { port: 16090, component: "kraken-assembly", role: "serialized derivative assembly; links immutable mantle and tentacle sources only" },
};

function die(message) { throw new Error(message); }
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function command(commandName, args, options = {}) {
  return execFileSync(commandName, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}
function parse(argv) {
  const [action, workerId, ...rest] = argv;
  const values = Object.fromEntries(rest.filter((_, index) => index % 2 === 0).map((key, index) => [key.replace(/^--/, ""), rest[index * 2 + 1]]));
  return { action, workerId, values };
}
function registryPath(root) { return resolve(root, "registry.json"); }
function readRegistry(root) {
  const path = registryPath(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { schema_version: "kraken-desktop-swarm.v1", workers: {} };
}
function writeRegistry(root, registry) {
  mkdirSync(root, { recursive: true });
  writeFileSync(registryPath(root), `${JSON.stringify(registry, null, 2)}\n`);
}
function withRegistryLock(root, operation) {
  const lock = resolve(root, ".registry.lock");
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error?.code === "EEXIST") die("registry is being updated by another launcher; retry after it completes");
    throw error;
  }
  try { return operation(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
function requireWorker(workerId) {
  if (!workers[workerId]) die(`unknown worker ${workerId}; expected one of ${Object.keys(workers).join(", ")}`);
  return workers[workerId];
}
function ensureImage() {
  command("docker", ["image", "inspect", image]);
}
function launch({ workerId, root, baseline, concept, commit, dryRun }) {
  return withRegistryLock(root, () => launchReserved({ workerId, root, baseline, concept, commit, dryRun }));
}
function launchReserved({ workerId, root, baseline, concept, commit, dryRun }) {
  const spec = requireWorker(workerId);
  if (!baseline || !existsSync(baseline)) die("--baseline must name an existing immutable .blend checkpoint");
  if (!concept || !existsSync(concept)) die("--concept must name an existing concept image");
  if (!baseline.endsWith(".blend")) die("baseline must be a .blend file");
  ensureImage();
  const registry = readRegistry(root);
  if (registry.workers[workerId]?.state === "running") die(`${workerId} already has an active reservation`);
  const workerRoot = resolve(root, workerId);
  const sourceDir = resolve(workerRoot, "source");
  const homeDir = resolve(workerRoot, "home");
  const tempDir = resolve(workerRoot, "tmp");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tempDir, { recursive: true });
  const target = resolve(sourceDir, `${workerId}.blend`);
  copyFileSync(baseline, target);
  // The container runs as the host UID, so owner-only paths remain writable by
  // Blender while preventing another local account from altering a checkpoint.
  for (const path of [workerRoot, sourceDir, homeDir, tempDir]) chmodSync(path, 0o700);
  const reservation = {
    worker_id: workerId,
    component: spec.component,
    role: spec.role,
    attempt: 1,
    lease_id: `local-gui-${workerId}-${randomUUID()}`,
    state: dryRun ? "prepared" : "launching",
    desktop_identity: `kraken-gui-${workerId}`,
    container_name: `kraken-gui-${workerId}`,
    no_vnc_url: `http://127.0.0.1:${spec.port}/vnc.html`,
    source: { path: target, sha256: digest(target), baseline_path: resolve(baseline), baseline_sha256: digest(baseline) },
    concept: { path: resolve(concept), sha256: digest(concept) },
    source_commit: commit || "unrecorded",
    private_paths: { worker_root: workerRoot, home: homeDir, temp: tempDir },
    created_at: new Date().toISOString(),
    gui_only: true,
  };
  registry.workers[workerId] = reservation;
  writeRegistry(root, registry);
  if (dryRun) return reservation;
  const args = ["run", "--detach", "--rm", "--name", reservation.container_name,
    "--label", "org.myth-maker.kraken-swarm=true",
    "--label", `org.myth-maker.worker-id=${workerId}`,
    "--publish", `127.0.0.1:${spec.port}:6080`,
    "--mount", `type=bind,src=${sourceDir},dst=/output`,
    "--mount", `type=bind,src=${homeDir},dst=/home/blender`,
    "--mount", `type=bind,src=${tempDir},dst=/worker-tmp`,
    "--mount", `type=bind,src=${resolve(concept)},dst=/reference/concept.png,readonly`,
    "--env", "TMPDIR=/worker-tmp",
    "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  ];
  if (workerId === "kraken-assembly") {
    for (const part of ["kraken-mantle-core", "kraken-tentacle-01"]) {
      const published = readRegistry(root).workers[part]?.source?.path;
      if (!published || !existsSync(published)) die(`assembly requires published ${part} checkpoint`);
      args.push("--mount", `type=bind,src=${resolve(published)},dst=/published/${part}.blend,readonly`);
      reservation.depends_on = [...(reservation.depends_on || []), { worker_id: part, source_sha256: digest(published), mount: `/published/${part}.blend` }];
    }
  }
  args.push(image, `/output/${basename(target)}`);
  const containerId = command("docker", args);
  reservation.container_id = containerId;
  reservation.state = "running";
  reservation.started_at = new Date().toISOString();
  writeRegistry(root, registry);
  return reservation;
}
function inspect({ workerId, root }) {
  const reservation = readRegistry(root).workers[workerId];
  if (!reservation) die(`no reservation for ${workerId}`);
  const inspectJson = command("docker", ["inspect", reservation.container_name]);
  const health = command("docker", ["exec", reservation.container_name, "/usr/local/bin/health.sh"]);
  return { ...reservation, docker: JSON.parse(inspectJson)[0].State, health: health || "ok" };
}
function reconcile({ workerId, root }) {
  return withRegistryLock(root, () => {
    const reservation = readRegistry(root).workers[workerId];
    if (!reservation) die(`no reservation for ${workerId}`);
    const containerId = command("docker", ["inspect", "--format", "{{.Id}}", reservation.container_name]);
    const registry = readRegistry(root);
    registry.workers[workerId] = { ...reservation, container_id: containerId, state: "running", reconciled_at: new Date().toISOString() };
    writeRegistry(root, registry);
    return registry.workers[workerId];
  });
}
function publish({ workerId, root }) {
  return withRegistryLock(root, () => {
    const registry = readRegistry(root);
    const reservation = registry.workers[workerId];
    if (!reservation) die(`no reservation for ${workerId}`);
    if (!existsSync(reservation.source.path)) die(`checkpoint missing for ${workerId}`);
    reservation.checkpoint = { path: reservation.source.path, sha256: digest(reservation.source.path), published_at: new Date().toISOString() };
    reservation.state = "checkpointed";
    writeRegistry(root, registry);
    return reservation;
  });
}
function stop({ workerId, root }) {
  return withRegistryLock(root, () => {
    const registry = readRegistry(root);
    const reservation = registry.workers[workerId];
    if (!reservation) die(`no reservation for ${workerId}`);
    const labels = JSON.parse(command("docker", ["inspect", "--format", "{{json .Config.Labels}}", reservation.container_name]));
    if (labels["org.myth-maker.kraken-swarm"] !== "true" || labels["org.myth-maker.worker-id"] !== workerId) die(`refusing to stop an unowned container for ${workerId}`);
    command("docker", ["stop", reservation.container_name]);
    reservation.state = "stopped";
    reservation.stopped_at = new Date().toISOString();
    writeRegistry(root, registry);
    return reservation;
  });
}

try {
  const { action, workerId, values } = parse(process.argv.slice(2));
  const root = resolve(values.root || "/tmp/myth-maker-kraken-desktop-workers");
  let result;
  if (action === "launch") result = launch({ workerId, root, baseline: values.baseline, concept: values.concept, commit: values.commit, dryRun: values["dry-run"] === "true" });
  else if (action === "inspect") result = inspect({ workerId, root });
  else if (action === "reconcile") result = reconcile({ workerId, root });
  else if (action === "publish") result = publish({ workerId, root });
  else if (action === "stop") result = stop({ workerId, root });
  else die("usage: launch <worker-id> --baseline FILE --concept FILE [--root DIR] [--commit SHA] [--dry-run true] | inspect|reconcile|publish|stop <worker-id> [--root DIR]");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
