// Public generated Node fixture. No provider, native runtime or host inventory.
export const THREAD = "0199a000-0000-7000-8000-000000000001";
export const LAST_MESSAGE = "  All tests pass.\n\n";


export const SCRIPT = (log: string): string => `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
const ownedChildren = new Map();
const ownedSpawn = (args, options) => {
  const child = require("node:child_process").spawn(process.execPath,args,options);
  ownedChildren.set(child.pid,child);process.send?.({kind:"fixture-child-born",pid:child.pid});
  child.on("close",()=>{ownedChildren.delete(child.pid);process.send?.({kind:"fixture-child-closed",pid:child.pid});if(!ownedChildren.size)process.send?.({kind:"fixture-tree-empty"});});
  return child;
};
process.on("message",value=>{
  if(value?.kind==="fixture-tree-signal") {for(const child of ownedChildren.values())child.kill(value.signal);if(!ownedChildren.size)process.send?.({kind:"fixture-tree-empty"});}
  else if(value?.kind==="fixture-child-signal")ownedChildren.get(value.pid)?.kill(value.signal);
});
// codex mcp list --json (codex-mcp.mts): no MCP server, not logged as a run.
if (argv.includes("mcp")) { process.stdout.write("[]\\n"); process.exit(0); }
const stdin = fs.readFileSync(0, "utf8");
const env = { KHEREP_CONFIG_DIR: process.env.KHEREP_CONFIG_DIR, KHEREP_SESSION_ID: process.env.KHEREP_SESSION_ID,
  CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID };
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), stdin, pid: process.pid, ppid: process.ppid, env }) + "\\n");
// codex queue: a thread starting with fa11 has no app server, as when none owns it.
if (argv[0] === "queue") {
  if (argv[2].startsWith("5eec")) { setTimeout(() => process.exit(0), 250); return; }
  // A thread starting with 0a9e hangs: a grandchild holds stderr open, as codex.exe behind the npm launcher does.
  if (argv[2].startsWith("0a9e")) {
    const child = ownedSpawn(["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "inherit"] });
    fs.writeFileSync(${JSON.stringify(log)} + ".child", String(child.pid));
    fs.appendFileSync(${JSON.stringify(log)} + ".relations", JSON.stringify({ pid: child.pid, ppid: process.pid }) + "\\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (argv[2].startsWith("fa11")) { process.stderr.write("Error: no app server owns this thread (token sk-live_Secret1)\\n"); process.exit(1); }
  if (argv[2].startsWith("beef")) { process.stdout.write("Queue accepted\\n"); process.exit(0); }
  process.stdout.write("Queued message " + require("node:crypto").randomUUID() + " for thread " + argv[2] + ".\\n");
  process.exit(0);
}
const prompt = argv[argv.length - 1] === "-" ? stdin : argv[argv.length - 1];
const out = argv[argv.indexOf("-o") + 1];
const thread = argv[1] === "resume" ? argv[argv.length - 2] : ${JSON.stringify(THREAD)};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (prompt.includes("[silent]")) process.exit(2);
// Like the npm launcher: codex runs as a child of this process.
if (prompt.includes("[tree]")) {
  const child = ownedSpawn(["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(log)} + ".child", String(child.pid));
  fs.appendFileSync(${JSON.stringify(log)} + ".relations", JSON.stringify({ pid: child.pid, ppid: process.pid }) + "\\n");
}
if (prompt.includes("[stderr]")) {
  process.stderr.write("warning: first line\\nNot inside a trusted directory; key sk-proj_AbC*12-3 refused\\u0007\\n\\n");
  process.exit(1);
}
const peer = /^Message id: (\\S+)$/m.exec(prompt);
function finish() {
emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
if (prompt.includes("[ignore-term]")) process.on("SIGTERM", () => {});
if (prompt.includes("[sleep]") || prompt.includes("[ignore-term]")) { emit({ type: "item.started", item: { id: "item_0", type: "reasoning" } }); setInterval(() => {}, 1000); }
else if (prompt.includes("[stall]")) setInterval(() => {}, 1000);
else if (prompt.includes("[fail]")) { emit({ type: "turn.failed", error: { message: "model refused" } }); process.exit(1); }
else { fs.writeFileSync(out, ${JSON.stringify(LAST_MESSAGE)}); emit({ type: "turn.completed", usage: {} }); process.exit(0); }
}
if(peer&&!prompt.includes("[fail]")&&!prompt.includes("[no-reply]")) {
  if(!process.send)throw Error("owned fixture reply channel unavailable");
  process.once("message",value=>{if(value&&value.kind==="fixture-reply-complete"&&value.id===peer[1]&&value.ok)finish();else process.exit(3);});
  process.send({kind:"fixture-reply",id:peer[1]});
}else finish();
`;
