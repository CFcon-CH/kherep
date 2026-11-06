import os from "node:os";
import path from "node:path";

const COMPLETION = /\b(done|finished|complete(?:d)?|fertig|erledigt|abgeschlossen)\b/i;
const RECEIPT = /\bC1\b[\s\S]*\bC2\b[\s\S]*\bC3\b[\s\S]*\bC4\b/i;

export interface StopInput {
  last_assistant_message?: unknown;
  assistant_message?: unknown;
  cwd?: unknown;
}

export interface StopDecision {
  continue: false;
  stopReason: string;
  systemMessage: string;
}

function normalize(value: unknown): string {
  return String(value || "").replace(/\\/g, "/").replace(/(?<!\/)\/+$/, "").toLowerCase();
}

export function decision(input: StopInput, env: NodeJS.ProcessEnv = process.env): StopDecision | null {
  const message = String(input.last_assistant_message || input.assistant_message || "");
  if (!message || !COMPLETION.test(message) || RECEIPT.test(message)) return null;
  const cwd = normalize(input.cwd);
  const configuredValue = Object.hasOwn(env, "KHEREP_WORKSPACE") ? env.KHEREP_WORKSPACE : undefined;
  const workspace = normalize(configuredValue === undefined
    ? path.join(env.USERPROFILE || env.HOME || os.homedir(), "Kherep")
    : configuredValue);
  if (!workspace || (cwd !== workspace && !cwd.startsWith(`${workspace}/`))) return null;
  const reason = "Completion claim blocked: provide the Kherep C1-C4 acceptance receipt first.";
  return { continue: false, stopReason: reason, systemMessage: reason };
}
