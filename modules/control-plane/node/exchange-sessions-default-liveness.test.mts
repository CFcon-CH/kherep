import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { SessionInfo } from "../protocol.mts";
import { CANONICAL_IDENTITY_MAX_AGE_MS, fullSessionId } from "../protocol-session-identity.mts";
import { nodePaths } from "./config.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { readJson } from "./inbox.mts";
import { markUnseen, unlistedRuntimes } from "./known-sessions.mts";
import { attachLiveness, createLivenessPass } from "./liveness-pass.mts";
import { labelsFile, readBindingView, readLabelState } from "./session-labels.mts";
import { readLivenessSnapshot, sessionVerdict } from "./session-lifecycle.mts";
import { autonomousEligibility } from "./session-liveness.mts";
import { LABEL_FRESH_MS, resolveWakeSelection } from "./wake-bindings.mts";

const S = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const NOW = 1_760_000_000_000;
interface Projection {
    sessions: { sessionId: string; runtime: string; name?: string; state: string }[];
    unseen: string[];
    labelBindingEpoch?: string;
}
function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p828-default-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = nodePaths(root);
    fs.mkdirSync(paths.dir, { recursive: true });
    let now = NOW;
    const policy = (sessions: string[]) => fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [],
        wake: { enabled: true, sessions, replies: true } }));
    policy(["review", S]);
    const pass = createLivenessPass(undefined, () => now);
    t.after(() => pass.stop());
    const publish = async (rows: SessionInfo[], unseen: string[] = []) => {
        markUnseen(rows, unseen);
        const observation = await pass.observe(rows);
        assert.equal(observation.status, "unknown");
        assert.equal(observation.source, "unsupported");
        assert.equal(observation.reasonCode, "unsupported");
        assert.equal(observation.complete, false);
        attachLiveness(rows, observation);
        return recordingSessions(paths, async () => rows, () => {}, () => now)();
    };
    const select = (token = "review", sessionId = S) => resolveWakeSelection([token], {
        target: { runtime: "claude-code", sessionId }, view: readBindingView(paths, now), now });
    return { paths, pass, policy, publish, select, now: () => now, advance: () => { now += 1000; } };
}
function row(sessionId = S, name = "review", observedAt = NOW): SessionInfo {
    return { sessionId, name, runtime: "claude-code", state: "unknown", canonicalIdentity: {
        version: 1, source: "claude-list", runtime: "claude-code", sessionId, observedAt, lifecycleGeneration: 0 } };
}

test("828 C default unsupported liveness initializes labels from a complete Claude listing", async (t) => {
    const { paths, pass } = fixture(t);
    const rows = [row()];
    const observation = await pass.observe(rows);
    assert.equal(observation.status, "unknown");
    assert.equal(observation.source, "unsupported");
    assert.equal(observation.reasonCode, "unsupported");
    assert.equal(observation.complete, false);
    attachLiveness(rows, observation);

    const published = await recordingSessions(paths, async () => rows, () => {}, () => NOW)();
    assert.deepEqual(published.map(({ sessionId, runtime, state }) => ({ sessionId, runtime, state })),
        [{ sessionId: S, runtime: "claude-code", state: "unknown" }]);
    assert.deepEqual(unlistedRuntimes(published), []);
    const projection = readJson<Projection>(paths.sessions)!;
    assert.deepEqual(projection.sessions, [{ sessionId: S, name: "review", runtime: "claude-code", state: "unknown", listed: true }]);
    assert.deepEqual(projection.unseen, []);

    assert.equal(fs.existsSync(labelsFile(paths)), true, "complete Claude listing must persist label state with a name-to-ID binding");
    const state = readLabelState(paths);
    assert.ok(state, "label state must validate against its projection witness");
    assert.equal(state.complete, true);
    assert.deepEqual(state.bindings, [{ token: "review", runtime: "claude-code", sessionId: S,
        firstName: "review", boundAt: NOW, sourceGeneration: state.localGeneration, provenance: "policy-co-list" }]);
    assert.equal(state.local.length, 1);
    assert.equal(state.local[0].name, "review");
    assert.equal(state.local[0].sessionId, S);
    assert.equal(state.local[0].current, true);
    assert.equal(projection.labelBindingEpoch, state.epoch);
    assert.equal(fullSessionId(state.epoch), true);
    const verdict = sessionVerdict(paths, rows[0], NOW);
    assert.equal(verdict.state, "unknown");
    assert.equal(autonomousEligibility(verdict, "wake"), false);
    assert.equal(autonomousEligibility(verdict, "queue"), false);
});

const incompleteCases = [
    { name: "Claude unseen", unseen: ["claude-code"], capped: false },
    { name: "global unseen", unseen: ["*"], capped: false },
    { name: "snapshot cap", unseen: [], capped: true },
];
function incompleteRows(now: number, capped: boolean): SessionInfo[] {
    const rows = [row(S, "review", now), row(T, "analysis", now)];
    if (capped) for (let n = 1; n <= 511; n++)
        rows.push(row(`33333333-3333-4333-8333-${String(n).padStart(12, "0")}`, `fixture-${n}`, now));
    return rows;
}
for (const { name, unseen, capped } of incompleteCases) {
    test(`828 C default ${name} prevents label initialization`, async (t) => {
        const f = fixture(t);
        f.policy(["review", S, "analysis", T]);
        const published = await f.publish(incompleteRows(f.now(), capped), unseen);
        assert.equal(readLivenessSnapshot(f.paths)?.capped === true, capped);
        assert.deepEqual(unlistedRuntimes(published), capped ? ["*"] : unseen);
        assert.equal(fs.existsSync(labelsFile(f.paths)), false);
        assert.equal(readJson<Projection>(f.paths.sessions)?.labelBindingEpoch, undefined);
        assert.equal(f.select().allowed, false);
    });
    test(`828 C default ${name} preserves reservations without adding a binding`, async (t) => {
        const f = fixture(t);
        await f.publish([row()]);
        const before = readLabelState(f.paths)!;
        assert.equal(before.bindings.length, 1);
        f.policy(["review", S, "analysis", T]);
        f.advance();
        const published = await f.publish(incompleteRows(f.now(), capped), unseen);
        assert.equal(readLivenessSnapshot(f.paths)?.capped === true, capped);
        assert.deepEqual(unlistedRuntimes(published), capped ? ["*"] : unseen);
        const after = readLabelState(f.paths)!;
        assert.deepEqual(after.bindings, before.bindings);
        assert.equal(after.complete, false);
        assert.equal(after.observedAt, before.observedAt);
        assert.equal(f.select("analysis", T).allowed, false);
    });
}

test("828 C default Codex-only unseen does not prevent a Claude binding", async (t) => {
    const f = fixture(t);
    const published = await f.publish([row()], ["codex"]);
    assert.deepEqual(unlistedRuntimes(published), ["codex"]);
    const state = readLabelState(f.paths)!;
    assert.equal(state.complete, true);
    assert.equal(state.bindings.length, 1);
    assert.equal(state.bindings[0].sessionId, S);
    assert.equal(state.bindings[0].provenance, "policy-co-list");
    assert.equal(f.select().reason, "bound-name");
    assert.equal(f.select().explicit, true);
});

for (const established of [false, true])
    test(`828 C thrown listing ${established ? "preserves established bytes and freshness" : "creates no label artifacts"}`, async (t) => {
        const f = fixture(t);
        if (established) await f.publish([row()]);
        const files = [labelsFile(f.paths), f.paths.sessions];
        const before = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
        const state = readLabelState(f.paths);
        f.advance();
        await assert.rejects(recordingSessions(f.paths, async () => { throw new Error("synthetic listing failure"); },
            () => {}, f.now)(), /synthetic listing failure/);
        for (const [i, file] of files.entries()) {
            if (before[i]) assert.deepEqual(fs.readFileSync(file), before[i]);
            else assert.equal(fs.existsSync(file), false);
        }
        assert.deepEqual(readLabelState(f.paths), state);
        if (established) assert.equal(f.select().reason, "bound-name");
    });

for (const established of [false, true])
    test(`828 C default empty successful listing ${established ? "retains reservations with noncurrent labels" : "initializes healthy empty labels"}`, async (t) => {
        const f = fixture(t);
        if (established) await f.publish([row()]);
        const bindings = readLabelState(f.paths)?.bindings ?? [];
        f.advance();
        await f.publish([]);
        const state = readLabelState(f.paths)!;
        assert.ok(state);
        assert.equal(state.complete, true);
        assert.equal(state.observedAt, f.now());
        assert.deepEqual(state.bindings, bindings);
        assert.equal(state.bindings.length, established ? 1 : 0);
        assert.equal(state.local.length, established ? 1 : 0);
        assert.equal(state.local.some(label => label.current !== false), false);
        assert.equal(readJson<Projection>(f.paths.sessions)?.labelBindingEpoch, state.epoch);
        assert.equal(f.select().allowed, established);
    });

for (const proof of ["missing", "source-stale", "label-stale"] as const)
    for (const established of [false, true])
        test(`828 C default ${proof} proof cannot bind ${established ? "a new token or invent a veto" : "the first token"}`, async (t) => {
            const f = fixture(t);
            if (established) await f.publish([row()]);
            const bindings = readLabelState(f.paths)?.bindings ?? [];
            f.policy(["review", S, "analysis", T]);
            f.advance();
            const rows = [row(S, "review", f.now()), row(T, "analysis", f.now())];
            for (const entry of rows) {
                if (proof === "missing") delete entry.canonicalIdentity;
                else entry.canonicalIdentity!.observedAt = f.now() - (proof === "source-stale"
                    ? CANONICAL_IDENTITY_MAX_AGE_MS : LABEL_FRESH_MS) - 1;
            }
            await f.publish(rows);
            const state = readLabelState(f.paths)!;
            assert.equal(state.complete, true);
            assert.deepEqual(state.bindings, bindings);
            assert.deepEqual(state.identityVetoes, []);
            assert.equal(f.select("analysis", T).allowed, false);
            assert.equal(f.select().allowed, established);
        });

for (const kind of ["duplicate", "runtime"] as const)
    test(`828 C default real ${kind} veto survives partial fresh proof without rebinding`, async (t) => {
        const f = fixture(t);
        await f.publish([row()]);
        const bindings = readLabelState(f.paths)!.bindings;
        f.policy(["review", "analysis", S]);
        f.advance();
        const rows: SessionInfo[] = kind === "duplicate" ? [row(S, "review", f.now()), row(S, "review", f.now())]
            : [row(S, "review", f.now()), { sessionId: S, runtime: "codex", name: "other", state: "unknown" }];
        await f.publish(rows);
        assert.equal(f.select().allowed, false);
        assert.equal(f.select().reason, "identity-conflict");
        const vetoes = readLabelState(f.paths)!.identityVetoes;
        assert.ok(vetoes.some(veto => veto.sessionId === S && veto.runtime === "claude-code" && veto.kind === "conflict"));
        assert.deepEqual(readLabelState(f.paths)!.bindings, bindings);
        f.advance();
        await f.publish([row(S, "analysis", f.now())], ["claude-code"]);
        const state = readLabelState(f.paths)!;
        assert.equal(state.complete, false);
        assert.deepEqual(state.identityVetoes, vetoes);
        assert.deepEqual(state.bindings, bindings);
        assert.equal(f.select().allowed, false);
        assert.equal(f.select("analysis").allowed, false);
        const verdict = sessionVerdict(f.paths, { runtime: "claude-code", sessionId: S }, f.now());
        assert.equal(verdict.state, "unknown");
        assert.equal(autonomousEligibility(verdict, "wake"), false);
        assert.equal(autonomousEligibility(verdict, "queue"), false);
    });
