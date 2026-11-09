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
const seedNodes = (sql: SqlStorage) => {
  for (const [occupant, os] of [[a, "darwin"], [b, "win32"]] as const) {
    sql.exec("INSERT OR REPLACE INTO nodes (id, name, public_key, os, enrolled_at) VALUES (?, ?, ?, ?, 1)",
      occupant.nodeId, "Synthetic enrolled node", "synthetic-bound-key", os);
  }
};

describe("internal Intercom slot storage", () => {
  // The fixture addresses one Registry for the whole file, so reset only this slice.
  beforeEach(async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("DROP TABLE IF EXISTS intercom_slots");
      initializeRegistrySchema(state.storage);
      seedNodes(state.storage.sql);
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
      const others = rows(sql).filter(row => row.slot !== "kherep-lead");
      expect([replaceIntercomSlot(sql, "kherep-lead", 0, first), replaceIntercomSlot(sql, "kherep-lead", 0, second)])
        .toEqual([1, null]);
      const winner = rows(sql);
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, second)).toBeNull();
      expect(rows(sql)).toEqual(winner);
      expect(sql.exec("SELECT chat_name FROM intercom_slots WHERE slot='kherep-lead'").one().chat_name).toBe(first.chatName);
      expect(rows(sql).filter(row => row.slot !== "kherep-lead")).toEqual(others);
    });
  });

  it.each(["codex-windows", "codex-mac", "claude-windows", "claude-mac"] as const)("supports the fixed runtime of %s", async slot => {
    await runInDurableObject(registry(), (_instance, state) => {
      const occupant = slot.startsWith("codex") ? a : b;
      state.storage.sql.exec("UPDATE nodes SET os=? WHERE id=?", slot.endsWith("-mac") ? "darwin" : "win32", occupant.nodeId);
      expect(replaceIntercomSlot(state.storage.sql, slot, 0, occupant)).toBe(1);
      expect(state.storage.sql.exec("SELECT chat_name FROM intercom_slots WHERE slot=?", slot).one().chat_name).toBe(occupant.chatName);
    });
  });

  it.each(["darwin", "win32"])("accepts either supported runtime as lead on enrolled %s without sessions", async os => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE nodes SET os=? WHERE id=?", os, a.nodeId);
      for (const [revision, runtime] of [[0, "codex"], [1, "claude-code"]] as const) {
        expect(replaceIntercomSlot(sql, "kherep-lead", revision, { ...a, runtime })).toBe(revision + 1);
      }
      expect(sql.exec("SELECT 1 FROM sessions WHERE node_id=?", a.nodeId).toArray()).toEqual([]);
    });
  });

  it.each(INTERCOM_SLOTS)("rejects ineligible enrollments for %s without changing any slot", async slot => {
    await runInDurableObject(registry(), (_instance, state) => {
      const sql = state.storage.sql, before = rows(sql);
      const occupant = { ...a, runtime: slot.startsWith("claude-") ? "claude-code" as const : "codex" as const,
        chatName: "Windows macOS darwin win32 fake display name" };
      const compatible = slot.endsWith("-windows") ? "win32" : "darwin";
      const incompatible = slot === "kherep-lead" ? "linux" : compatible === "darwin" ? "win32" : "darwin";
      for (const os of [incompatible, "unknown", null]) {
        sql.exec("UPDATE nodes SET os=? WHERE id=?", os, occupant.nodeId);
        expect(() => replaceIntercomSlot(sql, slot, 0, occupant)).toThrow("Intercom assignment precondition failed");
        expect(rows(sql)).toEqual(before);
      }
      sql.exec("UPDATE nodes SET os=?, revoked_at=1 WHERE id=?", compatible, occupant.nodeId);
      expect(() => replaceIntercomSlot(sql, slot, 0, occupant)).toThrow("Intercom assignment precondition failed");
      expect(rows(sql)).toEqual(before);
      sql.exec("UPDATE nodes SET revoked_at=NULL, public_key=NULL WHERE id=?", occupant.nodeId);
      expect(() => replaceIntercomSlot(sql, slot, 0, occupant)).toThrow("Intercom assignment precondition failed");
      expect(rows(sql)).toEqual(before);
      expect(() => replaceIntercomSlot(sql, slot, 0, { ...occupant, nodeId: "55555555-5555-4555-8555-555555555555" }))
        .toThrow("Intercom assignment precondition failed");
      expect(rows(sql)).toEqual(before);
    });
  });

  it("preserves revoked occupancy while allowing an eligible successor or revision-only clear", async () => {
    await runInDurableObject(registry(), (instance, state) => {
      const sql = state.storage.sql;
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, a)).toBe(1);
      const occupied = instance.listIntercomSlots();
      sql.exec("UPDATE nodes SET revoked_at=1, public_key=NULL WHERE id=?", a.nodeId);
      expect(instance.listIntercomSlots()).toEqual(occupied);
      expect(() => replaceIntercomSlot(sql, "kherep-lead", 0, a)).toThrow("Intercom assignment precondition failed");
      expect(replaceIntercomSlot(sql, "kherep-lead", 0, b)).toBeNull();
      expect(rows(sql).find(row => row.slot === "kherep-lead")?.revision).toBe(1);
      expect(replaceIntercomSlot(sql, "kherep-lead", 1, b)).toBe(2);
      sql.exec("UPDATE nodes SET revoked_at=1 WHERE id=?", b.nodeId);
      expect(replaceIntercomSlot(sql, "kherep-lead", 2, null)).toBe(3);
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
      seedNodes(state.storage.sql);
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
      state.storage.sql.exec("UPDATE nodes SET os='darwin' WHERE id=?", nodeId);
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


it("v2b: occupied Claude slot permits SQL NULL title without fabrication", async () => {
  await runInDurableObject(registry(), (_instance, state) => {
    state.storage.sql.exec("DELETE FROM intercom_slots");
    for (const slot of INTERCOM_SLOTS) state.storage.sql.exec("INSERT INTO intercom_slots (slot) VALUES (?)", slot);
    seedNodes(state.storage.sql);
    expect(replaceIntercomSlot(state.storage.sql, "claude-windows", 0, { ...b, chatName: null } as unknown as SlotOccupant)).toBe(1);
    expect(readIntercomSlots(state.storage.sql).find(row => row.slot === "claude-windows")?.occupant?.chatName).toBeNull();
  });
});


import { isClaudeSlotSelection, makeEnvelope, type ClaudeSlotSelection } from "../../protocol.mts";
import { authenticate, until, FACTS, session as nodeSession } from "./helpers.mts";
const selection = (slot: ClaudeSlotSelection["slot"] = "claude-windows", sessionId = b.sessionId): ClaudeSlotSelection => {
  const observedAt = Date.now();
  return { slot, sessionId, promptId: crypto.randomUUID(), requestId: crypto.randomUUID(), observedAt, expiresAt: observedAt + 30_000 };
};
it("selection fixture stays valid across a clock tick", () => {
  let clock = 1_800_000_000_000;
  const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => clock++);
  let request: ClaudeSlotSelection;
  try {
    request = selection();
  } finally {
    clockSpy.mockRestore();
  }
  expect({ valid: isClaudeSlotSelection(request), ttlMs: request.expiresAt - request.observedAt })
    .toEqual({ valid: true, ttlMs: 30_000 });
});
async function selectionFixture() {
  const key = await newKey(); const nodeId = await enroll(key, "synthetic-claude-selector");
  const token = crypto.randomUUID();
  await registry().beginMessageConnection(nodeId, token);
  await registry().updateRegistration(nodeId, { ...FACTS, os: "win32" }, [{ name: "claude", kind: "cli" }], ["messaging.v1"], token);
  return { key, nodeId, token };
}
const actorRow = (request: ClaudeSlotSelection) => ({ runtime: "claude-code", sessionId: request.sessionId, state: "reachable-probable", kind: "fork" });

describe("v2b committed selection and permanent historical receipts", () => {
  beforeEach(async () => {
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM audit WHERE action='intercom.claude-selection'");
      state.storage.sql.exec("UPDATE intercom_slots SET node_id=NULL,runtime=NULL,session_id=NULL,chat_name=NULL,revision=0");
    });
  });
  it("requires the exact eligible committed source/generation, then persists NULL title and one receipt", async () => {
    const { nodeId, token } = await selectionFixture(); const request = selection();
    const prep = await registry().prepareClaudeSelection(nodeId, request, token);
    expect(prep.prepared).toBeDefined();
    expect(await registry().finishClaudeSelection(nodeId, request, token, 1, prep.prepared!)).toMatchObject({ outcome: "denied" });
    const untouched = await registry().listIntercomSlots();
    expect(await registry().replaceSessions(nodeId, [actorRow(request), { sessionId: a.sessionId, runtime: "codex", state: "unknown", title: "Unrelated" }], { version: 1, generation: 1 }, token)).toEqual({ ok: true });
    expect(await registry().finishClaudeSelection(nodeId, request, token, 2, prep.prepared!)).toMatchObject({ outcome: "denied" });
    const assigned = await registry().finishClaudeSelection(nodeId, request, token, 1, prep.prepared!);
    expect(assigned).toMatchObject({ outcome: "assigned", revision: 1 });
    expect((await registry().listIntercomSlots()).find(row => row.slot === request.slot)?.occupant).toEqual({ nodeId, runtime: "claude-code", sessionId: request.sessionId, chatName: null });
    expect((await registry().listIntercomSlots()).filter(row => row.slot !== request.slot)).toEqual(untouched.filter(row => row.slot !== request.slot));
    await runInDurableObject(registry(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT title FROM sessions WHERE node_id=? AND session_id=?", nodeId, a.sessionId).one().title).toBe("Unrelated");
      expect(state.storage.sql.exec("SELECT 1 FROM audit WHERE action='intercom.claude-selection'").toArray()).toHaveLength(1);
    });
  });
  it("captures revision before digest, resolves two contenders exactly once and replays lost result historically", async () => {
    const { nodeId, token } = await selectionFixture(); const first = selection("kherep-lead"), second = selection("kherep-lead", a.sessionId);
    const [p1, p2] = await Promise.all([registry().prepareClaudeSelection(nodeId, first, token), registry().prepareClaudeSelection(nodeId, second, token)]);
    expect(p1.prepared?.expectedRevision).toBe(0); expect(p2.prepared?.expectedRevision).toBe(0);
    await registry().replaceSessions(nodeId, [actorRow(first), actorRow(second)], { version: 1, generation: 1 }, token);
    expect(await registry().finishClaudeSelection(nodeId, first, token, 1, p1.prepared!)).toMatchObject({ outcome: "assigned", revision: 1 });
    expect(await registry().finishClaudeSelection(nodeId, second, token, 1, p2.prepared!)).toMatchObject({ outcome: "conflict", revision: 1 });
    const next = selection("kherep-lead", a.sessionId); const pn = await registry().prepareClaudeSelection(nodeId, next, token);
    await registry().finishClaudeSelection(nodeId, next, token, 1, pn.prepared!);
    const before = await registry().listIntercomSlots();
    const historical = await registry().prepareClaudeSelection(nodeId, { ...first, requestId: crypto.randomUUID(), observedAt: 1, expiresAt: 2 }, token);
    expect(historical.result).toMatchObject({ outcome: "assigned", revision: 1 });
    expect(await registry().listIntercomSlots()).toEqual(before);
    expect(await registry().prepareClaudeSelection(nodeId, { ...first, slot: "claude-windows" }, token)).toMatchObject({ result: { outcome: "denied" } });
    await runInDurableObject(registry(), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT 1 FROM audit WHERE action='intercom.claude-selection'").toArray()).toHaveLength(3);
    });
  });
  it("expired unseen, missing actor, UNKNOWN, auxiliary and stale connection never mutate slots", async () => {
    const { nodeId, token } = await selectionFixture();
    expect(await registry().prepareClaudeSelection(nodeId, { ...selection(), observedAt: 1, expiresAt: 2 }, token)).toMatchObject({ result: { outcome: "denied" } });
    for (const state of ["unknown", "deleted", "closed", "archived"]) {
      const request = selection(); const prep = await registry().prepareClaudeSelection(nodeId, request, token);
      await registry().replaceSessions(nodeId, [{ ...actorRow(request), state }], undefined, token);
      expect(await registry().finishClaudeSelection(nodeId, request, token, 1, prep.prepared!)).toMatchObject({ outcome: "denied" });
    }
    const request = selection(); const prep = await registry().prepareClaudeSelection(nodeId, request, token);
    await registry().replaceSessions(nodeId, [{ ...actorRow(request), kind: "subagent" }], { version: 1, generation: 1 }, token);
    expect(await registry().finishClaudeSelection(nodeId, request, token, 1, prep.prepared!)).toMatchObject({ outcome: "denied" });
    const before = await registry().listSessions();
    await registry().beginMessageConnection(nodeId, crypto.randomUUID());
    expect(await registry().replaceSessions(nodeId, [actorRow(request)], { version: 1, generation: 2 }, token)).toMatchObject({ ok: false });
    expect(await registry().listSessions()).toEqual(before);
    expect(await registry().finishClaudeSelection(nodeId, request, token, 1, prep.prepared!)).toMatchObject({ outcome: "denied" });
    expect((await registry().listIntercomSlots()).every(row => row.occupant === null)).toBe(true);
  });
  it("audit storage failure rolls back CAS and adds no fabricated receipt", async () => {
    const { nodeId, token } = await selectionFixture(); const request = selection(); const prep = await registry().prepareClaudeSelection(nodeId, request, token);
    await registry().replaceSessions(nodeId, [actorRow(request)], { version: 1, generation: 1 }, token);
    await runInDurableObject(registry(), (instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER fail_selection_receipt BEFORE INSERT ON audit WHEN NEW.action='intercom.claude-selection' BEGIN SELECT RAISE(ABORT, 'synthetic storage full'); END");
      try { expect(() => instance.finishClaudeSelection(nodeId, request, token, 1, prep.prepared!)).toThrow("synthetic storage full"); }
      finally { state.storage.sql.exec("DROP TRIGGER fail_selection_receipt"); }
      expect(instance.listIntercomSlots().find(row => row.slot === request.slot)?.revision).toBe(0);
      expect(state.storage.sql.exec("SELECT 1 FROM audit WHERE action='intercom.claude-selection'").toArray()).toHaveLength(0);
    });
  });
  it("reads fixed current addresses without audit, rejects vacancy/legacy Lead/wrong platform and rereads after replacement", async () => {
    const { nodeId, token } = await selectionFixture();
    const lookup = () => registry().slotAddress(nodeId, token, "kherep-lead", crypto.randomUUID());
    expect(await lookup()).toMatchObject({ error: "unavailable" });
    await runInDurableObject(registry(), (_instance, state) => {
      seedNodes(state.storage.sql); replaceIntercomSlot(state.storage.sql, "kherep-lead", 0, a);
    });
    expect(await lookup()).toMatchObject({ error: "unavailable" });
    await runInDurableObject(registry(), (_instance, state) => { replaceIntercomSlot(state.storage.sql, "kherep-lead", 1, b); });
    expect(await lookup()).toMatchObject({ address: { nodeId: b.nodeId, session: b.sessionId } });
    await runInDurableObject(registry(), (_instance, state) => { replaceIntercomSlot(state.storage.sql, "kherep-lead", 2, { ...b, sessionId: a.sessionId }); });
    expect(await lookup()).toMatchObject({ address: { nodeId: b.nodeId, session: a.sessionId } });
    expect(await registry().slotAddress(nodeId, "old-token", "kherep-lead", crypto.randomUUID())).toMatchObject({ error: "unavailable" });
    await runInDurableObject(registry(), (_instance, state) => {
      state.storage.sql.exec("UPDATE nodes SET os='linux' WHERE id=?", b.nodeId);
      expect(state.storage.sql.exec("SELECT 1 FROM audit WHERE action='intercom.claude-selection'").toArray()).toHaveLength(0);
    });
    expect(await lookup()).toMatchObject({ error: "unavailable" });
  });
  it("ordinary enrolled WS snapshot commits before assignment, replay avoids republishing rows, and directory lane returns only correlated address", async () => {
    const key = await newKey(), nodeId = await enroll(key, "synthetic-ws-selector"); const socket = await authenticate(nodeId, key);
    socket.send(makeEnvelope("register", { facts: { ...FACTS, os: "win32" }, runtimes: [{ name: "claude", kind: "cli" }], capabilities: ["messaging.v1"] }, 1, 0));
    socket.send(makeEnvelope("directory.get", {}, 2, 0)); await until(socket, "directory", {});
    const request = selection();
    socket.send(makeEnvelope("sessions.snapshot", { sessions: [actorRow(request)], identitySnapshot: { version: 1, generation: 1 }, slotSelection: request }, 3, 0));
    const assigned = (await until(socket, "event", { kind: "slot-selection", requestId: request.requestId })).at(-1)!.body;
    expect(assigned).toMatchObject({ outcome: "assigned", revision: 1 });
    expect((await registry().listSessions()).find(s => s.nodeId === nodeId)?.sessionId).toBe(request.sessionId);
    const replay = { ...request, requestId: crypto.randomUUID() };
    socket.send(makeEnvelope("sessions.snapshot", { sessions: [], identitySnapshot: { version: 1, generation: 2 }, slotSelection: replay }, 4, 0));
    expect((await until(socket, "event", { kind: "slot-selection", requestId: replay.requestId })).at(-1)!.body).toMatchObject({ outcome: "assigned", revision: 1 });
    expect((await registry().listSessions()).find(s => s.nodeId === nodeId)?.sessionId).toBe(request.sessionId);
    const requestId = crypto.randomUUID(); socket.send(makeEnvelope("directory.get", { slot: request.slot, requestId }, 5, 0));
    expect((await until(socket, "directory", { kind: "slot-address", requestId })).at(-1)!.body).toEqual({ kind: "slot-address", slot: request.slot, requestId, address: { nodeId, session: request.sessionId } });
    socket.ws.close();
  });
});


it("v2b migration preserves all five rows, revisions, historical titles and prior audit receipts", async () => {
  await runInDurableObject(registry(), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec("DROP TABLE intercom_slots");
    sql.exec(`CREATE TABLE intercom_slots (
      slot TEXT PRIMARY KEY NOT NULL CHECK(slot IN ('kherep-lead','codex-windows','claude-windows','codex-mac','claude-mac')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      node_id TEXT, runtime TEXT, session_id TEXT, chat_name TEXT,
      CHECK ((node_id IS NULL AND runtime IS NULL AND session_id IS NULL AND chat_name IS NULL)
      OR (node_id IS NOT NULL AND runtime IS NOT NULL AND session_id IS NOT NULL AND chat_name IS NOT NULL
        AND length(node_id)>0 AND runtime IN ('codex','claude-code') AND length(session_id)>0 AND length(chat_name)>0)),
      CHECK(slot='kherep-lead' OR (slot IN ('codex-windows','codex-mac') AND runtime='codex')
        OR (slot IN ('claude-windows','claude-mac') AND runtime='claude-code')))`);
    for (const slot of INTERCOM_SLOTS) sql.exec("INSERT INTO intercom_slots(slot) VALUES(?)", slot);
    seedNodes(sql); replaceIntercomSlot(sql, "kherep-lead", 0, a); replaceIntercomSlot(sql, "claude-windows", 0, b);
    sql.exec("UPDATE intercom_slots SET revision=17 WHERE slot='codex-windows'");
    sql.exec("INSERT INTO audit(ts,actor,action,target,detail) VALUES(1,'synthetic','historic.decision','historic','{}')");
    const before = rows(sql), receipts = sql.exec("SELECT * FROM audit").toArray();
    initializeRegistrySchema(state.storage); initializeRegistrySchema(state.storage);
    expect(rows(sql)).toEqual(before); expect(sql.exec("SELECT * FROM audit").toArray()).toEqual(receipts);
    expect(replaceIntercomSlot(sql, "claude-windows", 1, { ...b, chatName: null })).toBe(2);
    expect(readIntercomSlots(sql).find(row => row.slot === "kherep-lead")?.occupant).toEqual(a);
  });
});


import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { NodeClient } from "../../node/client.mts";
import { nodePaths, writeConfig, type NodePaths } from "../../node/config.mts";
import { connectionClaudeHooks, recordingSessions } from "../../node/exchange-sessions.mts";
import { exchangeOptions, pollExchange, writeSlotExchange, readSlotExchange, getOutbox, getSent } from "../../node/exchange.mts";
import { generateIdentity } from "../../node/identity.mts";
import { storeMessage, getMessage } from "../../node/inbox.mts";
import { runMsgArgs } from "../../node/msg-cli.mts";
import { deliverForHook } from "../../node/deliver-hook.mts";
import { DEFAULT_POLICY } from "../../node/policy.mts";
import { workerFetch } from "./helpers.mts";
import { isClaudeSlotResult } from "../../protocol.mts";

async function slotNode(paths: NodePaths, ids: string[]) {
  const identity = generateIdentity(); const nodeId = await enroll({ publicKey: identity.publicKey, privateKey: undefined as unknown as CryptoKey }, `synthetic-slot-${crypto.randomUUID().slice(0, 8)}`);
  const hooks = connectionClaudeHooks(paths);
  const policy = { ...DEFAULT_POLICY, messaging: { accept: [{ session: "*", from: ["*"] }] } };
  fs.mkdirSync(paths.dir, { recursive: true }); fs.writeFileSync(paths.policy, JSON.stringify(policy));
  writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId, name: "synthetic-slot", publicKey: identity.publicKey,
    privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date().toISOString() });
  const listing = recordingSessions(paths, async () => ids.map(sessionId => ({ sessionId, runtime: "claude-code", state: "unknown" })), () => {});
  let chain = Promise.resolve();
  const client = new NodeClient({ nodeId, identity, policy,
    handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": listing },
    facts: () => ({ ...FACTS, os: "darwin" }), runtimes: async () => [{ name: "claude", kind: "cli" }], sessions: listing,
    storeMessage: body => { storeMessage(paths.inbox, body); }, ...exchangeOptions(paths),
    recordClaudeHook: request => { hooks.set(request.sessionId, { sessionId: request.sessionId, observedAt: request.observedAt }); return true; },
    enqueueSlotWork: run => { chain = chain.then(run); },
  });
  const ws = (await workerFetch(`/node/connect?nodeId=${nodeId}`, { headers: { upgrade: "websocket" } })).webSocket!;
  const send = (frame: string) => { ws.send(client.stamp(frame)); return true; };
  ws.addEventListener("message", event => { chain = chain.then(async () => { for (const frame of await client.onFrame(event.data as string)) send(frame); }); });
  ws.accept();
  await vi.waitFor(async () => { expect(client.authenticated).toBe(true); expect((await registry().getNode(nodeId))?.runtimes).toEqual([{ name: "claude", kind: "cli" }]); }, { timeout: 5_000 });
  const inflight = new Map<string, number>();
  const exchange = async () => { chain = chain.then(() => { pollExchange(client, paths, inflight, send); }); await chain; };
  const select = async (sessionId: string) => {
    const request = selection("claude-mac", sessionId); writeSlotExchange(paths, "selection", request.requestId, request); await exchange();
    await vi.waitFor(() => expect(isClaudeSlotResult(readSlotExchange(paths, "selection-result", request.requestId))).toBe(true), { timeout: 5_000 });
    expect(readSlotExchange(paths, "selection-result", request.requestId)).toMatchObject({ outcome: "assigned" });
  };
  return { nodeId, paths, ws, exchange, select, idle: () => chain };
}

it("v2b actual CLI -> exchange -> enrolled WS/SQLite address -> one ordinary send -> Claude Hook -> ordinary reply, then fresh reassignment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-slot-e2e-"));
  const senderId = crypto.randomUUID(), receiverId = crypto.randomUUID(), successorId = crypto.randomUUID();
  const sender = await slotNode(nodePaths(path.join(root, "a")), [senderId]);
  const receiver = await slotNode(nodePaths(path.join(root, "b")), [receiverId, successorId]);
  try {
    await receiver.select(receiverId);
    const sendRole = async (text: string) => {
      const output: string[] = [], errors: string[] = [];
      const code = await runMsgArgs({ positionals: ["send", "claude-mac", text], values: {} }, { paths: sender.paths, env: { CLAUDE_CODE_SESSION_ID: senderId },
        out: s => output.push(s), err: s => errors.push(s), sleep: async () => { await sender.exchange(); await new Promise(resolve => setTimeout(resolve, 20)); } });
      expect([code, errors]).toEqual([0, []]); return output[0];
    };
    const question = await sendRole("synthetic slot question");
    expect(getOutbox(sender.paths, question)?.to).toEqual({ nodeId: receiver.nodeId, session: receiverId });
    await sender.exchange();
    await vi.waitFor(() => expect(getMessage(receiver.paths.inbox, question)?.state).toBe("accepted"), { timeout: 5_000 });
    const output = deliverForHook({ session_id: receiverId, hook_event_name: "UserPromptSubmit" }, { paths: receiver.paths });
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain("synthetic slot question");
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(`--reply-to ${question}`);
    deliverForHook({ session_id: receiverId, hook_event_name: "Stop" }, { paths: receiver.paths }); await receiver.exchange();
    const replies: string[] = [], errors: string[] = [];
    expect(await runMsgArgs({ positionals: ["send", "synthetic reply"], values: { "reply-to": question } }, { paths: receiver.paths, env: { CLAUDE_CODE_SESSION_ID: receiverId },
      out: s => replies.push(s), err: s => errors.push(s) })).toBe(0); expect(errors).toEqual([]);
    expect(getOutbox(receiver.paths, replies[0])?.to).toEqual({ nodeId: sender.nodeId, session: senderId });
    await receiver.exchange();
    await vi.waitFor(() => expect(getMessage(sender.paths.inbox, replies[0])?.text).toBe("synthetic reply"), { timeout: 5_000 });
    await receiver.select(successorId);
    const after = await sendRole("synthetic successor question");
    expect(getOutbox(sender.paths, after)?.to).toEqual({ nodeId: receiver.nodeId, session: successorId });
    await sender.exchange();
    await vi.waitFor(() => expect(getMessage(receiver.paths.inbox, after)?.toSession).toBe(successorId), { timeout: 5_000 });
    await runInDurableObject(registry(), (_instance, state) => {
      for (const id of [question, replies[0], after]) expect(state.storage.sql.exec("SELECT id FROM messages WHERE id=? UNION ALL SELECT id FROM message_tombstones WHERE id=?", id, id).toArray()).toHaveLength(1);
    });
  } finally { await Promise.all([sender.idle(), receiver.idle()]); sender.ws.close(); receiver.ws.close(); fs.rmSync(root, { recursive: true, force: true }); }
});


it("v2b CAS rechecks decision policy context and exact published generation after preparation", async () => {
  const { nodeId, token } = await selectionFixture(); const request = selection();
  const prep = await registry().prepareClaudeSelection(nodeId, request, token);
  await registry().replaceSessions(nodeId, [actorRow(request)], { version: 1, generation: 1 }, token);
  await registry().replaceSessions(nodeId, [actorRow(request)], { version: 1, generation: 2 }, token);
  expect(await registry().finishClaudeSelection(nodeId, request, token, 1, prep.prepared!)).toMatchObject({ outcome: "denied" });
  await registry().updateRegistration(nodeId, { ...FACTS, os: "win32" }, [{ name: "claude", kind: "cli" }], ["messaging.v1", "synthetic-policy-change"], token);
  expect(await registry().finishClaudeSelection(nodeId, request, token, 2, prep.prepared!)).toMatchObject({ outcome: "denied" });
});
