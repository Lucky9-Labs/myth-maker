/** PostgreSQL-backed receipt/outbox store for the Railway dispatcher.
 *
 * Claiming uses the primary-key insert as the cross-instance lease: only the
 * winner may launch a worker for a stable work ID. The durable JSON receipt
 * includes the ordered event outbox, so a restart can resume callbacks.
 */
export class PostgresReceiptStore {
  constructor(pool, { leaseMs = 300_000 } = {}) {
    if (!pool || typeof pool.query !== "function") throw new TypeError("PostgresReceiptStore needs a pg-compatible pool");
    this.pool = pool;
    this.leaseMs = leaseMs;
  }

  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS encounter_dispatch_receipts (
      work_id text PRIMARY KEY,
      request_fingerprint text NOT NULL,
      receipt jsonb NOT NULL,
      lease_token text,
      lease_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query("ALTER TABLE encounter_dispatch_receipts ADD COLUMN IF NOT EXISTS lease_token text");
    await this.pool.query("ALTER TABLE encounter_dispatch_receipts ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz");
  }

  async get(workId) {
    const result = await this.pool.query("SELECT receipt FROM encounter_dispatch_receipts WHERE work_id = $1", [workId]);
    return clone(result.rows[0]?.receipt);
  }

  async claim(workId, requestFingerprint) {
    const leaseToken = crypto.randomUUID();
    const pending = { work_id: workId, request_fingerprint: requestFingerprint, status: "dispatching", events: [], outbox: [] };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(`INSERT INTO encounter_dispatch_receipts (work_id, request_fingerprint, receipt, lease_token, lease_expires_at)
        VALUES ($1, $2, $3::jsonb, $4, now() + ($5 * interval '1 millisecond')) ON CONFLICT (work_id) DO NOTHING RETURNING work_id`, [workId, requestFingerprint, JSON.stringify(pending), leaseToken, this.leaseMs]);
      if (inserted.rowCount) { await client.query("COMMIT"); return { kind: "claimed", leaseToken }; }
      const existing = await client.query("SELECT request_fingerprint, receipt, lease_expires_at FROM encounter_dispatch_receipts WHERE work_id = $1 FOR UPDATE", [workId]);
      const row = existing.rows[0];
      if (!row) throw new Error("receipt disappeared during duplicate claim");
      if (row.request_fingerprint !== requestFingerprint) throw new Error("work_id reused with a different work order");
      if (row.receipt?.status === "dispatching" && row.lease_expires_at && new Date(row.lease_expires_at) <= new Date()) {
        await client.query("UPDATE encounter_dispatch_receipts SET lease_token = $2, lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now() WHERE work_id = $1", [workId, leaseToken, this.leaseMs]);
        await client.query("COMMIT");
        return { kind: "claimed", leaseToken };
      }
      await client.query("COMMIT");
      return { kind: "existing", receipt: clone(row.receipt) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async finish(workId, receipt, leaseToken) {
    if (!leaseToken) throw new Error("a PostgreSQL receipt finish requires the active lease token");
    const result = await this.pool.query(`UPDATE encounter_dispatch_receipts
      SET receipt = $2::jsonb, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE work_id = $1 AND lease_token = $3 AND lease_expires_at > now()`, [workId, JSON.stringify(receipt), leaseToken]);
    if (!result.rowCount) throw new Error("cannot finish without the active, unexpired work lease");
  }

  async markDelivered(workId, eventId) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT receipt FROM encounter_dispatch_receipts WHERE work_id = $1 FOR UPDATE", [workId]);
      const receipt = result.rows[0]?.receipt;
      const event = receipt?.outbox?.find((entry) => entry.event?.event_id === eventId);
      if (!event) throw new Error("outbox event not found");
      event.delivered = true;
      await client.query("UPDATE encounter_dispatch_receipts SET receipt = $2::jsonb, updated_at = now() WHERE work_id = $1", [workId, JSON.stringify(receipt)]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async listUndelivered() {
    const result = await this.pool.query("SELECT receipt FROM encounter_dispatch_receipts WHERE receipt @> '{\"outbox\":[]}'::jsonb");
    return result.rows.map((row) => row.receipt).filter((receipt) => receipt.outbox?.some((entry) => !entry.delivered)).map(clone);
  }
}

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
