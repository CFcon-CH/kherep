import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { makeEnvelope, parseEnvelope, PING_FRAME, type Envelope, type SessionInfo } from "../protocol.mts";
import { digestMcpArguments, isCodexActivityRegistration, type CodexActivityStamp, type CodexActivityRegistration } from "../protocol-mcp.mts";
import { nativeMcpAssignment } from "./mcp-assignment.mts";
import { processMcpIntentHook } from "./mcp-intent-hook.mts";
import { NodeClient } from "./client.mts";
import { nodePaths } from "./config.mts";
import { CodexActivity, recordingSessions } from "./exchange-sessions.mts";
import { attachLiveness } from "./liveness-pass.mts";
import { generateIdentity, writePrivateKey } from "./identity.mts";
import { readNativeMcpAssignment } from "./mcp-assignment.mts";
import { enqueueMcpIntent, pollMcpIntents, recordMcpIntentReceipt } from "./mcp-local.mts";
import { markUnseen } from "./known-sessions.mts";
import { readLivenessSnapshot, publishLiveness } from "./session-lifecycle.mts";
import { type ReasonCode } from "./session-liveness.mts";
import { startDaemon, SESSIONS_INTERVAL_MS } from "./daemon.mts";
import { EXCHANGE_INTERVAL_MS } from "./exchange.mts";
const A = "11111111-1111-4111-8111-111111111111", B = "44444444-4444-4444-8444-444444444444";
const row = (sessionId = A): SessionInfo => ({ sessionId, runtime: "codex", kind: "codex", state: "unknown", title: sessionId === A ? "Synthetic original A" : "Synthetic companion B" });
const policy = { version: 1 as const, allowedCommands: [], remoteMcp: { enabled: true as const } };
const decode = (raw: string): Envelope => { const parsed = parseEnvelope(raw); assert.ok(parsed.ok); return parsed.envelope; };
function metadata(home: string): void {
    const dir = path.join(home, "sessions", "2026", "11", "09");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-synthetic-${A}.jsonl`), JSON.stringify({ type: "session_meta", payload: {
            id: A, originator: "Codex Desktop", source: "vscode"
        } }) + '\n{"SYNTHETIC_BODY":"MUST NOT BE READ"}\n');
    fs.writeFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({ id: A, thread_name: "Synthetic original A", updated_at: "2026-11-09T00:00:00Z" }) + "\n");
}
async function stamp(now: number, sessionId = A): Promise<CodexActivityStamp> {
    return { kind: "codex-activity-v1", observedAt: now, intent: { requestId: crypto.randomUUID(), runtime: "codex", sessionId,
            threadId: sessionId, callId: crypto.randomUUID(), tool: "assign_self", argumentsDigest: await digestMcpArguments({ slot: "codex-mac" }),
            assignment: { slot: "codex-mac", turnId: crypto.randomUUID() } } };
}
function reserveAndStage(owner: CodexActivity, value: CodexActivityStamp, now: number): boolean {
  return owner.reserve(value, now) && owner.stage(value, now);
}
async function fixture(t: test.TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-activity-")), paths = nodePaths(root);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.policy, JSON.stringify(policy));
    const home = path.join(root, "synthetic-native");
    metadata(home);
    const owner = new CodexActivity();
    let now = Date.now(), rows = [row(), row(B)], unseen: string[] = [];
    let nativeGate: Promise<void> | undefined, listingGate: Promise<void> | undefined, nativeValid = true;
    let sourceReason: ReasonCode = "unsupported", futureEvidence = false, listingFailures = 0, nativeReads = 0;
    const list = recordingSessions(paths, async () => {
        await listingGate;
        if (listingFailures > 0) { listingFailures--;throw new Error("synthetic listing failure"); }
        const listed = rows.map(r => ({ ...r }));
        markUnseen(listed, unseen);
        return attachLiveness(listed, { status: "unknown", observedAt: now + (futureEvidence ? 1 : 0), complete: false, source: "unsupported", reasonCode: sourceReason });
    }, () => { }, () => now, undefined, undefined, undefined, undefined, owner);
    const receipts: unknown[] = [], frames: string[] = [], inflight = new Set<string>();
    const client = new NodeClient({ nodeId: "00000000-0000-4000-8000-0000000000aa", identity: generateIdentity(), policy,
        handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": async () => [] },
        facts: () => ({ hostname: "synthetic.example.invalid", os: "darwin", arch: "arm64", cpus: 1, memoryBytes: 1 }),
        runtimes: async () => [{ name: "codex", kind: "cli" }], sessions: list, codexActivity: owner, now: () => now,
        assignmentIdentity: async (id, context) => { nativeReads++; await nativeGate; return nativeValid ? readNativeMcpAssignment(home, id, context) : null; },
        storeMessage: () => { }, mcpIntentReceipt: body => { receipts.push(body); recordMcpIntentReceipt(paths, inflight, body); },
    });
    await client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
    now++;
    const receive = (body: object) => client.onFrame(JSON.stringify(makeEnvelope("mcp.intent.receipt", body, 0, 0)));
    const settle = async () => {
      for (let i=0;i<1000 && (client as unknown as {activityBatch:unknown}).activityBatch;i++) await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal((client as unknown as {activityBatch:unknown}).activityBatch,null,"bounded preparation settles");
    };
    return { root, paths, home, owner, client, list, frames, inflight, receipts, settle, now: () => now,
        advance: (ms: number) => { now += ms; }, rows: (next: SessionInfo[]) => { rows = next; }, unseen: (next: string[]) => { unseen = next; },
        nativeGate: (gate: Promise<void>) => { nativeGate = gate; }, listingGate: (gate: Promise<void>) => { listingGate = gate; }, invalidNative: () => { nativeValid = false; },
        evidence: (reason: ReasonCode, future = false) => { sourceReason = reason; futureEvidence = future; },
        failNextListing: () => { listingFailures++; }, nativeReads: () => nativeReads,
        request: () => stamp(now), receive, accept: (s: CodexActivityStamp) => receive({ requestId: s.intent.requestId, ok: true, expiresAt: s.observedAt + 60000, version: 1 }),
        poll: async (send = (frame: string) => { frames.push(frame); return true; }) => {
          await pollMcpIntents(client, paths, inflight, send);
          if (!nativeGate && !listingGate) await settle();
        },
    };
}
test("pending recording remains private until the exact positive receipt, then expires at original time", async (t) => {
    const f = await fixture(t), request = await f.request();
    const [raw] = await f.client.registerCodexActivity(request);
    assert.ok(raw);
    const wire = decode(raw).body;
    assert.ok(isCodexActivityRegistration(wire));
    assert.deepEqual(wire.sessions.map(r => r.state), ["reachable-probable", "unknown"]);
    assert.equal(readLivenessSnapshot(f.paths)!.sessions.find(r => r.sessionId === A)!.observedAt, request.observedAt);
    assert.deepEqual(f.owner.observations(f.now()), []);
    assert.deepEqual((await f.list()).map(r => r.state), ["unknown", "unknown"]);
    await f.accept(request);
    assert.equal(f.owner.observations(f.now()).length, 1);
    assert.deepEqual((await f.list()).map(r => r.state), ["reachable-probable", "unknown"]);
    f.advance(59999);
    assert.equal((await f.list())[0].state, "reachable-probable");
    f.advance(1);
    assert.deepEqual((await f.list()).map(r => r.state), ["unknown", "unknown"]);
});
test("canonical Worker refusal and timeout do not confirm evidence or cache a staged commit", async (t) => {
    for (const failure of ["negative", "timeout"] as const) {
        const f = await fixture(t), request = await f.request();
        const before = f.client.knownMcpIntents([request.intent]);
        assert.equal((await f.client.registerCodexActivity(request)).length, 1);
        if (failure === "negative")
            await f.receive({ requestId: request.intent.requestId, ok: false, error: "too many unexpired MCP intents" });
        else
            f.advance(8000);
        assert.deepEqual(f.owner.observations(f.now()), []);
        assert.deepEqual(f.client.knownMcpIntents([request.intent]), before);
        assert.deepEqual((await f.list()).map(r => r.state), ["unknown", "unknown"]);
        assert.deepEqual(await f.client.registerCodexActivity(request), []);
    }
});
test("written copies cannot renew time, change native call binding, or cross a connection/restart", async (t) => {
    const f = await fixture(t), request = await f.request();
    assert.equal((await f.client.registerCodexActivity(request)).length, 1);
    await f.accept(request);
    const retry = await f.client.registerCodexActivity(structuredClone(request));
    assert.equal(retry.length, 1);
    assert.equal((decode(retry[0]).body as CodexActivityRegistration).observedAt, request.observedAt);
    for (const changed of [{ ...request, observedAt: request.observedAt + 1 },
        { ...request, intent: { ...request.intent, requestId: crypto.randomUUID() } },
        { ...request, intent: { ...request.intent, argumentsDigest: "b".repeat(64) } }]) {
        f.advance(1);
        assert.deepEqual(await f.client.registerCodexActivity(changed), []);
    }
    f.client.connectionClosed();
    assert.deepEqual(f.owner.observations(f.now()), []);
    f.advance(1);
    await f.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
    assert.deepEqual(await f.client.registerCodexActivity(request), []);
    const restarted = new CodexActivity();
    restarted.connect(f.now());
    assert.equal(restarted.stage(request, f.now()), false);
    f.advance(1);
    const fresh = await f.request();
    assert.equal((await f.client.registerCodexActivity(fresh)).length, 1);
});
test("first-seen A/B/A ordering cannot restore older evidence; seen capacity never evicts", async () => {
    const owner = new CodexActivity();
    owner.connect(100);
    const a = await stamp(101), b = await stamp(102);
    assert.ok(reserveAndStage(owner, a, 101));
    assert.ok(owner.confirm(a, 101));
    assert.ok(reserveAndStage(owner, b, 102));
    assert.ok(owner.confirm(b, 102));
    assert.equal(reserveAndStage(owner, a, 102), false);
    assert.equal(owner.confirm(a, 102), false);
    assert.deepEqual(owner.observations(102), [b]);
    const bounded = new CodexActivity();
    bounded.connect(100);
    const first = await stamp(101);
    assert.ok(reserveAndStage(bounded, first, 101));
    assert.ok(bounded.confirm(first, 101));
    let newest = first;
    for (let i = 1; i < 4096; i++) {
        newest = { ...first, intent: { ...first.intent, requestId: crypto.randomUUID(), callId: `call-${i}` } };
        assert.ok(reserveAndStage(bounded, newest, 101));
    }
    assert.equal(reserveAndStage(bounded, { ...first, intent: { ...first.intent, requestId: crypto.randomUUID(), callId: "overflow" } }, 101), false);
    assert.equal(reserveAndStage(bounded, first, 101), false);
    assert.ok(reserveAndStage(bounded, newest, 101));
    assert.equal(bounded.observations(101)[0].observedAt, 101);
    assert.deepEqual(bounded.observations(60101), []);
    assert.equal(reserveAndStage(bounded, { ...first, observedAt: 60101, intent: { ...first.intent, requestId: crypto.randomUUID(), callId: "overflow-later" } }, 60101), false);
});
test("128 Codex sessions are isolated and expired active entries make room without renewing a duplicate", async () => {
    const owner = new CodexActivity();
    owner.connect(100);
    const requests: CodexActivityStamp[] = [];
    for (let i = 0; i < 128; i++) {
        const request = await stamp(101, crypto.randomUUID());
        requests.push(request);
        assert.ok(reserveAndStage(owner, request, 101));
        assert.ok(owner.confirm(request, 101));
    }
    const extra = await stamp(102, crypto.randomUUID());
    assert.equal(reserveAndStage(owner, extra, 102), false);
    assert.equal(owner.observations(102).length, 128);
    const later = await stamp(60101, extra.intent.sessionId);
    assert.ok(reserveAndStage(owner, later, 60101));
    assert.ok(owner.confirm(later, 60101));
    assert.equal(reserveAndStage(owner, requests[0], 60101), false);
    assert.deepEqual(owner.observations(60101), [later]);
});
for (const failure of ["missing", "duplicate", "foreign-runtime", "task", "intercom", "fork", "closed", "unseen-codex", "unseen-global", "513", "oversize", "native", "conflicting-evidence", "malformed-evidence", "future-evidence"] as const) {
    test(`fresh activity refuses ${failure} without fallback or a confirmed observation`, async (t) => {
        const f = await fixture(t), request = await f.request();
        if (failure === "missing")
            f.rows([row(B)]);
        if (failure === "duplicate")
            f.rows([row(), row(), row(B)]);
        if (failure === "foreign-runtime")
            f.rows([{ ...row(), runtime: "claude-code" }, row(B)]);
        if (["task", "intercom", "fork"].includes(failure))
            f.rows([{ ...row(), kind: `codex-${failure}` }, row(B)]);
        if (failure === "closed")
            publishLiveness(f.paths, [{ runtime: "codex", sessionId: A,
                    holder: { status: "value", value: { present: false }, source: "native-holder", observedAt: f.now(), complete: true, reasonCode: "observed" },
                    app: { status: "value", value: "absent", source: "native-app", observedAt: f.now(), complete: true, reasonCode: "observed" } }], f.now());
        if (failure.startsWith("unseen"))
            f.unseen([failure === "unseen-codex" ? "codex" : "*"]);
        if (failure === "513" || failure === "oversize")
            f.rows([row(), ...Array.from({ length: failure === "513" ? 512 : 500 }, () => ({ ...row(crypto.randomUUID()), title: "x".repeat(100) }))]);
        if (failure === "native")
            f.invalidNative();
        if (failure === "conflicting-evidence")
            f.evidence("conflict");
        if (failure === "malformed-evidence")
            f.evidence("malformed");
        if (failure === "future-evidence")
            f.evidence("observed", true);
        assert.deepEqual(await f.client.registerCodexActivity(request), []);
        assert.deepEqual(f.owner.observations(f.now()), []);
    });
}
for (const stage of ["native", "recording", "policy-before", "policy-after"] as const)
    for (const change of ["disconnect", "expiry", "policy", "snapshot"] as const) {
        test(`rechecks ${change} after ${stage} await`, async (t) => {
            const f = await fixture(t), request = await f.request();
            let release!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            if (stage === "native")
                f.nativeGate(gate);
            if (stage === "recording")
                f.listingGate(gate);
            let policyCalls = 0;
            const before = async () => { policyCalls++; if (stage === "policy-before" && policyCalls === 1 || stage === "policy-after" && policyCalls === 2)
                await gate; return true; };
            const pending = f.client.registerCodexActivity(request, before);
            for (let i = 0; i < 20; i++)
                await new Promise(resolve => setImmediate(resolve));
            if (change === "disconnect")
                f.client.connectionClosed();
            if (change === "expiry")
                f.advance(8000);
            if (change === "policy")
                await f.client.refreshPolicy({ version: 1, allowedCommands: [] });
            if (change === "snapshot")
                f.client.sessionFrames([row(), row(B)]);
            release();
            assert.deepEqual(await pending, []);
            assert.deepEqual(f.owner.observations(f.now()), []);
        });
    }
test("polling uses immutable ingress, exact leaf and no standalone fallback after send failure", async (t) => {
    const f = await fixture(t), request = await f.request();
    enqueueMcpIntent(f.paths, request);
    const file = path.join(f.paths.mcpIntents, `${request.intent.requestId}.json`), wrong = path.join(f.paths.mcpIntents, `${crypto.randomUUID()}.json`);
    fs.renameSync(file, wrong);
    await f.poll();
    assert.deepEqual(f.frames, []);
    fs.renameSync(wrong, file);
    await f.poll(() => false);
    assert.equal(f.inflight.size, 0);
    assert.deepEqual(f.owner.observations(f.now()), []);
    assert.deepEqual((await f.list()).map(r => r.state), ["unknown", "unknown"]);
    const expired = { ...request, observedAt: Date.now() - 9000, intent: { ...request.intent, requestId: crypto.randomUUID(), callId: "expired-copy" } };
    enqueueMcpIntent(f.paths, expired);
    const old = path.join(f.paths.mcpIntents, `${expired.intent.requestId}.json`);
    fs.utimesSync(old, new Date(), new Date());
    await f.poll();
    assert.equal(fs.existsSync(old), false);
    assert.deepEqual(f.frames, []);
});
async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !predicate(); i++)
        await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(predicate(), "bounded milestone reached");
}
test("real isolated hook process and production daemon wiring stage exact UNKNOWN original, then discard actual refusal shape", async (t) => {
    if (process.platform !== "darwin") {
        t.skip("native daemon producer is Mac-only; portable NodeClient/WS/SQL/SDK cases run separately");
        return;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-codex-daemon-activity-")), paths = nodePaths(root), home = path.join(root, "synthetic-native");
    metadata(home);
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.policy, JSON.stringify(policy));
    const identity = generateIdentity();
    writePrivateKey(paths.privateKey, identity);
    const config = { version: 1 as const, controlUrl: "https://control.example.invalid", nodeId: "00000000-0000-4000-8000-0000000000aa", name: "synthetic", publicKey: identity.publicKey,
        privateKeyFile: paths.privateKey, policyFile: paths.policy, enrolledAt: new Date(0).toISOString() };
    t.mock.method(os, "hostname", () => "synthetic-node");
    t.mock.method(os, "platform", () => "darwin");
    t.mock.method(os, "arch", () => "arm64");
    t.mock.method(os, "cpus", () => []);
    t.mock.method(os, "totalmem", () => 1024);
    t.mock.method(globalThis, "fetch", async () => new Response("synthetic absent", { status: 404 }));
    const prior = { socket: globalThis.WebSocket, interval: globalThis.setInterval, clear: globalThis.clearInterval, home: process.env.CODEX_HOME };
    process.env.CODEX_HOME = home;
    const listeners = new Map<string, (event: {
        data?: string;
        code?: number;
    }) => void>(), timers = new Map<number, () => void>(), frames: Envelope[] = [];
    class Socket {
        static OPEN = 1;
        readyState = 1;
        addEventListener(name: string, cb: (event: {
            data?: string;
            code?: number;
        }) => void) { listeners.set(name, cb); }
        send(raw: string) { if (raw !== PING_FRAME)
            frames.push(decode(raw)); }
        close(code = 1000) { this.readyState = 3; listeners.get("close")?.({ code }); }
    }
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: Socket });
    globalThis.setInterval = ((cb: () => void, ms: number) => { if (!timers.has(ms))
        timers.set(ms, cb); return { interval: ms }; }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => { }) as typeof clearInterval;
    const handle = startDaemon(config, paths, () => { }, async () => [row(), row(B)], async () => ({ ok: true }));
    let child: ReturnType<typeof spawn> | undefined;
    t.after(async () => {
        child?.kill();
        handle.stop();
        await handle.done;
        Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: prior.socket });
        globalThis.setInterval = prior.interval;
        globalThis.clearInterval = prior.clear;
        if (prior.home === undefined)
            delete process.env.CODEX_HOME;
        else
            process.env.CODEX_HOME = prior.home;
        fs.rmSync(root, { recursive: true, force: true });
    });
    listeners.get("open")?.({});
    listeners.get("message")?.({ data: JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)) });
    await waitFor(() => frames.some(f => f.type === "sessions.snapshot"));
    frames.length = 0;
    child = spawn(process.execPath, [path.join(import.meta.dirname, "mcp-intent-hook.mts"), "--config-root", root], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout!.on("data", chunk => stdout.push(chunk));
    child.stderr!.on("data", chunk => stderr.push(chunk));
    const closed = once(child, "close");
    child.stdin!.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: A, turn_id: "synthetic-turn", tool_use_id: "synthetic-native-call",
        tool_name: "mcp__kherep_messaging__assign_self", tool_input: { slot: "codex-mac" }, prompt: "SYNTHETIC_BODY_MUST_NOT_PERSIST" }));
    await waitFor(() => fs.existsSync(paths.mcpIntents) && fs.readdirSync(paths.mcpIntents).some(f => f.endsWith(".json")));
    timers.get(EXCHANGE_INTERVAL_MS)!();
    await waitFor(() => frames.some(f => f.type === "mcp.intent.register"));
    const wire = frames.find(f => f.type === "mcp.intent.register")!.body;
    assert.ok(isCodexActivityRegistration(wire));
    assert.deepEqual(wire.sessions.map(r => r.state), ["reachable-probable", "unknown"]);
    assert.equal(wire.intent.assignment!.native!.chatName, "Synthetic original A");
    assert.equal(JSON.stringify(wire).includes("SYNTHETIC_BODY"), false);
    assert.equal(wire.observedAt, readLivenessSnapshot(paths)!.sessions.find(r => r.sessionId === A)!.observedAt);
    // Isolated wiring replays the exact canonical Worker capacity denial shape.
    listeners.get("message")?.({ data: JSON.stringify(makeEnvelope("mcp.intent.receipt", { requestId: wire.intent.requestId, ok: false, error: "too many unexpired MCP intents" }, 0, 0)) });
    const [exit] = await closed;
    assert.equal(exit, 0, Buffer.concat(stderr).toString("utf8"));
    const output = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    assert.equal(output.hookSpecificOutput.permissionDecisionReason, "remote_mcp_intent_rejected_worker_capacity");
    assert.equal(output.hookSpecificOutput.updatedInput, undefined);
    frames.length = 0;
    timers.get(SESSIONS_INTERVAL_MS)!();
    await waitFor(() => frames.some(f => f.type === "sessions.snapshot"));
    const next = frames.find(f => f.type === "sessions.snapshot")!.body as {
        sessions: SessionInfo[];
    };
    assert.deepEqual(next.sessions.map(r => r.state), ["unknown", "unknown"]);
});
test("confirmed source reaches the daemon's ordinary periodic recording wrapper", async (t) => {
    const f = await fixture(t), request = await f.request();
    assert.equal((await f.client.registerCodexActivity(request)).length, 1);
    await f.accept(request);
    const { recordAndPublishSessions } = await import("./periodic-session-publication.mts");
    const listed = attachLiveness([row(), row(B)], { status: "unknown" as const, observedAt: f.now(), complete: false as const, source: "unsupported" as const, reasonCode: "unsupported" as const });
    const frames: string[] = [];
    await recordAndPublishSessions(f.client, f.paths, listed, raw => { frames.push(raw); return true; }, () => { }, new AbortController().signal);
    const body = decode(frames[0]).body as {
        sessions: SessionInfo[];
    };
    assert.deepEqual(body.sessions.map(r => r.state), ["reachable-probable", "unknown"]);
});
test("future ingress, late receipts, foreign receipts and retired connection receipts cannot release a staged call", async (t) => {
    const future = await fixture(t), futureRequest = await future.request();
    futureRequest.observedAt++;
    assert.deepEqual(await future.client.registerCodexActivity(futureRequest), []);
    for (const failure of ["late", "wrong-expiry", "retired", "old-socket"] as const) {
        const f = await fixture(t), request = await f.request();
        assert.equal((await f.client.registerCodexActivity(request)).length, 1);
        if (failure === "late")
            f.advance(8000);
        if (failure === "retired") {
            f.client.connectionClosed();
            f.advance(1);
            await f.client.onFrame(JSON.stringify(makeEnvelope("event", { name: "auth.ok" }, 0, 0)));
        }
        const body = { requestId: request.intent.requestId, ok: true, expiresAt: request.observedAt + 60000 + (failure === "wrong-expiry" ? 1 : 0), version: 1 };
        await f.client.onFrame(JSON.stringify(makeEnvelope("mcp.intent.receipt", body, 0, 0)), failure !== "old-socket");
        assert.deepEqual(f.owner.observations(f.now()), []);
        if (failure === "old-socket")
            assert.deepEqual(f.receipts, []);
        else
            assert.equal((f.receipts.at(-1) as {
                ok: boolean;
            }).ok, false);
        assert.deepEqual((await f.list()).map(r => r.state), ["unknown", "unknown"]);
    }
});
test("native metadata timeout is bounded and an ignoring reader cannot stage a late observation", async (t) => {
    const f = await fixture(t), request = await f.request();
    let release!: () => void;
    f.nativeGate(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.client.registerCodexActivity(request);
    const result = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 2500))]);
    release();
    assert.deepEqual(result, []);
    assert.deepEqual(await pending, []);
    assert.deepEqual(f.owner.observations(f.now()), []);
});
test("clean child restart refuses an older written request with fresh mtime", async (t) => {
    const f = await fixture(t), request = await stamp(Date.now());
    enqueueMcpIntent(f.paths, request);
    fs.utimesSync(path.join(f.paths.mcpIntents, `${request.intent.requestId}.json`), new Date(), new Date());
    const code = `
    import fs from 'node:fs';
    import {NodeClient} from ${JSON.stringify(new URL("./client.mts", import.meta.url).href)};
    import {CodexActivity,recordingSessions} from ${JSON.stringify(new URL("./exchange-sessions.mts", import.meta.url).href)};
    import {nodePaths} from ${JSON.stringify(new URL("./config.mts", import.meta.url).href)};
    import {generateIdentity} from ${JSON.stringify(new URL("./identity.mts", import.meta.url).href)};
    import {makeEnvelope} from ${JSON.stringify(new URL("../protocol.mts", import.meta.url).href)};
    import {pollMcpIntents,recordMcpIntentReceipt} from ${JSON.stringify(new URL("./mcp-local.mts", import.meta.url).href)};
    import {readNativeMcpAssignment} from ${JSON.stringify(new URL("./mcp-assignment.mts", import.meta.url).href)};
    const input=JSON.parse(fs.readFileSync(0,'utf8')),paths=nodePaths(input.root),owner=new CodexActivity(),inflight=new Set();
    const sessions=recordingSessions(paths,async()=>input.rows,()=>{},undefined,undefined,undefined,undefined,undefined,owner);
    const client=new NodeClient({nodeId:'00000000-0000-4000-8000-0000000000aa',identity:generateIdentity(),policy:input.policy,
      handlers:{'node.status':async()=>({}),'runtime.list':async()=>[],'session.list':async()=>[]},
      facts:()=>({hostname:'synthetic.example.invalid',os:'darwin',arch:'arm64',cpus:1,memoryBytes:1}),runtimes:async()=>[],sessions,codexActivity:owner,
      assignmentIdentity:(id,context)=>readNativeMcpAssignment(input.home,id,context),storeMessage:()=>{},mcpIntentReceipt:body=>recordMcpIntentReceipt(paths,inflight,body)});
    await client.onFrame(JSON.stringify(makeEnvelope('event',{name:'auth.ok'},0,0)));
    const frames=[];await pollMcpIntents(client,paths,inflight,frame=>{frames.push(frame);return true;});
    process.stdout.write(JSON.stringify({frames:frames.length,active:owner.observations(Date.now()).length,
      receipt:JSON.parse(fs.readFileSync(input.receipt,'utf8')).ok}));
  `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    const timeout = setTimeout(() => child.kill(), 5000);
    t.after(() => { clearTimeout(timeout); child.kill(); });
    const closed = once(child, "close");
    child.stdin.end(JSON.stringify({ root: f.root, home: f.home, rows: [row(), row(B)], policy, receipt: path.join(f.paths.mcpReceipts, `${request.intent.requestId}.json`) }));
    const [exit] = await closed;
    clearTimeout(timeout);
    assert.equal(exit, 0, Buffer.concat(stderr).toString("utf8"));
    assert.deepEqual(JSON.parse(Buffer.concat(stdout).toString("utf8")), { frames: 0, active: 0, receipt: false });
});
test("same-millisecond native calls retain first-seen ordering without A/B/A restoration", async () => {
    const owner = new CodexActivity();
    owner.connect(100);
    const first = await stamp(101), second = await stamp(101);
    assert.ok(reserveAndStage(owner, first, 101));
    assert.ok(owner.confirm(first, 101));
    assert.ok(reserveAndStage(owner, second, 101));
    assert.ok(owner.confirm(second, 101));
    assert.equal(reserveAndStage(owner, first, 101), false);
    assert.equal(owner.confirm(first, 101), false);
    assert.deepEqual(owner.observations(101), [second]);
});
test("known ordinary intents leave before a stamped native-reader wait", async (t) => {
    const f = await fixture(t), request = await f.request();
    let release!: () => void;
    f.nativeGate(new Promise<void>(resolve => { release = resolve; }));
    const ordinary = { ...request.intent, requestId: crypto.randomUUID(), tool: "status" as const, assignment: undefined };
    enqueueMcpIntent(f.paths, ordinary);
    enqueueMcpIntent(f.paths, request);
    const pending = f.poll();
    try {
        for (let i = 0; i < 30; i++)
            await new Promise(resolve => setImmediate(resolve));
        assert.equal((f.frames.map(decode)[0]?.body as {
            tool?: string;
        })?.tool, "status");
    }
    finally {
        release();
        await pending;
    }
    await f.settle();
    assert.equal(f.frames.map(decode).at(-1)!.type, "mcp.intent.register");
    assert.ok(isCodexActivityRegistration(f.frames.map(decode).at(-1)!.body));
});
test("ordinary enqueue keeps its original request leaf even with legacy extra fields", async (t) => {
    const f = await fixture(t), request = await f.request();
    const ordinary = { ...request.intent, tool: "status" as const, assignment: undefined, intent: { requestId: "synthetic-extra-field" } };
    enqueueMcpIntent(f.paths, ordinary);
    assert.equal(fs.existsSync(path.join(f.paths.mcpIntents, `${ordinary.requestId}.json`)), true);
});
test("legacy unstamped records retain their existing ordinary polling route", async (t) => {
    const f = await fixture(t), request = await f.request();
    const ordinary = { ...request.intent, tool: "status" as const, assignment: undefined };
    enqueueMcpIntent(f.paths, ordinary);
    fs.renameSync(path.join(f.paths.mcpIntents, `${ordinary.requestId}.json`), path.join(f.paths.mcpIntents, `${crypto.randomUUID()}.json`));
    await f.poll();
    assert.equal((decode(f.frames[0]).body as {
        requestId: string;
    }).requestId, ordinary.requestId);
    assert.deepEqual(f.owner.observations(f.now()), []);
});


for (const runtime of ["codex", "claude-code"] as const) {
  test(`unresolved ordinary ${runtime} registration precedes a blocked stamp and its original deadline`, async t => {
    const f = await fixture(t);
    await f.client.refreshPolicy({ ...policy, remoteMcp: { enabled: true, claudeCode: true } });f.advance(1);
    const request = await f.request(), sessionId = "77777777-7777-4777-8777-777777777777";
    const ordinary = { requestId: crypto.randomUUID(), runtime, sessionId, callId: "synthetic-unresolved", tool: "status" as const, argumentsDigest: "a".repeat(64) };
    f.rows([row(), row(B), { sessionId, runtime, kind: runtime === "codex" ? "codex" : "interactive", state: "unknown", title: "Synthetic ordinary caller" }]);
    assert.equal(f.client.knownMcpIntents([ordinary]).length, 0);
    enqueueMcpIntent(f.paths, ordinary);enqueueMcpIntent(f.paths, request);
    const deadline = fs.statSync(path.join(f.paths.mcpIntents, `${ordinary.requestId}.json`)).mtimeMs + 8000;
    let wallNow = Date.now();t.mock.method(Date, "now", () => wallNow);
    let release!: () => void;f.nativeGate(new Promise<void>(resolve => { release = resolve; }));
    const sent: { body: unknown; at: number }[] = [];
    const pending = f.poll(raw => { f.frames.push(raw);sent.push({ body: decode(raw).body, at: Date.now() });return true; });
    try {
      for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
      const delivered = sent.find(frame => (frame.body as { requestId?: string }).requestId === ordinary.requestId);
      assert.ok(delivered, "unresolved ordinary registration must leave before stamped native work waits");
      assert.ok(delivered.at < deadline, "the ordinary original deadline must remain valid");
      assert.equal(f.inflight.has(ordinary.requestId), true);
    } finally {
      wallNow = deadline;f.advance(9000);release();await pending;
    }
    assert.equal(sent.some(frame => isCodexActivityRegistration(frame.body)), false, "expired stamp must not bypass its own deadline");
    assert.deepEqual(f.owner.observations(f.now()), []);
  });
}

test("failed ordinary discovery leaves stamp-only processing available without a cached invented commit", async t => {
  const f = await fixture(t), request = await f.request(), sessionId = "77777777-7777-4777-8777-777777777777";
  const ordinary = { requestId: crypto.randomUUID(), runtime: "codex" as const, sessionId, callId: "synthetic-discovery-failure", tool: "status" as const, argumentsDigest: "a".repeat(64) };
  f.rows([row(), row(B), row(sessionId)]);f.failNextListing();
  enqueueMcpIntent(f.paths, ordinary);enqueueMcpIntent(f.paths, request);await f.poll();
  assert.equal(f.client.knownMcpIntents([ordinary]).length, 0);
  assert.equal(f.frames.length, 1);assert.ok(isCodexActivityRegistration(decode(f.frames[0]).body));
  assert.equal(f.inflight.has(ordinary.requestId), false);assert.equal(f.inflight.has(request.intent.requestId), true);
  assert.deepEqual(f.owner.observations(f.now()), []);
});

for (const throws of [false, true]) {
  test(`failed ordinary snapshot ${throws ? "throw" : "send"} preserves stamp and normal retry`, async t => {
    const f = await fixture(t), request = await f.request(), sessionId = "77777777-7777-4777-8777-777777777777";
    const ordinary = { requestId: crypto.randomUUID(), runtime: "codex" as const, sessionId, callId: "synthetic-send-failure", tool: "status" as const, argumentsDigest: "a".repeat(64) };
    f.rows([row(), row(B), row(sessionId)]);enqueueMcpIntent(f.paths, ordinary);enqueueMcpIntent(f.paths, request);
    const pending = f.poll(raw => { assert.equal(decode(raw).type, "sessions.snapshot");if (throws) throw new Error("synthetic ordinary send failure");return false; });
    if (throws) await assert.rejects(pending, /synthetic ordinary send failure/);else await pending;
    assert.equal(f.nativeReads(), 0);assert.equal(f.inflight.size, 0);assert.deepEqual(f.owner.observations(f.now()), []);
    assert.equal(fs.existsSync(path.join(f.paths.mcpIntents, `${request.intent.requestId}.json`)), true);
    await f.poll();
    assert.deepEqual(f.frames.map(decode).map(frame => frame.type), ["sessions.snapshot", "mcp.intent.register", "mcp.intent.register"]);
    assert.equal((decode(f.frames[1]).body as { requestId: string }).requestId, ordinary.requestId);
    assert.ok(isCodexActivityRegistration(decode(f.frames[2]).body));
  });
}


// Protocol-faithful local scheduling fixture, not a real Worker verdict.
// The separate workerd WS/SQL/SDK tests establish central admission and CAS.
async function ackDaemon(t: test.TestContext, phase: "digest" | "native" | "raw") {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"kherep-ordinary-ack-")),paths=nodePaths(root),home=path.join(root,"synthetic-native");metadata(home);
  fs.mkdirSync(paths.dir,{recursive:true});fs.writeFileSync(paths.policy,JSON.stringify({...policy,remoteMcp:{enabled:true,claudeCode:true}}));
  const identity=generateIdentity();writePrivateKey(paths.privateKey,identity);
  const original={socket:globalThis.WebSocket,interval:globalThis.setInterval,clear:globalThis.clearInterval,home:process.env.CODEX_HOME};process.env.CODEX_HOME=home;
  t.mock.method(os,"hostname",()=>"synthetic-node");t.mock.method(os,"platform",()=>"darwin");t.mock.method(os,"arch",()=>"arm64");t.mock.method(os,"cpus",()=>[]);t.mock.method(os,"totalmem",()=>1024);
  t.mock.method(globalThis,"fetch",async()=>new Response("synthetic absent",{status:404}));
  const listeners=new Map<string,(event:{data?:string;code?:number})=>void>();
  const callbacks=new Map<number,(()=>void)[]>(),frames:Envelope[]=[],remoteRows=new Map<string,SessionInfo>();
  let gateActive=false,entered=false,release!:()=>void,holdReplies=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),queuedReplies:(()=>void)[]=[];
  let captured:NodeClient|undefined;
  const arrivals:{requestId:string;at:number}[]=[];
  const enter=async()=>{entered=true;await gate;};
  const realDigest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,"digest",async(...args:Parameters<typeof crypto.subtle.digest>)=>{
    const result=await realDigest(...args);
    if(gateActive&&phase==="digest"&&new TextDecoder().decode(args[1] as Uint8Array)==='{"slot":"codex-mac"}')await enter();
    return result;
  });
  const onFrame=NodeClient.prototype.onFrame;
  t.mock.method(NodeClient.prototype,"onFrame",function(this:NodeClient,...args:Parameters<typeof onFrame>){
    if(!captured){
      captured=this;
      const options=(this as unknown as {options:ConstructorParameters<typeof NodeClient>[0]}).options;
      const native=options.assignmentIdentity??nativeMcpAssignment;
      options.assignmentIdentity=async(...nativeArgs)=>{const result=await native(...nativeArgs);if(gateActive&&phase==="native")await enter();return result;};
      const source=options.sessions;
      const wrapped=Object.assign(async(...sourceArgs:Parameters<typeof source>)=>{
        if(gateActive&&phase==="raw"&&sourceArgs[1])await enter();return source(...sourceArgs);
      },source);
      const raw=(source as typeof source & {raw?:(signal?:AbortSignal)=>Promise<SessionInfo[]>}).raw;
      if(raw)Object.assign(wrapped,{raw:async(signal?:AbortSignal)=>{if(gateActive&&phase==="raw")await enter();return raw(signal);}});
      options.sessions=wrapped;
    }
    return onFrame.apply(this,args);
  });
  const deliver=(body:{requestId:string;ok:true;expiresAt:number;version:number})=>{
    const run=()=>{arrivals.push({requestId:body.requestId,at:Date.now()});listeners.get("message")?.({data:JSON.stringify(makeEnvelope("mcp.intent.receipt",body,0,0))});};
    if(holdReplies)queuedReplies.push(run);else queueMicrotask(run);
  };
  class Socket{
    static OPEN=1;readyState=1;
    addEventListener(name:string,callback:(event:{data?:string;code?:number})=>void){listeners.set(name,callback);}
    send(raw:string){
      if(raw===PING_FRAME)return;const frame=decode(raw);frames.push(frame);
      if(frame.type==="mcp.credential.rotate")queueMicrotask(()=>listeners.get("message")?.({data:JSON.stringify(makeEnvelope("mcp.credential",{requestId:(frame.body as {requestId:string}).requestId,ok:true,token:"s".repeat(43),version:1},0,0))}));
      if(frame.type==="sessions.snapshot")for(const item of (frame.body as {sessions:SessionInfo[]}).sessions)remoteRows.set(item.sessionId,item);
      if(frame.type==="mcp.intent.register"){
        if(isCodexActivityRegistration(frame.body))deliver({requestId:frame.body.intent.requestId,ok:true,expiresAt:frame.body.observedAt+60000,version:1});
        else{
          const body=frame.body as {requestId:string;sessionId:string;runtime:string};const actor=remoteRows.get(body.sessionId);
          assert.ok(actor&&actor.runtime===body.runtime&&actor.state!=="unknown","ordinary decision requires independently observed eligible caller");
          deliver({requestId:body.requestId,ok:true,expiresAt:Date.now()+120000,version:1});
        }
      }
    }
    close(code=1000){this.readyState=3;listeners.get("close")?.({code});}
  }
  Object.defineProperty(globalThis,"WebSocket",{configurable:true,writable:true,value:Socket});
  globalThis.setInterval=((callback:()=>void,ms:number)=>{callbacks.set(ms,[...callbacks.get(ms)??[],callback]);return{interval:ms};}) as unknown as typeof setInterval;
  globalThis.clearInterval=(()=>{}) as typeof clearInterval;
  const C="77777777-7777-4777-8777-777777777777",D="88888888-8888-4888-8888-888888888888";
  let ordinaryRuntime:"codex"|"claude-code"="codex",includeNew=false;
  const rows=()=>[row(),row(B),{sessionId:D,runtime:"codex",kind:"codex",state:"unknown",title:"Synthetic cached ordinary"},...(includeNew?[{sessionId:C,runtime:ordinaryRuntime,kind:ordinaryRuntime==="codex"?"codex":"interactive",state:"unknown",title:"Synthetic new ordinary"}]:[])];
  const config={version:1 as const,controlUrl:"https://control.example.invalid",nodeId:"00000000-0000-4000-8000-0000000000aa",name:"synthetic",publicKey:identity.publicKey,privateKeyFile:paths.privateKey,policyFile:paths.policy,enrolledAt:new Date(0).toISOString()};
  const handle=startDaemon(config,paths,()=>{},async()=>rows(),async()=>({ok:true}),undefined,{}, {fallbackMs:2000000},{observe:()=>{
    const at=Date.now();return{status:"value",observedAt:at,complete:true,source:"native-app",reasonCode:"observed",value:[
      ...([{sessionId:D,runtime:"codex"},{sessionId:C,runtime:"codex"},{sessionId:C,runtime:"claude-code"}]).map(({sessionId,runtime})=>({sessionId,runtime,holder:{status:"value" as const,value:{present:true,creationIdentity:"synthetic-holder"},source:"native-holder" as const,observedAt:at,complete:true,reasonCode:"observed" as const},turn:{status:"value" as const,value:"running" as const,source:"native-turn" as const,observedAt:at,complete:true,reasonCode:"observed" as const}})),
    ]};
  }});
  t.after(async()=>{release();handle.stop();await handle.done;Object.defineProperty(globalThis,"WebSocket",{configurable:true,writable:true,value:original.socket});globalThis.setInterval=original.interval;globalThis.clearInterval=original.clear;if(original.home===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=original.home;fs.rmSync(root,{recursive:true,force:true});});
  listeners.get("open")?.({});listeners.get("message")?.({data:JSON.stringify(makeEnvelope("event",{name:"auth.ok"},0,0))});
  await waitFor(()=>frames.some(frame=>frame.type==="sessions.snapshot")&&fs.existsSync(paths.mcpCredential));
  const tick=()=>callbacks.get(EXCHANGE_INTERVAL_MS)![0]();
  const hook=(sessionId:string,runtime:"codex"|"claude-code"="codex",assignment=false)=>processMcpIntentHook({hook_event_name:"PreToolUse",session_id:sessionId,turn_id:crypto.randomUUID(),tool_use_id:crypto.randomUUID(),tool_name:`mcp__kherep_messaging__${assignment?"assign_self":"status"}`,tool_input:assignment?{slot:"codex-mac"}:{messageId:crypto.randomUUID()}},root,Date.now(),runtime);
  return{root,paths,frames,arrivals,tick,hook,release,entered:()=>entered,activate:()=>{gateActive=true;},client:()=>captured!,cached:D,newCaller:C,
    newOrdinary:(runtime:"codex"|"claude-code")=>{ordinaryRuntime=runtime;includeNew=true;},holdReplies:()=>{holdReplies=true;},flushReplies:()=>{holdReplies=false;for(const reply of queuedReplies.splice(0))reply();}};
}

for(const phase of ["digest","native","raw"] as const)test(`production daemon consumes ordinary hook ACK while stamped ${phase} remains gated`,async t=>{
  if(process.platform!=="darwin"){t.skip("production Mac reader fixture; portable Worker controls remain separate");return;}
  const f=await ackDaemon(t,phase);
  const stampHook=f.hook(A,"codex",true);
  const ordinaryHook=f.hook(f.cached);
  await waitFor(()=>fs.existsSync(f.paths.mcpIntents)&&fs.readdirSync(f.paths.mcpIntents).filter(name=>name.endsWith(".json")).length===2);
  f.activate();f.tick();await waitFor(f.entered);await waitFor(()=>f.arrivals.length>0);
  let ordinaryOutput:Awaited<typeof ordinaryHook>|null=null;
  try{
    ordinaryOutput=await Promise.race([ordinaryHook,new Promise<null>(resolve=>setTimeout(()=>resolve(null),300))]);
    assert.ok(ordinaryOutput?.hookSpecificOutput.updatedInput,"actual ordinary hook ACK must be consumed while stamp is still gated");
    const id=ordinaryOutput.hookSpecificOutput.updatedInput.requestId;
    assert.ok(f.arrivals.some(receipt=>receipt.requestId===id));
    assert.equal(fs.existsSync(path.join(f.paths.mcpReceipts,`${id}.json`)),false,"real hook consumes its one-use receipt");
  }finally{f.release();await ordinaryHook;await stampHook;}
});


for(const scenario of ["delayed-reply","new-codex","new-claude"] as const)test(`production daemon ACK progresses for ${scenario} during an existing stamp`,async t=>{
  if(process.platform!=="darwin"){t.skip("production Mac reader fixture; portable Worker controls remain separate");return;}
  const f=await ackDaemon(t,"native");const stampHook=f.hook(A,"codex",true);
  await waitFor(()=>fs.existsSync(f.paths.mcpIntents)&&fs.readdirSync(f.paths.mcpIntents).some(name=>name.endsWith(".json")));
  f.activate();f.tick();await waitFor(f.entered);
  const runtime=scenario==="new-claude"?"claude-code":"codex";
  if(scenario!=="delayed-reply")f.newOrdinary(runtime);else f.holdReplies();
  const ordinaryHook=f.hook(scenario==="delayed-reply"?f.cached:f.newCaller,runtime);
  await waitFor(()=>fs.readdirSync(f.paths.mcpIntents).filter(name=>name.endsWith(".json")).length===2);
  f.tick();
  if(scenario==="delayed-reply"){
    await waitFor(()=>f.frames.some(frame=>frame.type==="mcp.intent.register"&&!isCodexActivityRegistration(frame.body)));
    f.tick();f.flushReplies();
  }
  try{
    const output=await Promise.race([ordinaryHook,new Promise<null>(resolve=>setTimeout(()=>resolve(null),500))]);
    assert.ok(output?.hookSpecificOutput.updatedInput,"genuine ordinary ACK is consumed during the old stamp wait");
    const id=output.hookSpecificOutput.updatedInput.requestId;assert.ok(f.arrivals.some(receipt=>receipt.requestId===id));
    assert.equal(fs.existsSync(path.join(f.paths.mcpReceipts,`${id}.json`)),false);
  }finally{f.release();await ordinaryHook;await stampHook;}
});

test("healthy repeated ordinary cohorts ACK and a reserved stamp still progresses once",async t=>{
  if(process.platform!=="darwin"){t.skip("production Mac reader fixture; portable Worker controls remain separate");return;}
  const f=await ackDaemon(t,"native"),stampHook=f.hook(A,"codex",true);
  await waitFor(()=>fs.existsSync(f.paths.mcpIntents)&&fs.readdirSync(f.paths.mcpIntents).some(name=>name.endsWith(".json")));f.activate();f.tick();await waitFor(f.entered);
  try{
    for(let i=0;i<2;i++){
      const ordinary=f.hook(f.cached);await waitFor(()=>fs.readdirSync(f.paths.mcpIntents).filter(name=>name.endsWith(".json")).length===2);f.tick();
      const output=await Promise.race([ordinary,new Promise<null>(resolve=>setTimeout(()=>resolve(null),500))]);assert.ok(output?.hookSpecificOutput.updatedInput);
    }
  }finally{f.release();}
  const output=await stampHook;assert.ok(output?.hookSpecificOutput.updatedInput);
  const registrations=f.frames.filter(frame=>frame.type==="mcp.intent.register"&&isCodexActivityRegistration(frame.body));assert.equal(registrations.length,1);
  assert.equal((registrations[0].body as CodexActivityRegistration).intent.requestId,output.hookSpecificOutput.updatedInput.requestId);
  assert.equal((f.client() as unknown as {options:{codexActivity:CodexActivity}}).options.codexActivity.observations(Date.now()).length,1);
});

test("ordinary ACK completes before a held stamp expires without registration or confirmation",async t=>{
  if(process.platform!=="darwin"){t.skip("production Mac reader fixture; portable Worker controls remain separate");return;}
  const f=await ackDaemon(t,"native"),stampHook=f.hook(A,"codex",true);
  await waitFor(()=>fs.existsSync(f.paths.mcpIntents)&&fs.readdirSync(f.paths.mcpIntents).some(name=>name.endsWith(".json")));
  const file=fs.readdirSync(f.paths.mcpIntents).find(name=>name.endsWith(".json"))!;
  const stamp=JSON.parse(fs.readFileSync(path.join(f.paths.mcpIntents,file),"utf8")) as CodexActivityStamp;
  f.activate();f.tick();await waitFor(f.entered);
  const ordinary=f.hook(f.cached);await waitFor(()=>fs.readdirSync(f.paths.mcpIntents).filter(name=>name.endsWith(".json")).length===2);f.tick();
  const output=await ordinary;assert.ok(output?.hookSpecificOutput.updatedInput);
  t.mock.method(Date,"now",()=>stamp.observedAt+8000);f.release();const denied=await stampHook;
  assert.equal(denied?.hookSpecificOutput.updatedInput,undefined);
  assert.equal(f.frames.filter(frame=>frame.type==="mcp.intent.register"&&isCodexActivityRegistration(frame.body)).length,0);
  assert.equal((f.client() as unknown as {options:{codexActivity:CodexActivity}}).options.codexActivity.observations(Date.now()).length,0);
});

test("reservation before native proof cannot contribute or confirm an observation",async()=>{
  const owner=new CodexActivity();owner.connect(100);const value=await stamp(101);assert.ok(owner.reserve(value,101));
  assert.deepEqual(owner.observations(101),[]);assert.equal(owner.confirm(value,101),false);
  assert.throws(()=>owner.observations(101,value));assert.ok(owner.stage(value,101));assert.deepEqual(owner.observations(101),[]);
  assert.ok(owner.confirm(value,101));assert.equal(owner.observations(101).length,1);
});


test("partial ordinary output retains only sent inflight IDs and retries unsent work before one stamp",async t=>{
  const f=await fixture(t),request=await f.request();
  const first={...request.intent,requestId:"10000000-0000-4000-8000-000000000001",tool:"status" as const,assignment:undefined};
  const second={...first,requestId:"20000000-0000-4000-8000-000000000002",callId:"synthetic-partial"};
  enqueueMcpIntent(f.paths,first);enqueueMcpIntent(f.paths,second);enqueueMcpIntent(f.paths,request);
  const sent:string[]=[];let count=0;await f.poll(frame=>{
    if(++count!==1)return false;
    sent.push((decode(frame).body as {requestId:string}).requestId);return true;
  });
  assert.equal(sent.length,1);assert.ok([first.requestId,second.requestId].includes(sent[0]));
  assert.deepEqual([...f.inflight],sent);assert.equal(f.nativeReads(),0);
  const unsent=[first,second].find(body=>body.requestId!==sent[0])!;
  assert.ok(fs.existsSync(path.join(f.paths.mcpIntents,`${unsent.requestId}.json`)));
  await f.poll();assert.equal(f.inflight.has(unsent.requestId),true);
  assert.equal(f.frames.filter(raw=>isCodexActivityRegistration(decode(raw).body)).length,1);
});
