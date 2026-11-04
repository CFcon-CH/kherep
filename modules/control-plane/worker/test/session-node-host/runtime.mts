import fs from "node:fs";
import path from "node:path";
import { NodeClient } from "../../../node/client.mts";
import { nodePaths, writeConfig } from "../../../node/config.mts";
import { exchangeOptions, pollExchange, recordingSessions, readDirectory, getSent } from "../../../node/exchange.mts";
import { generateIdentity } from "../../../node/identity.mts";
import { storeMessage, getMessage, getReceipt } from "../../../node/inbox.mts";
import { runMsgArgs } from "../../../node/msg-cli.mts";
import { DEFAULT_POLICY } from "../../../node/policy.mts";
import { deliverForCodex } from "../../../node/deliver-codex.mts";
import { deliverForHook } from "../../../node/deliver-hook.mts";
import { syntheticHookFacts } from "../../../node/target-delivery-test-support.mts";
import type { SessionInfo } from "../../../protocol.mts";
import { SESSION_B, type ChildCommand, type Role, type Runtime } from "../session-node-protocol.mts";
const FACTS = { hostname: "node-a.example.com", os: "linux", arch: "x64", cpus: 4, memoryBytes: 8 * 1024 ** 3 };
export function createRuntime(root: string, runtime: Runtime) {
  const makeRole = (role: Role) => ({ paths: nodePaths(path.join(root, role)), identity: generateIdentity(),
    client: null as NodeClient | null, inflight: new Map<string, number>() });
  const roles = { a: makeRole("a"), b: makeRole("b") };
  return async (command: ChildCommand): Promise<unknown> => {
    if (command.op === "shutdown") return null;
    if (command.op === "cli") {
      const out: string[] = [], err: string[] = [];
      const args = command.action === "send" ? { positionals: ["send", `${command.target}/review`, "please", "check", "the", "build"], values: {} }
        : command.action === "receive" ? { positionals: ["inbox"], values: { from: SESSION_B, receive: true } }
          : { positionals: ["inbox"], values: { ack: command.token, from: command.owner } };
      const code = await runMsgArgs(args, { paths: roles[command.action === "send" ? "a" : "b"].paths,
        env: command.action === "send" ? { CLAUDE_CODE_SESSION_ID: "s-a" } : {}, out: line => out.push(line), err: line => err.push(line) });
      return { code, out, err };
    }
    if (command.op === "hook") {
      const paths = roles.b.paths;
      return runtime === "codex" ? deliverForCodex({ session_id: SESSION_B, hook_event_name: command.event, cwd: "/test", stop_hook_active: command.continued },
        { paths, ...syntheticHookFacts(paths, SESSION_B, "codex", Date.now()) })
        : deliverForHook({ session_id: SESSION_B, hook_event_name: command.event }, { paths });
    }
    const r = roles[command.role];
    if (command.op === "identity") return { publicKey: r.identity.publicKey };
    if (command.op === "attach") {
      if (r.client) throw Error("role already attached");
      const sessions: SessionInfo[] = [{ sessionId: command.role === "b" ? SESSION_B : "s-a", runtime: command.role === "b" ? runtime : "claude-code",
        state: command.role === "b" ? "idle" : "busy", name: command.role === "b" ? "review" : "planner" }];
      const policy = command.role === "b" ? { ...DEFAULT_POLICY, messaging: { accept: [{ session: "review", from: ["*"] }] } } : DEFAULT_POLICY;
      const list = recordingSessions(r.paths, async () => sessions, () => {});
      fs.mkdirSync(r.paths.dir, { recursive: true, mode: 0o700 });
      writeConfig(r.paths.config, { version: 1, controlUrl: "https://control.example.com", nodeId: command.nodeId, name: command.name,
        publicKey: "test", privateKeyFile: r.paths.privateKey, policyFile: r.paths.policy, enrolledAt: new Date().toISOString() });
      r.client = new NodeClient({ nodeId: command.nodeId, identity: r.identity, policy,
        handlers: { "node.status": async () => ({}), "runtime.list": async () => [], "session.list": list },
        facts: () => FACTS, runtimes: async () => [], sessions: list,
        storeMessage: body => { storeMessage(r.paths.inbox, body); }, ...exchangeOptions(r.paths) });
      return null;
    }
    if (!r.client) throw Error("role not attached");
    if (command.op === "frame") return { frames: await r.client.onFrame(command.frame) };
    if (command.op === "exchange") {
      const frames: string[] = [];
      await pollExchange(r.client, r.paths, r.inflight, frame => { frames.push(frame); return true; });
      return { frames };
    }
    switch (command.kind) {
      case "authenticated": return r.client.authenticated;
      case "directory": return readDirectory(r.paths);
      case "message": return getMessage(r.paths.inbox, command.messageId!);
      case "sent": return getSent(r.paths, command.messageId!);
      case "receipt": return getReceipt(r.paths.inbox, command.messageId!);
    }
  };
}
