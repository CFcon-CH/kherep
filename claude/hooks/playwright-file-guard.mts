#!/usr/bin/env node
// PreToolUse guard: blocks Playwright MCP browser_navigate with a file:// URL.
//
// Wiederkehrender Kherep-Fehlerfall: der Playwright-MCP blockt `file://` hart.
// Statt reinzurennen: lokales HTML per HTTP-Server ausliefern und ueber
// http://localhost:<port>/ navigieren. Dieser Hook erzwingt das an der Quelle
// (Enforcement statt Gedaechtnis) - Gotcha: Kherep/Gotchas/Playwright-Local-HTML.
//
// Wired in ~/.claude/settings.json unter hooks.PreToolUse mit matcher
// "mcp__plugin_playwright_playwright__browser_navigate".

// The process import is the global process; nothing needs it since lib/hook-syntax.mts replaced `node --check` (#278).
import process from "node:process";
import { warnUnclassifiable } from "./lib/tool-event-shape.mts";

// The field this hook reads from a PreToolUse payload.
interface NavigatePayload {
  tool_input?: { url?: unknown } | null;
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let d: NavigatePayload = {};
  try {
    d = JSON.parse(raw || "{}") as NavigatePayload;
  } catch {
    warnUnclassifiable(undefined, "playwright-file-guard");
    process.exit(0);
  }
  const url = (d.tool_input && d.tool_input.url) || "";
  if (/^file:\/\//i.test(url as string)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "file:// ist im Playwright-MCP hart geblockt (wiederkehrender Kherep-Fehlerfall). " +
            "Serve das lokale HTML per `python3 -m http.server <port>` (WSL: `wsl -d Ubuntu -u root -- bash -lc 'cd <dir> && exec python3 -m http.server <port>'` persistent via run_in_background) " +
            "und navigiere zu http://localhost:<port>/<datei>.html statt file://. Gotcha: Kherep/Gotchas/Playwright-Local-HTML.",
        },
      })
    );
  } else warnUnclassifiable(d, "playwright-file-guard"); // the quiet allow (issue #808)
  process.exit(0);
});
