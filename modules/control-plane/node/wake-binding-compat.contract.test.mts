import { resolveWakeSelection } from "./wake-bindings.mts";
import { publishSynthetic } from "./session-authority-fixture.mts";
import { createAdmissionAuthority } from "./session-authority.mts";
import { syntheticListing } from "./session-authority-fixture.mts";
import { runWake, WAKE_POLL_MS, wakeText } from "./wake-hook.mts";
import { rememberMode } from "./autonomy.mts";
import { writeConfig } from "./config.mts";
import { storeMessage } from "./inbox.mts";
import { readLabelState, readBindingView } from "./session-labels.mts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { nodePaths } from "./config.mts";
import { recordingSessions } from "./exchange-sessions.mts";
import { attachLiveness } from "./liveness-pass.mts";
import { loadPolicy } from "./policy.mts";
import { readJson } from "./inbox.mts";
import type { SessionInfo } from "../protocol.mts";
const S = "11111111-1111-4111-8111-111111111111", T = "22222222-2222-4222-8222-222222222222";
function fixture(t: import("node:test").TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "p828-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = nodePaths(root);
    fs.mkdirSync(paths.dir, { recursive: true });
    let now = Date.now();
    const policy = (tokens: string[]) => { fs.writeFileSync(paths.policy, JSON.stringify({ version: 1, allowedCommands: [], wake: { enabled: true, sessions: tokens, replies: true } })); return loadPolicy(paths.policy); };
    const list = async (rows: {
        sessionId: string;
        name: string;
    }[], complete = true) => {
        now += 1000;
        const sessions: SessionInfo[] = rows.map(row => ({ ...row, runtime: "claude-code", state: "idle", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: row.sessionId, observedAt: now, lifecycleGeneration: 0 } }));
        attachLiveness(sessions, { status: "value", value: [], observedAt: now, complete, source: "native-app", reasonCode: complete ? "observed" : "incomplete" });
        await recordingSessions(paths, async () => sessions, () => { }, () => now)();
    };
    const select = (p: ReturnType<typeof loadPolicy>, id: string, name: string) => {
        const context = { view: readBindingView(paths, now), target: { runtime: "claude-code", sessionId: id }, now };
        return { allowed: resolveWakeSelection(p.wake?.sessions ?? [], context).allowed, explicit: resolveWakeSelection(p.wake?.sessions ?? [], context).explicit };
    };
    return { paths, policy, list, select, now: () => now };
}
test("828 baseline: healthy unique bare name remains allowed and explicit", async (t) => {
    const f = fixture(t), p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }]);
    assert.deepEqual(f.select(p, S, "review"), { allowed: true, explicit: true });
});
test("828 pin follows ID through rename, ID removal and restart; old-name reuse has no grant", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    await f.list([{ sessionId: S, name: "analysis" }, { sessionId: T, name: "review" }]);
    const p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "analysis" }, { sessionId: T, name: "review" }]);
    assert.deepEqual(f.select(p, S, "analysis"), { allowed: true, explicit: true });
    assert.deepEqual(f.select(p, T, "review"), { allowed: false, explicit: false });
    await f.list([{ sessionId: S, name: "analysis" }, { sessionId: T, name: "review" }]);
    assert.deepEqual(f.select(p, S, "analysis"), { allowed: true, explicit: true });
});
test("828 Option A requires co-listed holder for every first binding, including new tokens", async (t) => {
    const f = fixture(t);
    f.policy([]);
    await f.list([{ sessionId: S, name: "review" }]);
    let p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }]);
    assert.equal(readBindingView(f.paths).bindings.length, 0);
    assert.deepEqual(f.select(p, S, "review"), { allowed: true, explicit: true });
    p = f.policy(["review", T]);
    await f.list([{ sessionId: S, name: "review" }]);
    assert.equal(readBindingView(f.paths).bindings.length, 0);
    p = f.policy(["review", "*"]);
    await f.list([{ sessionId: S, name: "review" }]);
    assert.equal(readBindingView(f.paths).bindings.length, 0);
    p = f.policy(["review", S]);
    const bytes = fs.readFileSync(f.paths.policy);
    await f.list([{ sessionId: S, name: "review" }]);
    assert.equal(readBindingView(f.paths).bindings.length, 1);
    assert.deepEqual(fs.readFileSync(f.paths.policy), bytes);
});
test("828 removal and readd preserve reservation while exact IDs remain independent", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    const rows = [{ sessionId: S, name: "analysis" }, { sessionId: T, name: "review" }];
    await f.list(rows);
    for (const [tokens, sAllowed, tAllowed] of [[["review"], true, false], [[S], true, false], [[], false, false], [["review"], true, false], [["review", T], true, true]] as [
        string[],
        boolean,
        boolean
    ][]) {
        const p = f.policy(tokens);
        await f.list(rows);
        assert.equal(f.select(p, S, "analysis").explicit, sAllowed);
        assert.equal(f.select(p, T, "review").explicit, tAllowed);
        assert.equal(readBindingView(f.paths).bindings[0].sessionId, S);
    }
});
for (const damage of ["corrupt", "missing", "schema", "scope", "witness"] as const)
    test(`828 ${damage} history denies names and preserves direct ID`, async (t) => {
        const f = fixture(t);
        f.policy(["review", S]);
        await f.list([{ sessionId: S, name: "review" }]);
        const file = path.join(f.paths.dir, "session-labels.json");
        if (damage === "missing")
            fs.rmSync(file);
        else if (damage === "corrupt")
            fs.writeFileSync(file, "{");
        else if (damage === "witness") {
            const v = readJson<Record<string, unknown>>(f.paths.sessions)!;
            delete v.labelBindingEpoch;
            fs.writeFileSync(f.paths.sessions, JSON.stringify(v));
        }
        else {
            const v = readJson<Record<string, unknown>>(file)!;
            v[damage === "schema" ? "schemaVersion" : "scope"] = damage === "schema" ? 2 : "a".repeat(64);
            fs.writeFileSync(file, JSON.stringify(v));
        }
        const p = f.policy(["review"]);
        await f.list([{ sessionId: S, name: "review" }]);
        assert.equal(f.select(p, S, "review").allowed, false);
        assert.equal(f.select(f.policy([S]), S, "review").explicit, true);
    });
test("828 duplicate names cannot bind, and duplicate IDs across runtimes cannot bind", async (t) => {
    const f = fixture(t);
    const p = f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }, { sessionId: T, name: "review" }]);
    assert.equal(readBindingView(f.paths).bindings.length, 0);
    assert.equal(f.select(f.policy(["review"]), T, "review").allowed, false);
    const now = f.now() + 1000;
    const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown", name: "review", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: now, lifecycleGeneration: 0 } }, { sessionId: S, runtime: "codex", state: "unknown", name: "other" }];
    attachLiveness(rows, { status: "value", value: [], observedAt: now, complete: true, source: "native-app", reasonCode: "observed" });
    f.policy(["review", S]);
    await recordingSessions(f.paths, async () => rows, () => { }, () => now)();
    assert.equal(readBindingView(f.paths).bindings.length, 0);
});
test("828 failed state commit leaves initialization witness and never fresh fallback", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]).endsWith("session-labels.json"))
            throw new Error("synthetic write failure");
        return Reflect.apply(rename, fs, args);
    });
    await assert.rejects(() => f.list([{ sessionId: S, name: "review" }]), /session publication failed/);
    mock.mock.restore();
    assert.ok(readJson<{
        labelBindingEpoch: string;
    }>(f.paths.sessions)?.labelBindingEpoch);
    const p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }]);
    assert.equal(f.select(p, S, "review").allowed, false);
});
test("828 aborted and policy-raced listings never first-bind", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    const now = f.now();
    const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown", name: "review", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: now, lifecycleGeneration: 0 } }];
    attachLiveness(rows, { status: "value", value: [], observedAt: now, complete: true, source: "native-app", reasonCode: "observed" });
    await recordingSessions(f.paths, async () => { f.policy(["review"]); return rows; }, () => { }, () => now)();
    assert.equal(readBindingView(f.paths).bindings.length, 0);
    f.policy(["review", S]);
    const c = new AbortController();
    await assert.rejects(() => recordingSessions(f.paths, async () => { c.abort(); return rows; }, () => { }, () => now)(c.signal));
    assert.equal(readBindingView(f.paths).bindings.length, 0);
});
function enroll(paths: ReturnType<typeof nodePaths>): void { writeConfig(paths.config, { version: 1, controlUrl: "https://control.example.invalid", nodeId: "33333333-3333-4333-8333-333333333333", name: "synthetic", publicKey: "", privateKeyFile: "", policyFile: paths.policy, enrolledAt: new Date(0).toISOString() }); }
test("828 listener refreshes delivery aliases while authorization follows the bound ID", async (t) => {
    const f = fixture(t);
    enroll(f.paths);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    let clock = f.now(), start = clock, changed = false, arrived = false;
    const result = await runWake({ session_id: S, hook_event_name: "Stop", permission_mode: "default" }, { paths: f.paths, now: () => clock, pid: 4242, maxWaitMs: 15000, parentAlive: () => true, runMode: async () => "interactive", sleep: async (ms) => {
            clock += ms;
            if (!changed) {
                changed = true;
                f.policy(["review"]);
                await f.list([{ sessionId: S, name: "analysis" }, { sessionId: T, name: "review" }]);
            }
            if (!arrived && clock >= start + 2 * WAKE_POLL_MS) {
                arrived = true;
                for (const [n, target] of [[4, "analysis"], [5, "review"]] as const)
                    storeMessage(f.paths.inbox, { messageId: `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`, from: { nodeId: "55555555-5555-4555-8555-555555555555", session: "peer" }, toSession: target, text: "synthetic", createdAt: new Date(clock).toISOString() }, clock);
            }
        } });
    assert.deepEqual(result, { code: 2, text: wakeText(1) });
});
test("828 async restart launch check rejects changed binding history before arming or budget", async (t) => {
    const f = fixture(t);
    enroll(f.paths);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    f.policy(["review"]);
    rememberMode(f.paths, S, "default");
    let launch = 0;
    const result = await runWake({ session_id: S, hook_event_name: "SessionStart" }, { paths: f.paths, now: f.now, launchMode: async () => { launch++; fs.writeFileSync(path.join(f.paths.dir, "session-labels.json"), "{"); return "ok"; }, transcriptMode: () => undefined, runMode: async () => { throw new Error("must not arm"); } });
    assert.equal(launch, 1);
    assert.deepEqual(result, { code: 0 });
    assert.equal(fs.existsSync(path.join(f.paths.dir, "turns")), false);
});
test("828 stale bare-name evidence denies while exact-ID authority remains independent", async (t) => {
    const f = fixture(t);
    f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }]);
    const view = readBindingView(f.paths);
    assert.equal(resolveWakeSelection(f.policy(["review"]).wake?.sessions ?? [], { target: { runtime: "claude-code", sessionId: S }, view, now: f.now() + 180001 }).allowed, false);
    assert.equal(resolveWakeSelection(f.policy([S]).wake?.sessions ?? [], { target: { runtime: "claude-code", sessionId: S }, view, now: f.now() + 180001 }).allowed, true);
});
test("828 overlapping discovery commits only the newest started listing", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    let release!: (rows: SessionInfo[]) => void;
    const older = new Promise<SessionInfo[]>(resolve => { release = resolve; });
    const pending = recordingSessions(f.paths, async () => older, () => { }, f.now)();
    await f.list([{ sessionId: S, name: "analysis" }]);
    release([{ sessionId: S, runtime: "claude-code", state: "unknown", name: "review" }]);
    await assert.rejects(pending, /superseded/);
    assert.equal(readBindingView(f.paths).local[0].name, "analysis");
});
test("828 B: a received partial immediately disables bare-name fallback; failed listing cannot resurrect it", async (t) => {
    const f = fixture(t);
    const p = f.policy(["review"]);
    const rows = [{ sessionId: S, name: "review" }];
    await f.list(rows);
    assert.equal(f.select(p, S, "review").explicit, true);
    const acceptedAt = readLabelState(f.paths)!.observedAt;
    await f.list(rows, false);
    assert.equal(f.select(p, S, "review").allowed, false);
    assert.equal(readLabelState(f.paths)?.observedAt, acceptedAt);
    await assert.rejects(recordingSessions(f.paths, async () => { throw new Error("synthetic failed listing"); }, () => { }, () => f.now() + 1000)());
    assert.equal(f.select(p, S, "review").allowed, false);
    assert.equal(readLabelState(f.paths)?.complete, false);
    await f.list(rows);
    assert.equal(f.select(p, S, "review").explicit, true);

    assert.equal(readLabelState(f.paths)?.bindings.length, 0);
});
test("828 B: failed complete listing retains only the existing unrefreshed three-minute window", async (t) => {
    const f = fixture(t);
    const p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }]);
    const before = readLabelState(f.paths)!;
    await assert.rejects(recordingSessions(f.paths, async () => { throw new Error("synthetic failed listing"); }, () => { }, () => f.now() + 1000)());
    const after = readLabelState(f.paths)!;
    assert.deepEqual(after, before);
    assert.equal(f.select(p, S, "review").explicit, true);
    assert.equal(resolveWakeSelection(p.wake?.sessions ?? [], { target: { runtime: "claude-code", sessionId: S }, view: readBindingView(f.paths), now: before.observedAt + 180001 }).allowed, false);
});
test("828 B: partial population leaves established binding and exact/wildcard grants independent", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    await f.list([{ sessionId: S, name: "review" }], false);
    const view = readBindingView(f.paths);
    const p = f.policy(["review"]);
    assert.equal(f.select(p, S, "review").explicit, true);
    assert.equal(view.bindings.length, 1);
    assert.equal(resolveWakeSelection(f.policy([S]).wake?.sessions ?? [], { target: { runtime: "claude-code", sessionId: S }, view, now: f.now() }).allowed, true);
    assert.equal(resolveWakeSelection(f.policy(["*"]).wake?.sessions ?? [], { target: { runtime: "claude-code", sessionId: S }, view, now: f.now() }).explicit, false);
});
test("review R1: bound token survives a complete existing-entry observation without a usable name", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    const p = f.policy(["review"]);
    const now = f.now() + 1000;
    const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: now, lifecycleGeneration: 0 } }];
    attachLiveness(rows, { status: "value", value: [], observedAt: now, complete: true, source: "native-app", reasonCode: "observed" });
    await recordingSessions(f.paths, async () => rows, () => { }, () => now)();
    const view = readBindingView(f.paths);
    assert.equal(view.local[0].current, false);
    assert.equal(view.bindings[0].sessionId, S);
    const context = { target: { runtime: "claude-code", sessionId: S }, view, now };
    assert.equal(resolveWakeSelection(p.wake?.sessions ?? [], context).allowed, true);
    assert.equal(resolveWakeSelection(p.wake?.sessions ?? [], context).explicit, true);
});
test("review R1: real duplicate and runtime contradiction remain negative after bootstrap ID removal", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    const p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }, { sessionId: S, name: "review" }]);
    assert.equal(f.select(p, S, "review").allowed, false);
    const at = f.now() + 1000;
    const rows: SessionInfo[] = [{ sessionId: S, runtime: "codex", state: "unknown", name: "other" }];
    attachLiveness(rows, { status: "value", value: [], observedAt: at, complete: true, source: "native-app", reasonCode: "observed" });
    await recordingSessions(f.paths, async () => rows, () => { }, () => at)();
    assert.equal(f.select(p, S, "review").allowed, false);
});
test("review R1: accepted terminal lifecycle veto survives missing labels and only accepted restore clears it", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    const p = f.policy(["review"]);
    const authority = createAdmissionAuthority(f.paths);
    let at = f.now();
    const observe = async (state: "archived" | "restored", generation: number) => { at += 1000; const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: at, lifecycleGeneration: 0 } }]; syntheticListing(authority, rows, [{ runtime: "claude-code", sessionId: S, lifecycle: { status: "value", value: { state, generation }, observedAt: at, complete: true, source: "native-lifecycle", reasonCode: "observed" } }], at); await recordingSessions(f.paths, async () => rows, () => { }, () => at, undefined, undefined, authority)(); };
    await observe("archived", 1);
    assert.equal(f.select(p, S, "review").allowed, false);
    await observe("restored", 1);
    assert.equal(f.select(p, S, "review").allowed, false, "same-generation contradictory restore is not accepted");
    await observe("restored", 2);
    const context = { target: { runtime: "claude-code", sessionId: S }, view: readBindingView(f.paths), now: at };
    assert.equal(resolveWakeSelection(p.wake?.sessions ?? [], context).allowed, true, "accepted restored exact identity does not need a display label");
});
test("review R1: absent canonical label proof is not a new terminal or identity conflict", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    const p = f.policy(["review"]);
    const at = f.now() + 1000;
    const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown" }];
    attachLiveness(rows, { status: "value", value: [], observedAt: at, complete: true, source: "native-app", reasonCode: "observed" });
    await recordingSessions(f.paths, async () => rows, () => { }, () => at)();
    assert.equal(f.select(p, S, "review").explicit, true);
});
test("review R1: stale identity evidence cannot clear a genuine conflict, fresh exact evidence can", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    const p = f.policy(["review"]);
    await f.list([{ sessionId: S, name: "review" }, { sessionId: S, name: "review" }]);
    const conflictAt = f.now();
    const observe = async (at: number, proofAt: number) => { const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: proofAt, lifecycleGeneration: 0 } }]; attachLiveness(rows, { status: "value", value: [], observedAt: at, complete: true, source: "native-app", reasonCode: "observed" }); await recordingSessions(f.paths, async () => rows, () => { }, () => at)(); return resolveWakeSelection(p.wake?.sessions ?? [], { target: { runtime: "claude-code", sessionId: S }, view: readBindingView(f.paths), now: at }).allowed; };
    assert.equal(await observe(conflictAt + 200000, conflictAt + 1000), false);
    assert.equal(await observe(conflictAt + 201000, conflictAt + 201000), true);
});
test("review R1: unresolved identity veto cannot seed a new token", async (t) => {
    const f = fixture(t);
    f.policy(["review", S]);
    await f.list([{ sessionId: S, name: "review" }]);
    await f.list([{ sessionId: S, name: "review" }, { sessionId: S, name: "review" }]);
    const conflictAt = f.now();
    f.policy(["review", "analysis", S]);
    const observe = async (at: number, proofAt: number) => { const rows: SessionInfo[] = [{ sessionId: S, runtime: "claude-code", state: "unknown", name: "analysis", canonicalIdentity: { version: 1, source: "claude-list", runtime: "claude-code", sessionId: S, observedAt: proofAt, lifecycleGeneration: 0 } }]; attachLiveness(rows, { status: "value", value: [], observedAt: at, complete: true, source: "native-app", reasonCode: "observed" }); await recordingSessions(f.paths, async () => rows, () => { }, () => at)(); };
    await observe(conflictAt + 1000, conflictAt - 1);
    assert.equal(readBindingView(f.paths).bindings.some(b => b.token === "analysis"), false);

    await observe(conflictAt + 2000, conflictAt + 2000);
    assert.equal(readBindingView(f.paths).bindings.some(b => b.token === "analysis"), true);

});

for(const kind of ["duplicate","runtime","terminal"] as const) test(`review C3 R1: partial ${kind} evidence vetoes a bound target independently of name completeness`,async t=>{
 const f=fixture(t);f.policy(["review",S]);await f.list([{sessionId:S,name:"review"}]);const p=f.policy(["review"]);let at=f.now()+1000;
 if(kind==="terminal") publishSynthetic(f.paths,[{runtime:"claude-code",sessionId:S,lifecycle:{status:"value",value:{state:"archived",generation:1},observedAt:at,complete:true,source:"native-lifecycle",reasonCode:"observed"}}],at,[]);
 const rows:SessionInfo[]=kind==="duplicate"?[{sessionId:S,runtime:"claude-code",state:"unknown",name:"review"},{sessionId:S,runtime:"claude-code",state:"unknown",name:"review"}]:kind==="runtime"?[{sessionId:S,runtime:"codex",state:"unknown",name:"other"}]:[];
 at+=1000;attachLiveness(rows,{status:"value",value:[],observedAt:at,complete:false,source:"native-app",reasonCode:"incomplete"});await recordingSessions(f.paths,async()=>rows,()=>{},()=>at)();assert.equal(f.select(p,S,"review").allowed,false);assert.equal(readBindingView(f.paths).bindings.length,1);
});
for(const kind of ["stamp","parse"] as const) test(`review C3 R1: ${kind} race cannot discard accepted identity contradiction`,async t=>{
 const f=fixture(t);f.policy(["review",S]);await f.list([{sessionId:S,name:"review"}]);const p=f.policy(["review"]);const at=f.now()+1000;if(kind==="parse")fs.writeFileSync(f.paths.policy,"{");
 const rows:SessionInfo[]=[{sessionId:S,runtime:"claude-code",state:"unknown",name:"review"},{sessionId:S,runtime:"claude-code",state:"unknown",name:"review"}];attachLiveness(rows,{status:"value",value:[],observedAt:at,complete:true,source:"native-app",reasonCode:"observed"});await recordingSessions(f.paths,async()=>{if(kind==="stamp")f.policy(["review","other"]);return rows;},()=>{},()=>at)();assert.equal(f.select(p,S,"review").allowed,false);assert.equal(readBindingView(f.paths).bindings.length,1);
});
test("review C3 R2: equal-time proof does not clear a conflict; strictly newer proof does",async t=>{
 const f=fixture(t);f.policy(["review",S]);await f.list([{sessionId:S,name:"review"}]);const p=f.policy(["review"]);await f.list([{sessionId:S,name:"review"},{sessionId:S,name:"review"}]);const conflictAt=f.now();
 const observe=async(at:number,proofAt:number)=>{const rows:SessionInfo[]=[{sessionId:S,runtime:"claude-code",state:"unknown",canonicalIdentity:{version:1,source:"claude-list",runtime:"claude-code",sessionId:S,observedAt:proofAt,lifecycleGeneration:0}}];attachLiveness(rows,{status:"value",value:[],observedAt:at,complete:true,source:"native-app",reasonCode:"observed"});await recordingSessions(f.paths,async()=>rows,()=>{},()=>at)();return resolveWakeSelection(p.wake?.sessions ?? [], {target:{runtime:"claude-code",sessionId:S},view:readBindingView(f.paths),now:at}).allowed;};
 assert.equal(await observe(conflictAt+1000,conflictAt),false);assert.equal(await observe(conflictAt+2000,conflictAt+2000),true);
});
for(const reasonCode of ["malformed","identity","conflict"] as const) test(`review C3: UNKNOWN availability reason ${reasonCode} alone is not an identity contradiction`,async t=>{
 const f=fixture(t);f.policy(["review",S]);await f.list([{sessionId:S,name:"review"}]);const p=f.policy(["review"]);const at=f.now()+1000;const rows:SessionInfo[]=[{sessionId:S,runtime:"claude-code",state:"unknown",canonicalIdentity:{version:1,source:"claude-list",runtime:"claude-code",sessionId:S,observedAt:at,lifecycleGeneration:0}}];
 attachLiveness(rows,{status:"value",value:[{runtime:"claude-code",sessionId:S,holder:{status:"unknown",observedAt:at,complete:false,source:"native-holder",reasonCode}}],observedAt:at,complete:true,source:"native-app",reasonCode:"observed"});await recordingSessions(f.paths,async()=>rows,()=>{},()=>at)();assert.equal(f.select(p,S,"review").explicit,true);
});
