import { observationReason, validIdentity, type SessionEvidence } from "./session-liveness.mts";
import type { LivenessSnapshot } from "./session-lifecycle.mts";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { currentIdentity, fullSessionId, natural } from "../protocol-session-identity.mts";
import type { SessionInfo } from "../protocol.mts";
import { ensureDir, readConfig, type NodePaths } from "./config.mts";
import { readJson, writeJsonAtomic } from "./inbox.mts";
import { readPolicy } from "./policy.mts";
import { LABEL_FRESH_MS, type BindingView, type LabelRow, type NameBinding, type IdentityVeto } from "./wake-bindings.mts";
export interface LabelState {
    schemaVersion: 1;
    scope: string;
    epoch: string;
    version: number;
    bindings: NameBinding[];
    identityVetoes: IdentityVeto[];
    knownTokens: string[];
    local: LabelRow[];
    observedAt: number;
    complete: boolean;
    ambiguousNames: string[];
    localGeneration: number;
    identityGeneration:number;
}
const loaded = new Set<string>();
const MAX_BYTES = 512 * 1024, MAX_ROWS = 2048, MAX_BINDINGS = 512;
export const labelsFile = (p: NodePaths): string => path.join(p.dir, "session-labels.json");
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
export function policyScope(p: NodePaths): string { const c = readConfig(p.config); return hash(JSON.stringify([c?.nodeId ?? "local", path.resolve(c?.policyFile ?? p.policy)])); }
const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(s);
const label = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 128;
const time = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const row = (v: LabelRow): boolean => !!v && text(v.nodeId) && text(v.runtime) && fullSessionId(v.sessionId) && label(v.name) && time(v.observedAt) && natural(v.lifecycleGeneration) && natural(v.revision) && (v.current === undefined || typeof v.current === "boolean");
export function validLabelState(v: unknown): v is LabelState {
    if (!v || typeof v !== "object")
        return false;
    const s = v as LabelState;
    return s.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(s.scope) && fullSessionId(s.epoch) && natural(s.version) && s.version > 0
        && natural(s.localGeneration) && natural(s.identityGeneration) && Array.isArray(s.ambiguousNames) && s.ambiguousNames.length <= MAX_ROWS && s.ambiguousNames.every(text) && time(s.observedAt) && typeof s.complete === "boolean"
        && Array.isArray(s.knownTokens) && s.knownTokens.length <= MAX_BINDINGS && s.knownTokens.every(text) && new Set(s.knownTokens).size === s.knownTokens.length
        && Array.isArray(s.identityVetoes) && s.identityVetoes.length <= MAX_ROWS && s.identityVetoes.every(v => v && text(v.runtime) && fullSessionId(v.sessionId) && ["conflict", "terminal"].includes(v.kind) && natural(v.sourceGeneration) && v.sourceGeneration <= s.identityGeneration && time(v.observedAt) && natural(v.lifecycleGeneration))
        && new Set(s.identityVetoes.map(v => `${v.runtime}/${v.sessionId}`)).size === s.identityVetoes.length
        && Array.isArray(s.bindings) && s.bindings.length <= MAX_BINDINGS && s.bindings.every(b => b && text(b.token) && b.token !== "*" && !fullSessionId(b.token) && text(b.runtime) && fullSessionId(b.sessionId) && text(b.firstName) && time(b.boundAt) && natural(b.sourceGeneration) && b.provenance === "policy-co-list")
        && new Set(s.bindings.map(b => b.token)).size === s.bindings.length
        && Array.isArray(s.local) && s.local.length <= MAX_ROWS && s.local.every(row) && new Set(s.local.map(r => JSON.stringify([r.nodeId, r.runtime, r.sessionId]))).size === s.local.length;
}
export function readLabelState(p: NodePaths): LabelState | null {
    try {
        const f = labelsFile(p);
        if (fs.statSync(f).size > MAX_BYTES)
            return null;
        const s: unknown = JSON.parse(fs.readFileSync(f, "utf8"));
        const witness = readJson<{
            labelBindingEpoch?: unknown;
        }>(p.sessions)?.labelBindingEpoch;
        if (validLabelState(s) && s.scope === policyScope(p) && witness === s.epoch) {
            loaded.add(p.dir);
            return s;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function readBindingView(p: NodePaths, now = Date.now()): BindingView {
    const s = readLabelState(p);
    if (s)
        return { status: "healthy", version: s.version, bindings: s.bindings, local: s.local, complete: s.complete, observedAt: s.observedAt, ambiguousNames: s.ambiguousNames, identityVetoes: s.identityVetoes };
    // No dynamic fallback from unreadable, absent, mismatched or half-initialized history.
    return { status: "history-unavailable", version: 0, bindings: [], local: [], complete: false, observedAt: now };
}
export function policyStamp(p: NodePaths): string | null {
    try {
        return hash(fs.readFileSync(readConfig(p.config)?.policyFile ?? p.policy, "utf8"));
    }
    catch {
        return null;
    }
}
function initialize(p: NodePaths): LabelState | null {
    if (fs.existsSync(labelsFile(p)))
        return readLabelState(p);
    if (loaded.has(p.dir))
        return null;
    const projection = readJson<Record<string, unknown>>(p.sessions);
    if (projection?.labelBindingEpoch !== undefined)
        return null;
    // Unreadable existing projection is uncertain history, not a fresh installation.
    if (fs.existsSync(p.sessions) && !projection)
        return null;
    const epoch = randomUUID();
    ensureDir(p.dir);
    writeJsonAtomic(p.sessions, { ...projection, labelBindingEpoch: epoch }); // witness first, so any failed next write is detectable
    return { schemaVersion: 1, scope: policyScope(p), epoch, version: 1, bindings: [], identityVetoes: [], knownTokens: [], local: [], observedAt: 0, complete: false, ambiguousNames: [], localGeneration: 0, identityGeneration:0 };
}
function save(p: NodePaths, s: LabelState): void {
    s.version++;
    if (!validLabelState(s) || Buffer.byteLength(JSON.stringify(s)) > MAX_BYTES)
        throw new Error("label-state-bound");
    writeJsonAtomic(labelsFile(p), s);
    loaded.add(p.dir);
}
export interface LabelIdentityObservation {
    snapshot: LivenessSnapshot;
    listed: SessionInfo[];
    evidence:SessionEvidence[];
}
function identityVetoes(state:LabelState, rows:SessionInfo[], source:LabelIdentityObservation, now:number, allowClear:boolean):IdentityVeto[] {
    const {snapshot,listed,evidence}=source;
    const key=(v:{runtime:string;sessionId:string})=>`${v.runtime}/${v.sessionId}`;
    const retained=state.identityVetoes.filter(v=>{
        if(!allowClear) return true;
        const population=listed.filter(r=>r.sessionId===v.sessionId);
        const proof=rows.find(r=>r.sessionId===v.sessionId && r.runtime===v.runtime)?.canonicalIdentity;
        const restored=snapshot.tombstones.find(t=>key(t)===key(v) && t.state==="restored"
            && t.generation>v.lifecycleGeneration && t.observedAt>=v.observedAt);
        const advances=proof && (proof.observedAt>v.observedAt || restored && proof.observedAt>=restored.observedAt
            && proof.lifecycleGeneration>=restored.generation);
        return !(snapshot.generation>v.sourceGeneration && population.length===1 && population[0].runtime===v.runtime
            && currentIdentity(proof,v,now) && now-proof.observedAt<=LABEL_FRESH_MS
            && advances && proof.lifecycleGeneration>=v.lifecycleGeneration);
    });
    const vetoes=new Map(retained.map(v=>[key(v),v]));
    const put=(target:{runtime:string;sessionId:string},kind:IdentityVeto["kind"],observedAt:number,lifecycleGeneration=0)=>{
        if(!fullSessionId(target.sessionId) || !validIdentity(target)) return;
        const prior=vetoes.get(key(target));
        const accepted=snapshot.tombstones.find(t=>key(t)===key(target));
        const verdict=snapshot.sessions.find(v=>key(v)===key(target));
        vetoes.set(key(target),{runtime:target.runtime,sessionId:target.sessionId,
            kind:prior?.kind==="terminal"?"terminal":kind, sourceGeneration:snapshot.generation,
            observedAt:Math.max(prior?.observedAt??0,observedAt),
            lifecycleGeneration:Math.max(prior?.lifecycleGeneration??0,lifecycleGeneration,accepted?.generation??0,verdict?.lifecycleGeneration??0)});
    };
    // Terminal facts come from the accepted lifecycle publication, never a label
    // or an overloaded UNKNOWN availability reason code.
    for(const verdict of snapshot.sessions) if(["closed","archived","deleted"].includes(verdict.state))
        put(verdict,"terminal",verdict.observedAt,verdict.lifecycleGeneration??0);
    for(const terminal of snapshot.tombstones) if(terminal.state!=="restored") put(terminal,"terminal",terminal.observedAt,terminal.generation);
    for(const target of listed) if(listed.filter(r=>r.sessionId===target.sessionId).length>1) put(target,"conflict",now);
    for(const binding of state.bindings) {
        const population=listed.filter(r=>r.sessionId===binding.sessionId);
        if(population.length>1 || population.some(r=>r.runtime!==binding.runtime)) put(binding,"conflict",now);
    }
    for(const target of evidence) {
        if(!validIdentity(target)) continue;
        if(evidence.filter(e=>validIdentity(e) && key(e)===key(target)).length>1) put(target,"conflict",now);
        const event=target.lifecycle, accepted=snapshot.tombstones.find(t=>key(t)===key(target));
        const verdict=snapshot.sessions.find(v=>key(v)===key(target));
        if(accepted && verdict?.reasonCode==="conflict" && event?.status==="value" && event.source==="native-lifecycle"
            && observationReason(event,now)===null && event.value.generation>=accepted.generation
            && (event.value.state!==accepted.state || event.value.generation!==accepted.generation || event.observedAt<accepted.observedAt))
            put(target,"conflict",Math.max(event.observedAt,accepted.observedAt),accepted.generation);
    }
    return [...vetoes.values()];
}
export function recordLocalLabels(p:NodePaths, rows:SessionInfo[], now:number, complete:boolean, stamp:string|null, generation?:number, identity?:LabelIdentityObservation):void {
    const established=fs.existsSync(labelsFile(p));
    let base=readLabelState(p);
    const freshPolicy=stamp!==null && policyStamp(p)===stamp;
    const policy=freshPolicy?readPolicy(readConfig(p.config)?.policyFile??p.policy,true):null;
    if(!base) {
        if(!complete || !policy) return;
        base=initialize(p);
    }
    if(!base || now<base.observedAt || rows.length>MAX_ROWS || generation!==undefined && generation<base.localGeneration) return;
    const identityState=structuredClone(base);
    if(identity) {
        if(generation===undefined || identity.snapshot.generation!==generation || generation<=base.identityGeneration) return;
        identityState.identityVetoes=identityVetoes(base,rows,identity,now,complete);
        identityState.identityGeneration=generation;
    }
    if(!complete) identityState.complete=false;
    const commit=(next:LabelState):void=>{
        const current=readLabelState(p);
        if(established ? !current || current.version!==base!.version || current.epoch!==base!.epoch : fs.existsSync(labelsFile(p))) return;
        if(policyScope(p)!==base!.scope) return;
        save(p,next);
    };
    const commitIdentity=():void=>{
        if(identityState.complete!==base!.complete || identityState.identityGeneration!==base!.identityGeneration
            || JSON.stringify(identityState.identityVetoes)!==JSON.stringify(base!.identityVetoes)) commit(identityState);
    };
    // Received contradictions are deny-only facts even when a policy read races.
    // Partial populations can add/retain vetoes, never clear or bind.
    if(!complete || !policy) { commitIdentity(); return; }
    const s=structuredClone(identityState);
    const tokens = [...new Set(policy.wake?.sessions ?? [])];
    const knownTokens = [...new Set([...s.knownTokens, ...tokens])];
    if (tokens.length > MAX_BINDINGS || knownTokens.length > MAX_BINDINGS) { commitIdentity(); return; }
    s.knownTokens = knownTokens;
    const nodeId = readConfig(p.config)?.nodeId ?? "local";
    const eligible = rows.filter(r => !s.identityVetoes.some(v => v.runtime === r.runtime && v.sessionId === r.sessionId) && r.runtime === "claude-code" && fullSessionId(r.sessionId) && label(r.name) && rows.filter(v => v.sessionId === r.sessionId).length === 1
        && currentIdentity(r.canonicalIdentity, r, now) && now - r.canonicalIdentity!.observedAt <= LABEL_FRESH_MS && !["closed", "deleted", "archived"].includes(r.state));
    const local: LabelRow[] = eligible.map(r => {
        const old = s.local.find(v => v.sessionId === r.sessionId && v.runtime === r.runtime);
        if (old && (r.canonicalIdentity!.observedAt < old.observedAt || r.canonicalIdentity!.lifecycleGeneration < old.lifecycleGeneration || r.name !== old.name && r.canonicalIdentity!.observedAt === old.observedAt))
            return { ...old, current: false };
        return { nodeId, current: true, runtime: r.runtime, sessionId: r.sessionId, name: r.name!, observedAt: r.canonicalIdentity!.observedAt, lifecycleGeneration: r.canonicalIdentity!.lifecycleGeneration, revision: (old?.revision ?? 0) + (old?.name === r.name ? 0 : 1) };
    });
    for (const token of new Set(policy.wake?.sessions ?? [])) {
        if (token === "*" || fullSessionId(token) || s.bindings.some(b => b.token === token) || s.bindings.length >= MAX_BINDINGS)
            continue;
        const holder = local.filter(r => r.name === token && r.current !== false);
        if (holder.length === 1 && rows.filter(r => r.name === token).length === 1 && policy.wake?.sessions.includes(holder[0].sessionId) && !rows.some(r => r.sessionId === token))
            s.bindings.push({ token, runtime: holder[0].runtime, sessionId: holder[0].sessionId, firstName: token, boundAt: now, sourceGeneration: generation ?? s.version, provenance: "policy-co-list" });
    }
    for (const old of s.local)
        if (!local.some(r => r.sessionId === old.sessionId && r.runtime === old.runtime))
            local.push({ ...old, current: false });
    s.local = local;
    s.ambiguousNames = [...new Set(rows.filter(r => text(r.name) && rows.filter(v => v.name === r.name).length > 1).map(r => r.name!))];
    s.localGeneration = generation ?? s.version;
    s.observedAt = now;
    s.complete = true;
    if(policyStamp(p)!==stamp) { commitIdentity(); return; }
    commit(s);
}
