import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { INTERCOM_SLOTS, readIntercomSlots, replaceIntercomSlot, type IntercomSlot, type SlotOccupant } from "../src/intercom-slots.mts";
import { initializeRegistrySchema } from "../src/registry-schema.mts";
import { enroll, newKey, registry } from "./helpers.mts";

const slots = ["kherep-lead", "codex-windows", "claude-windows", "codex-mac", "claude-mac"];
const a: SlotOccupant = { nodeId: "11111111-1111-4111-8111-111111111111", runtime: "codex",
  sessionId: "22222222-2222-4222-8222-222222222222", chatName: "  Synthetic A  " };
const b: SlotOccupant = { nodeId: "33333333-3333-4333-8333-333333333333", runtime: "claude-code",
  sessionId: "44444444-4444-4444-8444-444444444444", chatName: "Synthetic B" };
const rows = (sql: SqlStorage) => sql.exec("SELECT * FROM intercom_slots ORDER BY slot").toArray();

describe("internal Intercom slot storage", () => {
  // The fixture addresses one Registry for the whole file, so reset only this slice.
  beforeEach(async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS intercom_slots");
      initializeRegistrySchema(state.storage);
    });
  });
  it("initializes exactly five empty slots at revision zero", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      expect(INTERCOM_SLOTS).toEqual(slots);
      expect(rows(state.storage.sql)).toEqual([...slots].sort().map(slot => ({
        slot, revision: 0, node_id: null, runtime: null, session_id: null, chat_name: null,
      })));
    });
  });

  it("initializes an earlier Registry without changing node, session or message rows", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE IF EXISTS intercom_slots");
      sql.exec("INSERT INTO nodes (id, name, enrolled_at) VALUES ('sentinel-node', 'synthetic', 1)");
      sql.exec("INSERT INTO sessions (node_id, session_id, runtime, state, updated_at) VALUES ('sentinel-node', 'sentinel-session', 'codex', 'unknown', 1)");
      sql.exec(`INSERT INTO messages (id, from_node, from_session, to_node, to_session, state, created_at, updated_at, expires_at)
        VALUES ('sentinel-message', 'sentinel-node', 'sentinel-session', 'target', 'session', 'queued', 1, 1, 2)`);
      const before = ["nodes", "sessions", "messages"].map(table => sql.exec(`SELECT * FROM ${table}`).toArray());

      initializeRegistrySchema(state.storage);
      initializeRegistrySchema(state.storage);

      expect(rows(sql)).toHaveLength(5);
      expect(["nodes", "sessions", "messages"].map(table => sql.exec(`SELECT * FROM ${table}`).toArray())).toEqual(before);
    });
  });

  it("replaces, preserves across initialization and clears without affecting the other four slots", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      const others = rows(sql).filter(row => row.slot !== "kherep-lead");
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, a)).toBe(1);
      const occupied = rows(sql);
      initializeRegistrySchema(state.storage);
      initializeRegistrySchema(state.storage);
      expect(rows(sql)).toEqual(occupied);
      expect(replaceIntercomSlot(sql, "kherep-lead", 1, b)).toBe(2);
      expect(sql.exec("SELECT * FROM intercom_slots WHERE slot='kherep-lead'").one()).toEqual({
        slot: "kherep-lead", revision: 2, node_id: b.nodeId, runtime: b.runtime, session_id: b.sessionId, chat_name: b.chatName,
      });
      expect(replaceIntercomSlot(sql, "kherep-lead", 2, null)).toBe(3);
      expect(sql.exec("SELECT * FROM intercom_slots WHERE slot='kherep-lead'").one()).toEqual({
        slot: "kherep-lead", revision: 3, node_id: null, runtime: null, session_id: null, chat_name: null,
      });
      expect(rows(sql).filter(row => row.slot !== "kherep-lead")).toEqual(others);
    });
  });

  it.each([[a, b], [b, a]])("allows exactly one contender at a shared revision, in either ordering", async (first, second) => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      expect([replaceIntercomSlot(sql, "kherep-lead", 0, first), replaceIntercomSlot(sql, "kherep-lead", 0, second)])
        .toEqual([1, null]);
      const winner = rows(sql);
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, second)).toBeNull();
      expect(rows(sql)).toEqual(winner);
      expect(sql.exec("SELECT chat_name FROM intercom_slots WHERE slot='kherep-lead'").one().chat_name).toBe(first.chatName);
    });
  });

  it.each(["codex-windows", "codex-mac", "claude-windows", "claude-mac"] as const)("supports the fixed runtime of %s", async slot => {
    await runInDurableObject(registry(), (_instance, state) => {
      const occupant = slot.startsWith("codex") ? a : b;
      expect(replaceIntercomSlot(state.storage.sql, slot, 0, occupant)).toBe(1);
      expect(state.storage.sql.exec("SELECT chat_name FROM intercom_slots WHERE slot=?", slot).one().chat_name).toBe(occupant.chatName);
    });
  });

  it("rejects invalid inputs before writing, including stale invalid occupants", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, a)).toBe(1);
      const before = rows(sql);
      for (const slot of ["sixth", "", null, 42]) {
        expect(() => replaceIntercomSlot(sql, slot as IntercomSlot, 1, a)).toThrow();
        expect(rows(sql)).toEqual(before);
      }
      for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
        expect(() => replaceIntercomSlot(sql, "kherep-lead", revision as number, a)).toThrow();
        expect(rows(sql)).toEqual(before);
      }
      const invalid = [undefined, {}, [], "occupant", { ...a, nodeId: "short" }, { ...a, nodeId: null },
        { ...a, sessionId: "short" }, { ...a, sessionId: null }, { ...a, runtime: "claude" },
        { ...a, chatName: "" }, { ...a, chatName: " \t\n" }, { ...a, chatName: null },
        { nodeId: a.nodeId, runtime: a.runtime, sessionId: a.sessionId }];
      for (const occupant of invalid) {
        expect(() => replaceIntercomSlot(sql, "kherep-lead", 0, occupant as SlotOccupant)).toThrow();
        expect(rows(sql)).toEqual(before);
      }
      expect(() => replaceIntercomSlot(sql, "codex-mac", 0, b)).toThrow();
      expect(() => replaceIntercomSlot(sql, "claude-mac", 0, a)).toThrow();
      expect(rows(sql)).toEqual(before);
    });
  });

  it("increments to the maximum safe revision once and then refuses overflow", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE intercom_slots SET revision=? WHERE slot='kherep-lead'", Number.MAX_SAFE_INTEGER - 1);
      expect(replaceIntercomSlot(sql, "kherep-lead", Number.MAX_SAFE_INTEGER - 1, a)).toBe(Number.MAX_SAFE_INTEGER);
      const before = rows(sql);
      expect(() => replaceIntercomSlot(sql, "kherep-lead", Number.MAX_SAFE_INTEGER, null)).toThrow();
      expect(rows(sql)).toEqual(before);
    });
  });

  it("enforces fixed keys, complete occupancy, runtime and integer revision constraints in SQLite", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      const before = rows(sql);
      for (const query of [
        "INSERT INTO intercom_slots (slot) VALUES ('sixth')",
        "INSERT INTO intercom_slots (slot) VALUES (NULL)",
        "UPDATE intercom_slots SET node_id='node' WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET runtime='codex',session_id='session',chat_name='name' WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET node_id='node',runtime='codex',session_id='session' WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET node_id='node',runtime='codex',chat_name='name' WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET node_id='node',runtime='claude-code',session_id='session',chat_name='name' WHERE slot='codex-mac'",
        "UPDATE intercom_slots SET node_id='node',runtime='codex',session_id='session',chat_name='name' WHERE slot='claude-mac'",
        "UPDATE intercom_slots SET node_id='node',runtime='invalid',session_id='session',chat_name='name' WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET node_id='',runtime='codex',session_id='session',chat_name='name' WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET revision=-1 WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET revision=0.5 WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET revision=9007199254740992 WHERE slot='kherep-lead'",
        "UPDATE intercom_slots SET revision=NULL WHERE slot='kherep-lead'",
      ]) {
        expect(() => sql.exec(query).toArray()).toThrow();
        expect(rows(sql)).toEqual(before);
      }
    });
  });

  it("propagates storage errors rather than returning a CAS conflict", async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE intercom_slots");
      expect(() => replaceIntercomSlot(sql, "kherep-lead", 0, a)).toThrow(/no such table/);
    });
  });
});


describe("authoritative Intercom slot read", () => {
  beforeEach(async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS intercom_slots");
      initializeRegistrySchema(state.storage);
    });
  });

  it("reads vacancies in role order regardless of insertion order", async () => {
    await runInDurableObject(registry(), (instance, state) => {
      state.storage.sql.exec("DELETE FROM intercom_slots");
      for (const slot of [...INTERCOM_SLOTS].reverse()) state.storage.sql.exec("INSERT INTO intercom_slots (slot) VALUES (?)", slot);
      expect(instance.listIntercomSlots()).toEqual(slots.map(slot => ({ slot, revision: 0, occupant: null })));
    });
  });

  it("reads exact replacements and clears without resolving duplicate display names or stale CAS", async () => {
    await runInDurableObject(registry(), (instance, state) => {
      const sql = state.storage.sql;
      const other = { ...b, chatName: a.chatName };
      const before = instance.listIntercomSlots().slice(1);
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, a)).toBe(1);
      expect(instance.listIntercomSlots()[0]).toEqual({ slot: "kherep-lead", revision: 1, occupant: a });
      expect(replaceIntercomSlot(sql, "kherep-lead", 1, other)).toBe(2);
      expect(replaceIntercomSlot(sql, "kherep-lead", 1, a)).toBeNull();
      expect(instance.listIntercomSlots()[0]).toEqual({ slot: "kherep-lead", revision: 2, occupant: other });
      expect(replaceIntercomSlot(sql, "kherep-lead", 2, null)).toBe(3);
      expect(instance.listIntercomSlots()[0]).toEqual({ slot: "kherep-lead", revision: 3, occupant: null });
      expect(instance.listIntercomSlots().slice(1)).toEqual(before);
    });
  });

  it("reads five rows and writes none despite 600 unrelated historic sessions and no holder inventory", async () => {
    await runInDurableObject(registry(), (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<600)
        INSERT INTO sessions (node_id, session_id, runtime, state, updated_at, name, cwd, kind, title)
        SELECT 'synthetic-history', 'historic-' || i, 'codex', 'unknown', 1, 'Unrelated synthetic name', '/synthetic/private', 'subagent', 'Synthetic unrelated title' FROM n`);
      expect(sql.exec("SELECT 1 FROM sessions WHERE session_id=?", a.sessionId).toArray()).toEqual([]);
      expect(instance.listIntercomSlots()).toEqual(slots.map(slot => ({ slot, revision: 0, occupant: null })));
      replaceIntercomSlot(sql, "kherep-lead", 0, a);
      const before = instance.sqlStats();
      expect(instance.listIntercomSlots()[0]).toEqual({ slot: "kherep-lead", revision: 1, occupant: a });
      const after = instance.sqlStats();
      expect({ rowsRead: after.rowsRead-before.rowsRead, rowsWritten: after.rowsWritten-before.rowsWritten })
        .toEqual({ rowsRead: 5, rowsWritten: 0 });
      sql.exec("DELETE FROM sessions WHERE node_id='synthetic-history'");
    });
  });

  it("keeps occupancy across session replacement, reconnect and offline state", async () => {
    const nodeId = await enroll(await newKey(), "synthetic-roster-node");
    await registry().replaceSessions(nodeId, [{ sessionId: a.sessionId, runtime: "codex", state: "idle" }]);
    await runInDurableObject(registry(), (_instance, state) => {
      replaceIntercomSlot(state.storage.sql, "kherep-lead", 0, { ...a, nodeId });
    });
    const before = await registry().listIntercomSlots();
    await registry().setStatus(nodeId, "online", Date.now());
    await registry().replaceSessions(nodeId, [{ sessionId: b.sessionId, runtime: "claude-code", state: "idle", kind: "subagent" }]);
    await registry().setStatus(nodeId, "offline", Date.now());
    await registry().replaceSessions(nodeId, []);
    expect(await registry().listIntercomSlots()).toEqual(before);
  });

  it.each(["missing", "extra", "invalid-key", "duplicate"])("fails closed for %s slot rows", async fault => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      // Deliberately malformed test-only table, isolated from production schema constraints.
      sql.exec("ALTER TABLE intercom_slots RENAME TO valid_intercom_slots");
      try {
        sql.exec("CREATE TABLE intercom_slots AS SELECT * FROM valid_intercom_slots");
        if (fault === "missing") sql.exec("DELETE FROM intercom_slots WHERE slot='kherep-lead'");
        if (fault === "extra") sql.exec("INSERT INTO intercom_slots SELECT * FROM intercom_slots WHERE slot='kherep-lead'");
        if (fault === "invalid-key") sql.exec("UPDATE intercom_slots SET slot='sixth' WHERE slot='kherep-lead'");
        if (fault === "duplicate") sql.exec("UPDATE intercom_slots SET slot='codex-mac' WHERE slot='kherep-lead'");
        expect(() => readIntercomSlots(sql)).toThrow();
      } finally {
        sql.exec("DROP TABLE intercom_slots");
        sql.exec("ALTER TABLE valid_intercom_slots RENAME TO intercom_slots");
      }
    });
  });
});


it("atomically rolls back first table creation when the strict slot seed fails", async () => {
  await runInDurableObject(registry(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TABLE intercom_slots");
    let reachedSeedAfterDdl = false;
    const failingSql = new Proxy(sql, {
      get(target, key) {
        if (key === "exec") return (query: string, ...bindings: unknown[]) => {
          if (query.startsWith("INSERT INTO intercom_slots")) {
            reachedSeedAfterDdl = sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intercom_slots'")
              .toArray().length === 1;
            throw new Error("synthetic seed failure");
          }
          return target.exec(query, ...bindings);
        };
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => initializeRegistrySchema(state.storage, failingSql)).toThrow("synthetic seed failure");
    expect(reachedSeedAfterDdl).toBe(true);
    expect(sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='intercom_slots'").toArray()).toEqual([]);
    initializeRegistrySchema(state.storage);
    expect(readIntercomSlots(sql)).toEqual(slots.map(slot => ({ slot, revision: 0, occupant: null })));
  });
});
