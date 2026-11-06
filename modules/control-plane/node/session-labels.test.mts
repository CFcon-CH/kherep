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
test("absent source rows retain local label history but cannot provide current name compatibility", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
    recordLocalLabels(p, [], now + 1000, true, policyStamp(p));
    assert.equal(resolveWakeSelection(["review"], { target: { runtime: "claude-code", sessionId: S }, view: readBindingView(p), now: now + 1000 }).allowed, false);
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
    fs.writeFileSync(p.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: ["review", S] } }));
    recordLocalLabels(p, [row("review", now + 1000)], now + 1000, true, policyStamp(p));
    assert.equal(readLabelState(p)?.bindings.length, 512);
    assert.equal(readLabelState(p)?.bindings.some(b => b.token === "review"), false);
});
test("policy removal during reducer cannot commit a first binding", t => {
    const p = fixture(t, ["review"]);
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
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
    recordLocalLabels(p, [row("review")], now, true, policyStamp(p));
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
