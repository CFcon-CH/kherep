import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { findAssignmentRollout, isAssignmentOriginalMeta, META_LINE_BYTES } from "./codex-app.mts";

// Public source contract: openai/codex@748ab55ca7de0b647d9a7a9d9a8e70e00f28666d,
// history/rollout_payload.rs, history/lib.rs, protocol/{turn_input,models}.rs.
// This is host attribution, not proof against a hostile enrolled native client.
const TAIL_BYTES = 2 * 1024 * 1024, CHUNK_BYTES = 64 * 1024, MAX_LINES = 4096, BUDGET_MS = 150;
const record = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;

// JSON.parse silently keeps the last duplicate key. Ambiguous attribution must
// refuse instead. Scan strings only after normal JSON validation, so punctuation
// inside escaped text cannot become a key or a boundary.
function parseRecord(bytes: Buffer, decoder: InstanceType<typeof TextDecoder>, deadline: number): unknown {
  const source = decoder.decode(bytes), parsed: unknown = JSON.parse(source), objects: Set<string>[] = [];
  for (let i = 0; i < source.length; i++) {
    if (i % 4096 === 0 && performance.now() > deadline) throw new Error("native read exceeds budget");
    if (source[i] === "{") objects.push(new Set());
    else if (source[i] === "}") objects.pop();
    else if (source[i] === '"') {
      const start = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === "\\") i++;i++; }
      let after = i + 1;
      while (/[ \t\r\n]/u.test(source[after] ?? "")) after++;
      if (source[after] === ":") {
        const key: string = JSON.parse(source.slice(start, i + 1)), keys = objects.at(-1);
        if (!keys || keys.has(key)) throw new Error("ambiguous native record");
        keys.add(key);
      }
    }
  }
  return parsed;
}

export function isLeadAppointment(text: unknown): boolean {
  return typeof text === "string" && text.length <= 160
    && /^(?:du[ \t]+bist[ \t]+ab[ \t]*sofort[ \t]+Kherep-Lead|übernimm[ \t]+jetzt[ \t]+die[ \t]+Rolle[ \t]+Kherep-Lead|you[ \t]+are[ \t]+now[ \t]+Kherep-Lead)[.!]?$/iu.test(text)
    && !/[\r\n]/u.test(text);
}

function currentDirective(rows: Record<string, any>[], turnId: string): { text: string; order: number } | null {
  const start = rows[0]?.payload, a = start?.turn_attribution;
  if (!record(start) || !record(a) || start.turn_id !== turnId || start.root_turn_id !== turnId
    || a.turn_id !== turnId || a.turn_trigger !== "user" || !absent(a.parent_turn_id)
    || !absent(a.initiating_agent_path) || !(absent(a.root_turn_id) || a.root_turn_id === turnId)) return null;
  let input: { text: string; order: number } | null = null;
  const orders = new Set<number>(), events: string[] = [];
  for (const row of rows.slice(1)) {
    const p = row.payload;
    if (!record(p)) return null;
    if (row.type === "event_msg") {
      if (p.type === "user_message") {
        // Even identical text announced after the durable input may be a new,
        // not-yet-persisted steer. Text equality cannot correlate that event.
        if (typeof p.message !== "string" || events.length > 0 || input !== null) return null;
        events.push(p.message);
      } else if (!["token_count", "agent_message", "agent_reasoning", "agent_reasoning_raw_content",
        "exec_command_begin", "exec_command_end", "exec_command_output_delta", "mcp_tool_call_begin", "mcp_tool_call_end",
        "custom_tool_call_begin", "custom_tool_call_end", "warning", "thread_settings_applied"].includes(p.type)) return null;
      continue;
    }
    if (row.type === "turn_context" || row.type === "inter_agent_communication" || row.type === "inter_agent_communication_metadata") continue;
    if (row.type !== "response_item") return null;
    if (p.role !== "user") {
      if (p.type === "message" && ["assistant", "developer", "system"].includes(p.role)) continue;
      if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "reasoning", "web_search_call", "tool_search_call", "tool_search_output"].includes(p.type)) continue;
      return null;
    }
    if (p.type !== "message") return null;
    const m = row.metadata, pass = p.internal_chat_message_metadata_passthrough;
    if (!record(m) || !record(pass) || pass.turn_id !== turnId || !Array.isArray(p.content) || p.content.length === 0
      || !Array.isArray(pass.content_item_kinds) || !Array.isArray(pass.content_item_metadata)
      || p.content.length !== pass.content_item_kinds.length || p.content.length !== pass.content_item_metadata.length) return null;
    // Unknown history annotations or inherited/retained/sender evidence cannot
    // silently turn a previously recorded grant into current authorization.
    if (Object.keys(m).some(k => !["user_input_order", "history_sequence", "client_authored"].includes(k))) return null;
    const human = p.content.map((part: unknown, i: number) => record(part) && part.type === "input_text"
      && typeof part.text === "string" && pass.content_item_kinds[i] === "user.text"
      && record(pass.content_item_metadata[i]) && record(pass.content_item_metadata[i].provenance)
      && Object.keys(pass.content_item_metadata[i].provenance).join(",") === "type"
      && pass.content_item_metadata[i].provenance.type === "user");
    if (!human.every(Boolean)) {
      // Explicitly non-human fragments may follow the initiating input. Mixed
      // source, unknown attribution and human attachments are denial barriers.
      if (human.some(Boolean) || !p.content.every((_part: unknown, i: number) =>
        ["tool", "harness", "agents_md", "skills", "developer_instructions"].includes(pass.content_item_metadata[i]?.provenance?.type))) return null;
      continue;
    }
    if (!Number.isSafeInteger(m.user_input_order) || m.user_input_order < 0 || orders.has(m.user_input_order)) return null;
    orders.add(m.user_input_order);
    // A second actual user input is a steer. The initial turn trigger cannot
    // establish its direct-vs-Queue source, even with a larger acceptance order.
    if (input) return null;
    input = { text: p.content.map((part: { text: string }) => part.text).join(""), order: m.user_input_order };
  }
  return input && (events.length === 0 || events[0] === input.text) && isLeadAppointment(input.text) ? input : null;
}

// Returns only an opaque local witness; never transmit it, paths, rows or text.
// All failures collapse to null. Both the header and tail use the same fd.
export function readLeadDirective(home: string, sessionId: string, turnId: string): string | null {
  let fd: number | undefined;
  try {
    const deadline = performance.now() + BUDGET_MS;
    const file = findAssignmentRollout(home, sessionId);
    if (!file || performance.now() > deadline) return null;
    const root = fs.realpathSync(home), canonical = fs.realpathSync(file);
    if (!canonical.startsWith(root + path.sep) || fs.lstatSync(file).isSymbolicLink()) return null;
    const resolvedHome = path.resolve(home), relative = path.relative(resolvedHome, path.dirname(file)).split(path.sep);
    if (relative.length !== 4 || relative[0] !== "sessions" || !/^\d{4}$/u.test(relative[1]!)
      || !/^\d{2}$/u.test(relative[2]!) || !/^\d{2}$/u.test(relative[3]!)) return null;
    // Keep the configured home's lookup semantics, including trailing / or /.
    const parents = [home, ...relative.map((_part, i) => path.join(resolvedHome, ...relative.slice(0, i + 1)))];
    const availableIdentity = (s: fs.BigIntStats) => typeof s.dev === "bigint" && typeof s.ino === "bigint" && s.ino > 0n;
    const parentIdentity = () => parents.map(parent => {
      const stat = fs.lstatSync(parent, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !availableIdentity(stat)) throw new Error("invalid native directory identity");
      return `${stat.dev}:${stat.ino}`;
    }).join("|");
    const beforeParents = parentIdentity();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    const identity = (s: fs.BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    if (!before.isFile() || !availableIdentity(before) || before.nlink !== 1n || identity(before) !== identity(named) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const size = Number(before.size), head = Buffer.alloc(Math.min(size, META_LINE_BYTES));
    if (fs.readSync(fd, head, 0, head.length, 0) !== head.length) return null;
    const newline = head.indexOf(10), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    if (newline < 0 || !isAssignmentOriginalMeta(parseRecord(head.subarray(0, newline), decoder, deadline), sessionId)) return null;
    let offset = size, pending = Buffer.alloc(0), consumed = 0, lines = 0, found = false;
    const reverse: Record<string, any>[] = [];
    while (offset > newline + 1 && consumed < TAIL_BYTES && !found) {
      if (performance.now() > deadline) return null;
      const count = Math.min(CHUNK_BYTES, offset - newline - 1, TAIL_BYTES - consumed), chunk = Buffer.alloc(count);
      offset -= count;consumed += count;
      if (fs.readSync(fd, chunk, 0, count, offset) !== count) return null;
      pending = Buffer.concat([chunk, pending]);
      if (reverse.length === 0 && lines === 0) { if (pending.at(-1) !== 10) return null;pending = pending.subarray(0, -1); }
      let end: number;
      while ((end = pending.lastIndexOf(10)) >= 0 || offset === newline + 1 && pending.length > 0) {
        if (++lines > MAX_LINES || performance.now() > deadline) return null;
        const start = end < 0 ? 0 : end + 1, bytes = pending.subarray(start);
        pending = end < 0 ? Buffer.alloc(0) : pending.subarray(0, end);
        if (bytes.length === 0 || bytes.length > META_LINE_BYTES) return null;
        const row = parseRecord(bytes, decoder, deadline);
        if (!record(row)) return null;
        reverse.push(row);
        if (row.type === "event_msg" && ["task_started", "turn_started"].includes(row.payload?.type)) { found = true;break; }
      }
      if (pending.length > META_LINE_BYTES) return null;
    }
    if (!found) return null;
    const input = currentDirective(reverse.reverse(), turnId);
    if (!input || performance.now() > deadline || identity(fs.fstatSync(fd, { bigint: true })) !== identity(before)
      || identity(fs.lstatSync(file, { bigint: true })) !== identity(before) || fs.realpathSync(file) !== canonical
      || findAssignmentRollout(home, sessionId) !== file || parentIdentity() !== beforeParents || performance.now() > deadline) return null;
    return createHash("sha256").update(`${before.dev}:${before.ino}:${turnId}:${input.order}:${input.text}`).digest("hex");
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
