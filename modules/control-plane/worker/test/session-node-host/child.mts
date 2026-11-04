import path from "node:path";
import { createRuntime } from "./runtime.mts";
import { failure, isObject, validCommand, MAX_BYTES, type ChildCommand } from "../session-node-protocol.mts";
const [root, runtime] = process.argv.slice(2);
if (!root || !path.isAbsolute(root) || runtime !== "codex" && runtime !== "claude-code") throw Error("invalid generated case startup");
const run = createRuntime(root, runtime);
const seen = new Set<number>();
let active = 0;
process.on("disconnect", () => process.exit(1));
const watchdog = setTimeout(() => process.exit(2), 120_000);
watchdog.unref();
process.on("message", async (value: unknown) => {
  if (!isObject(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || seen.has(Number(value.id))
    || active >= 256 || seen.size >= 4096 || JSON.stringify(value).length > MAX_BYTES
    || !(isObject(value.command) && value.command.op === "shutdown" && Object.keys(value.command).length === 1
      || validCommand(value.command) && value.command.op !== "create" && value.command.op !== "close")) {
    process.send?.({ id: isObject(value) ? value.id : null, error: failure(Error("invalid child command")) });
    return;
  }
  const id = Number(value.id), command = value.command as ChildCommand;
  seen.add(id); active++;
  try {
    const result = await run(command);
    process.send?.({ id, result }, error => {
      if (error) { console.error("synthetic harness IPC send failed", failure(error)); process.exit(1); }
      if (command.op === "shutdown") process.exit(0);
    });
  } catch (error) { process.send?.({ id, error: failure(error) }); }
  finally { active--; }
});
process.send?.({ ready: true });
