import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { InMemorySteeringStore } from "./responses-steering.js";

/**
 * Worker-process persistence for socket state and saved tool/approval results.
 * It is deliberately Node-only and is never bundled into the coordinator DO.
 */
export class JsonSteeringStore extends InMemorySteeringStore {
  static async open(filePath) {
    const store = new JsonSteeringStore(filePath);
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      store.attempts = new Map(value.attempts || []); store.receipts = new Map(value.receipts || []);
      store.events = new Map(value.events || []); store.results = new Map(value.results || []); store.outbox = new Map(value.outbox || []); store.reportSequence = value.reportSequence || 0;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return store;
  }
  constructor(filePath) { super(); this.filePath = filePath; }
  async atomic(fn) {
    return super.atomic(async () => {
      const result = await fn();
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.next`;
      await writeFile(temporary, JSON.stringify({ attempts: [...this.attempts], receipts: [...this.receipts], events: [...this.events], results: [...this.results], outbox: [...this.outbox], reportSequence: this.reportSequence }));
      await rename(temporary, this.filePath);
      return result;
    });
  }
}
