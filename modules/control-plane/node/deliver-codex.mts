import {requireMessageEffect} from './message-admission.mts';
import { selectRouteMembers } from "./target-delivery-route.mts";
import { decideMessageRoute } from "./target-delivery-producer.mts";
import { beginRouteEffect } from "./target-delivery-route.mts";
import { finishRouteEffect } from "./target-delivery-outcome.mts";
import { readPolicy } from "./policy.mts";
import { audit, bypassesPermissions } from "./autonomy.mts";
import fs from "node:fs";

import { mayContinue } from "./autonomy.mts";
import { CODEX_FORK_ENV, consumeBusyHint } from "./codex-busy-consume.mts";
import { codexSessionRefs, isCodexSessionId, markStopEnded, recordCodexSession } from "./codex-sessions.mts";
import {
  contextOutput, deliveryContext, sessionInbox, type HookDeps,
} from "./deliver-core.mts";
import { nodeWakeBudget } from "./policy.mts";
import { hookCommand } from "./session-command.mts";

// The delivery hook under Codex (issue #31, step 4), started with
// --runtime codex. Contract, from https://learn.chatgpt.com/docs/hooks.md
// (fetched 2026-09-25):
// - Input: JSON on stdin with session_id, cwd and hook_event_name ("Common
//   input fields"); Stop adds stop_hook_active, "Whether this turn was already
//   continued by Stop" ("Stop").
// - SessionStart and UserPromptSubmit: hookSpecificOutput.additionalContext
//   "is added as extra developer context" ("SessionStart", "UserPromptSubmit").
// - Stop "expects JSON on stdout when it exits 0. Plain text output is
//   invalid"; decision "block" makes Codex continue with "a new continuation
//   prompt that acts as a new user prompt, using your reason as that prompt
//   text" ("Stop"). The reason is therefore a fixed text and never peer
//   content. The Codex desktop app shows a Stop block as "Blocked · Stop ·
//   User · Feedback" with the reason beneath it, so the first reason line
//   names Kherep delivery (issue #359). Stop continuations do not fire
//   UserPromptSubmit: they retrieve the framed peer context through msg inbox
//   --receive. "Exit 0 with no output is treated as success" ("Common output
//   fields").
// - Model-visible hook output above roughly 2,500 tokens is spilled to a file
//   with a head-and-tail preview ("Large hook output"). Message text, ids and
//   paths tokenize at about 2.5 to 4 bytes per token, so 6 KB stays under that
//   limit where Claude's 8 KB could cross it.
// - No documented environment variable carries the session id (CODEX_THREAD_ID
//   is source-defined, issue #471), so the reply command still passes --from.
// - The msg command writes into the node's outbox, which the Codex desktop
//   app's sandbox does not make writable (measured 2026-09-27, issue #72). The
//   installed prefix rule (codex/lib/control-plane-rules.mts) runs it outside
//   the sandbox without asking, but only for an escalation request, so the
//   context says to request escalation right away instead of failing first.

export const CODEX_CONTEXT_BYTES = 6 * 1024;
export { CODEX_FORK_ENV };
export const CODEX_STOP_MARKER = "Kherep message delivery (not an error):";
export const CODEX_STOP_REASON = "Kherep: New peer messages are waiting. Check this session's inbox and report any relevant update.";
export const CODEX_ESCALATION_NOTE = "Run the msg command on its own, not in a pipeline or script, and request escalated "
  + "permissions (sandbox_permissions \"require_escalated\") on the first attempt: it writes outside the sandbox, and the "
  + "Kherep launcher rule approves msg send, sessions, inbox and status without asking the user.";

// The hook's stdout for one Codex input: empty when there is nothing to say.
// On a machine without an enrolled node it writes nothing at all.
// Inside a fork helper (KHEREP_CODEX_FORK=1, issue #408) it writes and records nothing.
export function deliverForCodex(input: unknown, deps: HookDeps): string {
  if (process.env[CODEX_FORK_ENV] === "1") return "";
  if (typeof input !== "object" || input === null) return "";
  const { hook_event_name: event, session_id: sessionId, cwd, stop_hook_active: continued, permission_mode: mode } = input as Record<string, unknown>;
  if (event === "PostToolUse") return consumeBusyHint(input, deps);
  if (event !== "SessionStart" && event !== "UserPromptSubmit" && event !== "Stop") return "";
  if (!isCodexSessionId(sessionId) || !fs.existsSync(deps.paths.config)) return "";
  // The event is idle evidence (issue #408).
  recordCodexSession(deps.paths, sessionId, cwd, deps.now?.(), mode, event);
  // Only names no other live Codex session shares (issue #66).
  const refs = codexSessionRefs(deps.paths, sessionId, deps.now?.()).refs;
  if (event === "SessionStart" || event === "UserPromptSubmit") {
    const cli = deps.replyCommand ?? hookCommand(deps.paths);
    const receiveRecipe = `When Kherep reports waiting peer messages, run \`${cli} msg inbox --from ${sessionId} --receive\`, then report any `
      + `relevant peer update with attribution without echoing these transport instructions. After processing complete output, perform its exact receipt ACK yourself. If output is truncated, do not ACK; use its exact single-message receive recipe. ${CODEX_ESCALATION_NOTE}`;
    if (event === "SessionStart") {
      return contextOutput(event, `Kherep messaging: this session's id is ${sessionId}. To message another session: `
        + `${cli} msg send --from ${sessionId} <node>/<session> -- <text>. \`${cli} msg sessions\` lists sessions. `
        + receiveRecipe);
    }
    const maxBytes = CODEX_CONTEXT_BYTES - Buffer.byteLength(receiveRecipe) - 1;
    const context = deliveryContext(event, refs, { maxBytes, ...deps, replyCommand: cli, replyFrom: sessionId, offeredBy: "codex-prompt", codexOwner: sessionId, owner: { sessionId, runtime: "codex" } });
    return contextOutput(event, context ? `${context}\n${receiveRecipe}` : receiveRecipe);
  }
  const mine = sessionInbox(deps.paths, refs, { sessionId, runtime: "codex" });
  const arrived = mine.filter((r) => r.state === "accepted").map((r) => r.messageId);
  if (continued === true || arrived.length === 0) return stopEnded(deps, sessionId);
  // A continuation is an autonomous turn: the same budget and bypass check as
  // the Claude Stop path (autonomy.mts).
  if(bypassesPermissions(mode)){audit(deps.paths,deps.now?.()??Date.now(),sessionId,arrived,"continue-permission-mode");return stopEnded(deps,sessionId);}
  const policy=readPolicy(deps.paths.policy,true);
  if(!policy){audit(deps.paths,deps.now?.()??Date.now(),sessionId,arrived,"awaiting-user-turn");return stopEnded(deps,sessionId);}
  let context;
  try {
    const selected=selectRouteMembers(mine.filter(r=>arrived.includes(r.messageId))).slice(0,8);
    const result=decideMessageRoute({...deps,policy,messageRoute:{route:'codex-stop',grant:'stop',permissionMode:typeof mode==='string'?mode:undefined}},selected,sessionId,"hook-continue",{runtime:"codex",sessionId,taskId:null},deps.messageProducer??null);
    audit(deps.paths,deps.now?.()??Date.now(),sessionId,selected.map(r=>r.messageId),result.status==="granted"?"continue":result.status==="denied-no-debit"?"continue-budget":"awaiting-user-turn");
    context=result.status==="granted"?result.context:null;
    if(!context)return stopEnded(deps,sessionId);
    beginRouteEffect(deps.paths,context,["hook-continue"]);
    requireMessageEffect(deps,context,'continuation-output');
    finishRouteEffect(deps.paths,context,{kind:'hook',emitted:true});
  } catch {return stopEnded(deps,sessionId);}
  // The turn goes on: the record stays a Stop not marked as ended, never idle (issue #408).
  const output=JSON.stringify({decision:'block',reason:CODEX_STOP_REASON});
  deps.onContinuation?.(context!);
  try{requireMessageEffect(deps,context!,'continuation-output');}catch{return stopEnded(deps,sessionId);}
  return output;
}

// A Stop that returns no continuation ended its turn, the only idle evidence
// (issue #408). A failed write leaves the record not idle and the output empty.
function stopEnded(deps: HookDeps, sessionId: string): "" {
  try {
    markStopEnded(deps.paths, sessionId);
  } catch {
    // the record stays a Stop not marked as ended
  }
  return "";
}
