import { observationReason, validIdentity, type SessionEvidence } from "./session-liveness.mts";
import type { LivenessSnapshot } from "./session-lifecycle.mts";
import { currentIdentity, fullSessionId } from "../protocol-session-identity.mts";
import type { SessionInfo } from "../protocol.mts";
import { LABEL_FRESH_MS, type IdentityVeto, type NameBinding } from "./wake-bindings.mts";

// Identity vetoes of the label state (moved from session-labels.mts, issue #828):
// deny-only facts from the accepted lifecycle publication and listing contradictions.
export interface LabelIdentityObservation {
    snapshot: LivenessSnapshot;
    listed: SessionInfo[];
    evidence:SessionEvidence[];
}
export function identityVetoes(state:{identityVetoes:IdentityVeto[];bindings:NameBinding[]}, rows:SessionInfo[], source:LabelIdentityObservation, now:number, allowClear:boolean):IdentityVeto[] {
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
