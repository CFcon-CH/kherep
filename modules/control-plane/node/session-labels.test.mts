import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionInfo } from "../protocol.mts";
import { nodePaths } from "./config.mts";
import { recordLocalLabels, readLabelState, readBindingView, policyStamp, labelsFile } from "./session-labels.mts";
import { resolveWakeSelection } from "./wake-bindings.mts";
const S = "11111111-1111-4111-8111-111111111111";
const now = Date.UTC(2026, 10, 6, 12);
const row = (name: string, at = now): SessionInfo => ({ runtime: "claude-code", sessionId: S, name, state: "unknown", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: at, lifecycleGeneration: 0 } });
function fixture(t: test.TestContext, tokens = ["review", S]) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "p828-state-")); t.after(() => fs.rmSync(root, { force: true, recursive: true })); const p = nodePaths(root); fs.mkdirSync(p.dir, { recursive: true }); fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: tokens } })); return p; }
test("local same-time conflicting and older source labels cannot overwrite accepted observation", t => {
    const p = fixture(t);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    recordLocalLabels(p, [row("analysis", now + 1000)], now + 1000, true, policyStamp(p));
    recordLocalLabels(p, [row("review", now)], now + 2000, true, policyStamp(p));
    assert.equal(readLabelState(p)?.local[0].name, "analysis");
});
test("known simultaneous state/witness disappearance in one process cannot initialize again", t => {
    const p = fixture(t);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    assert.ok(readLabelState(p));
    fs.rmSync(labelsFile(p));
    fs.rmSync(p.sessions);
    recordLocalLabels(p, [row("review", now + 1000)], now + 1000, true, policyStamp(p));
    assert.equal(readBindingView(p).status, "history-unavailable");
});
test("absent source rows retain local label history; only the first-sight binding, not the label, keeps the grant", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    recordLocalLabels(p, [], now + 1000, true, policyStamp(p));
    const view = readBindingView(p);
    assert.equal(view.local[0].current, false);
    assert.equal(resolveWakeSelection(["review"], { target: { runtime: "claude-code", sessionId: S }, view: { ...view, bindings: [] }, now: now + 1000 }).allowed, false);
    assert.equal(resolveWakeSelection(["review"], { target: { runtime: "claude-code", sessionId: S }, view, now: now + 1000 }).reason, "bound-name");
    recordLocalLabels(p, [row("analysis", now + 2000)], now + 2000, true, policyStamp(p));
});
test("partial observations cannot first-bind", t => {
    const p = fixture(t);
    recordLocalLabels(p, [row("review")], now, false, policyStamp(p));
    assert.equal(readLabelState(p), null);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    recordLocalLabels(p, [row("analysis", now + 1000)], now + 1000, false, policyStamp(p));
});
test("token reservations are separately capped without eviction", t => {
    const p = fixture(t, []);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    const s = readLabelState(p)!;
    s.bindings = Array.from({ length: 512 }, (_, i) => ({ token: `name-${i}`, runtime: "claude-code", sessionId: S, firstName: `name-${i}`, boundAt: now, sourceGeneration: 1, provenance: "policy-co-list" as const }));
    fs.writeFileSync(labelsFile(p), JSON.stringify(s));
    // The release rule frees bindings of unlisted tokens, so every bound token stays listed and the extra one passes the cap.
    fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: [...s.bindings.map(b => b.token), "review", S] } }));
    recordLocalLabels(p, [row("review", now + 1000)], now + 1000, true, policyStamp(p));
    assert.equal(readLabelState(p)?.bindings.length, 512);
    assert.equal(readLabelState(p)?.bindings.some(b => b.token === "review"), false);
});
test("policy removal during reducer cannot commit a first binding", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [], now, true, policyStamp(p));
    fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["review", S] } }));
    const read = fs.readFileSync;
    let raced = false;
    const mock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        const result = Reflect.apply(read, fs, args);
        if (!raced && String(args[0]) === labelsFile(p)) {
            raced = true;
            fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["review"] } }));
        }
        return result;
    });
    recordLocalLabels(p, [row("review", now + 1000)], now + 1000, true, policyStamp(p));
    mock.mock.restore();
    assert.equal(raced, true);
    assert.equal(readLabelState(p)?.bindings.length, 0);
});
test("superseding durable state version cannot be overwritten by an older reducer", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [], now, true, policyStamp(p));
    fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["review", S] } }));
    const read = fs.readFileSync;
    let raced = false;
    let changedVersion = 0;
    const mock = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        const result = Reflect.apply(read, fs, args);
        if (!raced && String(args[0]) === labelsFile(p)) {
            raced = true;
            const other = JSON.parse(String(result));
            other.version += 10;
            changedVersion = other.version;
            fs.writeFileSync(labelsFile(p), JSON.stringify(other));
        }
        return result;
    });
    recordLocalLabels(p, [row("review", now + 1000)], now + 1000, true, policyStamp(p));
    mock.mock.restore();
    assert.equal(raced, true);
    assert.equal(readLabelState(p)?.version, changedVersion);
    assert.equal(readLabelState(p)?.bindings.length, 0);
});
const C = "019a2b3c-4d5e-7f60-8123-456789abcdef";
const codexRow = (title?: string): SessionInfo => ({ runtime: "codex", sessionId: C, name: "codex-89abcdef", state: "unknown", kind: "codex", ...(title ? { title } : {}) });
const codexLabel = (p: ReturnType<typeof fixture>) => readLabelState(p)?.local.find(r => r.runtime === "codex");
test("#828 a Codex title change over two complete listings is a rename by id with previousName", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [codexRow("A")], now, true, policyStamp(p));
    assert.equal(codexLabel(p)?.name, "A");
    assert.equal(codexLabel(p)?.revision, 1);
    recordLocalLabels(p, [codexRow("B")], now + 1000, true, policyStamp(p));
    const label = codexLabel(p)!;
    assert.deepEqual([label.name, label.revision, label.previousName, label.renamedAt, label.current], ["B", 2, "A", now + 1000, true]);
    assert.equal(readLabelState(p)?.bindings.length, 0, "a Codex title never becomes a binding holder");
});
test("#828 a missing Codex title is unknown and keeps the old row", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [codexRow("A")], now, true, policyStamp(p));
    recordLocalLabels(p, [codexRow()], now + 1000, true, policyStamp(p));
    const label = codexLabel(p)!;
    assert.deepEqual([label.name, label.revision, label.previousName, label.current], ["A", 1, undefined, true]);
    recordLocalLabels(p, [codexRow()], now + 2000, true, policyStamp(p));
    assert.equal(codexLabel(p)?.name, "A");
});
test("#828 a Claude rename records previousName one level deep and keeps it while the name holds", t => {
    const p = fixture(t, [S]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    assert.equal(readLabelState(p)?.local[0].previousName, undefined);
    recordLocalLabels(p, [row("analysis", now + 1000)], now + 1000, true, policyStamp(p));
    recordLocalLabels(p, [row("analysis", now + 2000)], now + 2000, true, policyStamp(p));
    let label = readLabelState(p)!.local[0];
    assert.deepEqual([label.name, label.revision, label.previousName, label.renamedAt], ["analysis", 2, "review", now + 1000]);
    recordLocalLabels(p, [row("final", now + 3000)], now + 3000, true, policyStamp(p));
    label = readLabelState(p)!.local[0];
    assert.deepEqual([label.name, label.revision, label.previousName, label.renamedAt], ["final", 3, "analysis", now + 3000]);
});
test("#828 previousName is omitted when it would push the state over its byte bound", t => {
    const p = fixture(t, []);
    const ids = Array.from({ length: 1000 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`);
    const rows = (prefix: string, at: number): SessionInfo[] => ids.map(sessionId => ({ runtime: "claude-code", sessionId, name: `${prefix}${sessionId}`.padEnd(128, prefix), state: "unknown",
        canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId, observedAt: at, lifecycleGeneration: 0 } }));
    recordLocalLabels(p, rows("a", now), now, true, policyStamp(p));
    recordLocalLabels(p, rows("b", now + 1000), now + 1000, true, policyStamp(p));
    const state = readLabelState(p)!;
    assert.ok(fs.statSync(labelsFile(p)).size <= 512 * 1024);
    assert.equal(state.local.every(r => r.name.startsWith("b") && r.revision === 2 && r.previousName === undefined && r.renamedAt === now + 1000), true);
});
test("#828 a malformed previousName or renamedAt invalidates the stored history", t => {
    const p = fixture(t, [S]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    for (const extra of [{ previousName: "" }, { renamedAt: -1 }]) {
        const s = readLabelState(p) ?? JSON.parse(fs.readFileSync(labelsFile(p), "utf8"));
        Object.assign(s.local[0], { previousName: undefined, renamedAt: undefined }, extra);
        fs.writeFileSync(labelsFile(p), JSON.stringify(s));
        assert.equal(readLabelState(p), null);
    }
});
const claudeRows = (n: number, at: number, offset = 0): SessionInfo[] => Array.from({ length: n }, (_, i) => {
    const sessionId = `11111111-1111-4111-8111-${String(i + offset).padStart(12, "0")}`;
    return { runtime: "claude-code", sessionId, name: `n${sessionId}`.padEnd(128, "n"), state: "unknown",
        canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId, observedAt: at, lifecycleGeneration: 0 } };
});
test("#828 Codex rows accumulating over many listings stay readable and under the byte bound", t => {
    const p = fixture(t, []);
    for (let round = 0; round < 6; round++) {
        const rows: SessionInfo[] = Array.from({ length: 500 }, (_, i) => ({ runtime: "codex", kind: "codex", state: "unknown", name: "codex-00000000",
            sessionId: `019a2b3c-4d5e-7f60-8123-${String(round * 500 + i).padStart(12, "0")}`, title: `thread ${round}-${i}`.padEnd(60, "t") }));
        recordLocalLabels(p, rows, now + round * 1000, true, policyStamp(p));
    }
    const state = readLabelState(p)!;
    assert.ok(state, "the state stays readable");
    assert.ok(fs.statSync(labelsFile(p)).size <= 512 * 1024);
    assert.ok(state.local.length <= 2048);
    assert.equal(state.local.filter(r => r.current !== false).length, 500, "the newest listing is kept whole");
    assert.equal(state.local.some(r => r.name.startsWith("thread 0-")), false, "the oldest absent rows went first");
});
test("#828 a label row a binding references is never pruned", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    recordLocalLabels(p, [], now + 1000, true, policyStamp(p));
    const s = readLabelState(p)!;
    assert.equal(s.bindings[0].sessionId, S);
    s.local[0].observedAt = 0;
    s.local.push(...claudeRows(2047, 1, 1000).map((r, i) => ({ nodeId: "local", runtime: r.runtime, sessionId: r.sessionId, name: `x${i}`, observedAt: i + 1,
        lifecycleGeneration: 0, revision: 1, current: false })));
    fs.writeFileSync(labelsFile(p), JSON.stringify(s));
    recordLocalLabels(p, claudeRows(10, now + 2000), now + 2000, true, policyStamp(p));
    const state = readLabelState(p)!;
    assert.ok(state);
    assert.ok(state.local.length <= 2048 && fs.statSync(labelsFile(p)).size <= 512 * 1024);
    assert.equal(state.local.filter(r => r.current !== false).length, 10);
    assert.equal(state.local.some(r => r.sessionId === S), true, "the bound row stays although it is the oldest");
    assert.equal(state.local.some(r => r.current === false && r.observedAt <= 10 && r.sessionId !== S), false);
});
test("#828 the label state round-trips at the byte bound and refuses a write it could not read back", t => {
    const p = fixture(t, []);
    recordLocalLabels(p, claudeRows(1200, now), now, true, policyStamp(p));
    assert.ok(fs.statSync(labelsFile(p)).size <= 512 * 1024);
    assert.equal(readLabelState(p)?.local.length, 1200);
    assert.throws(() => recordLocalLabels(p, claudeRows(1400, now + 1000), now + 1000, true, policyStamp(p)), /label-state-bound/);
    assert.equal(readLabelState(p)?.local.length, 1200, "the last readable state stays");
});
test("#828 a disabled or malformed wake section keeps an existing binding", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    assert.equal(readLabelState(p)?.bindings.length, 1);
    let at = now;
    for (const wake of [{ enabled: false }, { enabled: true, sessions: "review" }]) {
        fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake }));
        at += 1000;
        recordLocalLabels(p, [row("analysis", at)], at, true, policyStamp(p));
        assert.equal(readLabelState(p)?.observedAt, at, "the listing was committed");
        assert.deepEqual(readLabelState(p)?.bindings.map(b => b.sessionId), [S]);
    }
});
test("#828 a partial listing on existing state does not pin at first sight", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [], now, true, policyStamp(p));
    recordLocalLabels(p, [row("review", now + 1000)], now + 1000, false, policyStamp(p));
    assert.equal(readLabelState(p)?.complete, false);
    assert.deepEqual(readLabelState(p)?.bindings, []);
    recordLocalLabels(p, [row("review", now + 2000)], now + 2000, true, policyStamp(p));
    assert.deepEqual(readLabelState(p)?.bindings.map(b => b.provenance), ["first-sight"]);
});
