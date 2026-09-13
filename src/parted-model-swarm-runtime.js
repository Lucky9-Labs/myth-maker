const STATE_IDS = Object.freeze({ idle: 0, walk: 1, run: 2, attack: 3, death: 4 });
const REQUIRED_STATES = Object.freeze(Object.keys(STATE_IDS));
const AGENT_BYTES = 32;
const OFFSETS = Object.freeze({ x: 0, y: 4, z: 8, yaw: 12, phase: 16, seed: 20, state: 24, lod: 25 });

export class PackedPartedSwarm {
  #view;

  constructor(length) {
    if (!Number.isInteger(length) || length < 0) throw new TypeError("swarm length must be a non-negative integer");
    this.length = length;
    this.buffer = new ArrayBuffer(length * AGENT_BYTES);
    this.#view = new DataView(this.buffer);
  }

  get byteLength() { return this.buffer.byteLength; }

  initialize(index, { position, yaw, phase, seed, state = STATE_IDS.idle, lod = 0 }) {
    this.#requireIndex(index); const base = index * AGENT_BYTES;
    this.#view.setFloat32(base + OFFSETS.x, position[0], true);
    this.#view.setFloat32(base + OFFSETS.y, position[1], true);
    this.#view.setFloat32(base + OFFSETS.z, position[2], true);
    this.#view.setFloat32(base + OFFSETS.yaw, yaw, true);
    this.#view.setFloat32(base + OFFSETS.phase, phase, true);
    this.#view.setUint32(base + OFFSETS.seed, seed, true);
    this.#view.setUint8(base + OFFSETS.state, state);
    this.#view.setUint8(base + OFFSETS.lod, lod);
  }

  getAgent(index) {
    return this.readAgentInto(index, { position: [0, 0, 0], yaw: 0, phase: 0, seed: 0, state: 0, lod: 0 });
  }

  readAgentInto(index, target) {
    this.#requireIndex(index); const base = index * AGENT_BYTES;
    target.position[0] = this.#view.getFloat32(base + OFFSETS.x, true);
    target.position[1] = this.#view.getFloat32(base + OFFSETS.y, true);
    target.position[2] = this.#view.getFloat32(base + OFFSETS.z, true);
    target.yaw = this.#view.getFloat32(base + OFFSETS.yaw, true);
    target.phase = this.#view.getFloat32(base + OFFSETS.phase, true);
    target.seed = this.#view.getUint32(base + OFFSETS.seed, true);
    target.state = this.#view.getUint8(base + OFFSETS.state);
    target.lod = this.#view.getUint8(base + OFFSETS.lod);
    return target;
  }

  getState(index) { this.#requireIndex(index); return this.#view.getUint8(index * AGENT_BYTES + OFFSETS.state); }
  getPhase(index) { this.#requireIndex(index); return this.#view.getFloat32(index * AGENT_BYTES + OFFSETS.phase, true); }
  getSeed(index) { this.#requireIndex(index); return this.#view.getUint32(index * AGENT_BYTES + OFFSETS.seed, true); }

  advance(index, state, phase) {
    this.#requireIndex(index); const base = index * AGENT_BYTES;
    this.#view.setUint8(base + OFFSETS.state, state);
    this.#view.setFloat32(base + OFFSETS.phase, phase, true);
  }

  #requireIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) throw new RangeError(`agent index ${index} is out of range`);
  }
}

/**
 * Data-only swarm representation for a rigid, provider-parted creature.
 *
 * The host uploads one shared part transform-track library per model/LOD.
 * An agent is merely a compact immutable seed plus a small state record; it
 * must not allocate an Animator, a rig graph, or clip objects per creature.
 */
export function createPartedSwarmDefinition({ model_id, part_count, part_materials, clips, lods } = {}) {
  if (!validId(model_id) || !Number.isInteger(part_count) || part_count < 2) throw new TypeError("model_id and part_count are required");
  if (!Array.isArray(part_materials) || part_materials.length !== part_count || part_materials.some((material) => !Number.isInteger(material) || material < 0)) throw new TypeError("part_materials must bind every part to a material");
  const clipMap = normalizeClips(clips, part_count);
  const normalizedLods = normalizeLods(lods);
  return Object.freeze({
    schema_version: "parted-swarm-runtime.v1", model_id, part_count,
    instance_layout: { bytes: AGENT_BYTES, fields: ["position.xyz", "yaw", "state", "phase", "seed", "lod"] },
    animation_storage: { kind: "shared-part-transform-tracks", clips: clipMap, root_motion: "consumer-authored velocity; clips stay in-place" },
    rendering: { kind: "part-instanced", batches: "model+lod+part+material", part_materials: Object.freeze([...part_materials]), per_agent_animator: false, cpu_pose_evaluation: false },
    culling: normalizedLods,
    variation: { kind: "deterministic-hash", seed_field: "seed", idle_phase_spread: true, speed_jitter: [0.94, 1.06] },
  });
}

export function initializePartedSwarm({ definition, agents }) {
  if (definition?.schema_version !== "parted-swarm-runtime.v1" || !Array.isArray(agents)) throw new TypeError("definition and agents are required");
  const swarm = new PackedPartedSwarm(agents.length);
  agents.forEach((agent, index) => {
    if (!Array.isArray(agent.position) || agent.position.length !== 3 || !agent.position.every(Number.isFinite)) throw new TypeError(`agent ${index} position is invalid`);
    const seed = Number.isInteger(agent.seed) ? agent.seed >>> 0 : hash32(index + 1);
    swarm.initialize(index, { position: agent.position, yaw: finite(agent.yaw, 0), state: STATE_IDS.idle, phase: unit(seed), seed, lod: 0 });
  });
  return swarm;
}

/** Advance compact state only. Rendering samples the shared GPU clip library. */
export function advancePartedSwarm({ definition, agents, delta_seconds, commands = [] }) {
  if (!Number.isFinite(delta_seconds) || delta_seconds < 0) throw new TypeError("delta_seconds must be non-negative");
  if (!(agents instanceof PackedPartedSwarm)) throw new TypeError("agents must be a packed parted swarm");
  const commanded = new Map(commands.map((command) => [command.index, command.state]));
  for (let index = 0; index < agents.length; index += 1) {
    const previousState = agents.getState(index); const requested = commanded.get(index);
    const state = previousState === STATE_IDS.death || requested === undefined ? previousState : stateId(requested);
    const clip = definition.animation_storage.clips[REQUIRED_STATES[state]];
    const jitter = 0.94 + unit(agents.getSeed(index) ^ state) * 0.12;
    const previousPhase = state === previousState ? agents.getPhase(index) : 0;
    const advancedPhase = previousPhase + delta_seconds * jitter / clip.duration_seconds;
    if (state === STATE_IDS.attack && advancedPhase >= 1) agents.advance(index, STATE_IDS.idle, 0);
    else if (state === STATE_IDS.death) agents.advance(index, state, Math.min(1, previousPhase + delta_seconds / clip.duration_seconds));
    else agents.advance(index, state, advancedPhase % 1);
  }
  return agents;
}

/**
 * Builds draw batches after host frustum/occlusion culling.  The host sends a
 * visible-index list, avoiding hidden-agent pose or object work on the CPU.
 */
export function buildPartedDrawPlan({ definition, agents, visible_indexes, camera_distance }) {
  if (!Array.isArray(visible_indexes) || typeof camera_distance !== "function") throw new TypeError("visible indexes and camera_distance are required");
  if (!(agents instanceof PackedPartedSwarm)) throw new TypeError("agents must be a packed parted swarm");
  const batches = new Map();
  const scratch = { position: [0, 0, 0], yaw: 0, phase: 0, seed: 0, state: 0, lod: 0 };
  let visibleCreatures = 0;
  for (const index of visible_indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= agents.length) continue;
    visibleCreatures += 1;
    const agent = agents.readAgentInto(index, scratch);
    const lod = selectLod(definition.culling, camera_distance(agent, index));
    for (let part = 0; part < definition.part_count; part += 1) {
      const material = definition.rendering.part_materials[part];
      const key = `${lod.level}:${part}:${material}`; const batch = batches.get(key) || { lod: lod.level, part, material, agent_indexes: [] };
      batch.agent_indexes.push(index); batches.set(key, batch);
    }
  }
  return { visible_creatures: visibleCreatures, batches: [...batches.values()], instance_bytes: visibleCreatures * definition.instance_layout.bytes };
}

function normalizeClips(clips, partCount) {
  if (!clips || typeof clips !== "object") throw new TypeError("five clips are required");
  const output = {};
  for (const state of REQUIRED_STATES) {
    const clip = clips[state];
    if (!clip || !Number.isFinite(clip.duration_seconds) || clip.duration_seconds <= 0 || !Number.isInteger(clip.part_track_count) || clip.part_track_count !== partCount
      || typeof clip.loop !== "boolean" || typeof clip.root_motion !== "boolean") throw new TypeError(`${state} clip is incompatible with the part set`);
    if ((state === "idle" || state === "walk" || state === "run") !== clip.loop || clip.root_motion) throw new TypeError(`${state} loop/root-motion policy is invalid`);
    output[state] = Object.freeze({ duration_seconds: clip.duration_seconds, part_track_count: clip.part_track_count, loop: clip.loop, root_motion: false });
  }
  return Object.freeze(output);
}
function normalizeLods(lods) { if (!Array.isArray(lods) || lods.length < 2) throw new TypeError("at least near and far LODs are required"); const out = lods.map((lod, index) => ({ level: index, max_distance: lod.max_distance, update_hz: lod.update_hz, cast_shadows: Boolean(lod.cast_shadows) })); if (out.some((lod) => !(Number.isFinite(lod.max_distance) || lod.max_distance === Infinity) || !Number.isFinite(lod.update_hz) || lod.update_hz < 0) || out.some((lod, index) => index && lod.max_distance <= out[index - 1].max_distance)) throw new TypeError("LODs must have ascending distances and valid update rates"); return Object.freeze(out); }
function selectLod(lods, distance) { return lods.find((lod) => distance <= lod.max_distance) || lods.at(-1); }
function stateId(state) { if (!(state in STATE_IDS)) throw new TypeError("unknown animation state"); return STATE_IDS[state]; }
function validId(value) { return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value); }
function finite(value, fallback) { return Number.isFinite(value) ? value : fallback; }
function hash32(value) { let n = value >>> 0; n = Math.imul(n ^ n >>> 16, 0x45d9f3b); n = Math.imul(n ^ n >>> 16, 0x45d9f3b); return (n ^ n >>> 16) >>> 0; }
function unit(seed) { return (seed >>> 0) / 0x100000000; }
