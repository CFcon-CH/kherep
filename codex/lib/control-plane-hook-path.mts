import { command, CONTROL_PLANE_ENTRY, ENTRY_NODE_FLAG, hookGroup } from "./parity-config.mts";

// Issues #70, #325 and #503. Blocks written before issue #503 ran the deliver
// and attribution hooks from the checkout or source pin the installer ran from,
// so every upgrade wrote another path into them. The stable suffix and the
// runtime argument identify the hook, not the checkout: every such command in
// the managed block becomes the stable entry-point form, once, before the block
// is matched. The shell dispatcher carries the attribution path as its argument
// with the same tail, so the same rule covers it. Both `command` and
// `commandWindows` carry the same form.
const CHECKOUT_HOOK = /\\"((?:[^"\\]|\\\\)*?(?:\\\\|\/)modules(?:\\\\|\/)control-plane(?:\\\\|\/)node(?:\\\\|\/))(deliver|attribution)-hook\.mts\\" \\"--runtime\\" \\"codex\\"/g;
// The stable deliver command of any hook dir, as its TOML line spells it.
const DELIVER_COMMAND = new RegExp(String.raw`^command = ".*\\"(?:[^"\\]|\\\\)*?`
  + CONTROL_PLANE_ENTRY.replace(".", String.raw`\.`) + String.raw`\\" \\"deliver\\" \\"--runtime\\" \\"codex\\""$`, "m");
const DELIVER_EVENTS = [
  ["SessionStart", "startup|resume|clear|compact"],
  ["UserPromptSubmit", ""],
  ["Stop", ""],
] as const;

function hookGroups(config: string): string[] {
  const tables = config.split(/^(?=\[)/m);
  const groups: string[] = [];
  for (let index = 0; index < tables.length;) {
    const event = /^\[\[hooks\.(\w+)\]\]\n/.exec(tables[index])?.[1];
    if (!event) { index += 1; continue; }
    let next = index + 1;
    while (next < tables.length && /^\[\[?hooks\.(\w+)\./.exec(tables[next])?.[1] === event) next += 1;
    groups.push(tables.slice(index, next).join("").trim());
    index = next;
  }
  return groups;
}

// entry: the stable entry point of this install, when the control plane is wired.
// controlPlaneHook: the deliver hook of this install's own source. Exact external
// groups keep sole ownership in the stable form, and in the checkout-path form
// bound to this same source, which an operator copied before issue #503; they
// are never rewritten, because they lie outside the managed block.
export function hasExactExternalDeliverHooks(
  config: string, node: string, entry: string | undefined, controlPlaneHook: string | undefined,
  startMarker: string, endMarker: string,
): boolean {
  if (!entry) return false;
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (start >= 0 && end < start) return false;
  const external = start < 0 ? config
    : config.slice(0, start) + config.slice(end + endMarker.length);
  const bound = [command(node, ENTRY_NODE_FLAG, entry, "deliver", "--runtime", "codex"),
    ...(controlPlaneHook ? [command(node, controlPlaneHook, "--runtime", "codex")] : [])];
  const groups = hookGroups(external);
  return DELIVER_EVENTS.every(([event, matcher]) => {
    const expected = new Set(bound.map((value) => hookGroup(event, matcher, [{ command: value, commandWindows: `& ${value}` }])));
    return groups.filter((group) => expected.has(group)).length === 1;
  });
}

// Every checkout-path hook command in text, in the stable form of entry. A
// hook command starts the entry point with ENTRY_NODE_FLAG; the shell
// dispatcher's argument names the entry point alone.
const SHELL_ARGUMENT = /codex-shell-checks\.mts\\" $/;
export function stableHookCommands(text: string, entry: string): string {
  // The entry path exactly as a rendered TOML string spells it.
  const spelled = JSON.stringify(command(entry)).slice(3, -3);
  return text.replace(CHECKOUT_HOOK, (_match, _dir, name: string, offset: number) =>
    `${SHELL_ARGUMENT.test(text.slice(Math.max(0, offset - 256), offset)) ? "" : `\\"${ENTRY_NODE_FLAG}\\" `}`
    + `\\"${spelled}\\" \\"${name}\\" \\"--runtime\\" \\"codex\\"`);
}

export function pointControlPlaneHooksAt(
  config: string, entry: string | undefined, startMarker: string, endMarker: string,
): string {
  const start = config.indexOf(startMarker);
  const end = start < 0 ? -1 : config.indexOf(endMarker, start);
  if (!entry || end < 0) return config;
  const body = stableHookCommands(config.slice(start, end), entry);
  return config.slice(0, start) + dropSurplusDeliverGroups(body) + config.slice(end);
}

// Older installs left a second set of deliver-hook groups in the block. Keep the
// first group per event whose hooks are all deliver hooks and drop the later
// ones. A group that mixes a deliver hook with another hook is never touched.
function dropSurplusDeliverGroups(body: string): string {
  const tables = body.split(/^(?=\[)/m);
  const seen = new Set<string>();
  const kept: string[] = [];
  let dropped = false;
  let index = 0;
  while (index < tables.length) {
    const event = /^\[\[hooks\.(\w+)\]\]\n/.exec(tables[index])?.[1];
    if (!event) {
      kept.push(tables[index]);
      index += 1;
      continue;
    }
    // A group owns every following table under its own event path.
    let next = index + 1;
    while (next < tables.length && /^\[\[?hooks\.(\w+)\./.exec(tables[next])?.[1] === event) next += 1;
    const hooks = tables.slice(index + 1, next);
    const deliverOnly = hooks.length > 0 && hooks.every((table) =>
      table.startsWith(`[[hooks.${event}.hooks]]\n`) && DELIVER_COMMAND.test(table));
    if (deliverOnly && seen.has(event)) {
      dropped = true;
    } else {
      if (deliverOnly) seen.add(event);
      kept.push(...tables.slice(index, next));
    }
    index = next;
  }
  return dropped ? kept.join("").replace(/(?<!\n)\n{2,}$/, "\n") : body;
}
