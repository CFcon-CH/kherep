// SQLite schema of the Registry Durable Object. SQL runs synchronously through
// ctx.storage.sql.exec(); cursors are consumed with toArray()/one() before any
// await, as the SQLite storage API documentation requires.
// https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec
export const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  hostname TEXT, os TEXT, arch TEXT, cpus INTEGER, memory_bytes INTEGER,
  capabilities TEXT NOT NULL DEFAULT '[]',
  enrolled_at INTEGER NOT NULL,
  last_seen INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS runtimes (
  node_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT,
  endpoint TEXT,
  PRIMARY KEY (node_id, name)
);
CREATE TABLE IF NOT EXISTS sessions (
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, session_id)
);
CREATE TABLE IF NOT EXISTS enrollments (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  used_at INTEGER,
  used_by_node TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
`;

// Session columns added in Phase 2 (issue #31), label with issue #74 and title with issue #88. CREATE TABLE IF NOT EXISTS
// leaves a table from an earlier deployment as it was, so each column is added
// when PRAGMA table_info does not list it yet. Safe to run on every start.
export const ADDED_SESSION_COLUMNS = ["name", "cwd", "kind", "label", "title", "canonical_identity"] as const;
// Issue #441: last_accepted_at (ms), the Worker's time of the node's last report
// that moved one of its messages out of queued (node-intake.mts). NODE_COLUMNS
// leaves it out, so the operator API is unchanged.
export const ADDED_NODE_COLUMNS = ["last_accepted_at", "identity_generation"] as const;

export function migrateRegistry(sql: SqlStorage): void {
  const bindingColumns = sql.exec("PRAGMA table_info(nodes)").toArray().map(c => c.name);
  if (!bindingColumns.includes("message_connection_token")) sql.exec("ALTER TABLE nodes ADD COLUMN message_connection_token TEXT");
  const present = new Set(sql.exec("PRAGMA table_info(sessions)").toArray().map((column) => String(column.name)));
  for (const column of ADDED_SESSION_COLUMNS) {
    if (!present.has(column)) sql.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
  }
  const nodeColumns = new Set(sql.exec("PRAGMA table_info(nodes)").toArray().map((column) => String(column.name)));
  for (const column of ["identity_digest", "registration_token"]) if (!nodeColumns.has(column)) sql.exec(`ALTER TABLE nodes ADD COLUMN ${column} TEXT`);
  for (const column of ADDED_NODE_COLUMNS) {
    if (!nodeColumns.has(column)) sql.exec(`ALTER TABLE nodes ADD COLUMN ${column} INTEGER`);
  }
}

export type NodeStatus = "online" | "offline" | "revoked";

export interface NodeRow {
  id: string;
  name: string;
  status: NodeStatus;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  capabilities: string[];
  enrolledAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
}

export const NODE_COLUMNS = "id, name, status, hostname, os, arch, cpus, memory_bytes, capabilities, enrolled_at, last_seen, revoked_at";

export function toNodeRow(row: Record<string, SqlStorageValue>): NodeRow {
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status) as NodeStatus,
    hostname: row.hostname as string | null,
    os: row.os as string | null,
    arch: row.arch as string | null,
    cpus: row.cpus as number | null,
    memoryBytes: row.memory_bytes as number | null,
    capabilities: JSON.parse(String(row.capabilities)) as string[],
    enrolledAt: Number(row.enrolled_at),
    lastSeen: row.last_seen as number | null,
    revokedAt: row.revoked_at as number | null,
  };
}

// Enrollment codes are short-lived and single use (design section 2).
export const ENROLLMENT_TTL_DEFAULT_S = 600;
export const ENROLLMENT_TTL_MIN_S = 60;
export const ENROLLMENT_TTL_MAX_S = 3600;
