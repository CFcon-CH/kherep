#!/usr/bin/env node
/**
 * Test harness for secret-output-guard.mts
 * Node-native, kein Framework (Stil wie deploy-guard.test.mts).
 * exit 2 = block, exit 0 = allow.
 * Run: node secret-output-guard.test.mts
 */
import path from "node:path";
import { spawnSync } from "node:child_process";

const HOOK = path.join(import.meta.dirname, "secret-output-guard.mts");
let pass = 0;
let fail = 0;

function runHook(command: string, toolName?: string): { blocked: boolean; stderr: string } {
  const res = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: toolName || "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  return { blocked: res.status === 2, stderr: res.stderr || "" };
}

function expectBlocked(label: string, command: string, ruleId?: string, toolName?: string): void {
  const { blocked, stderr } = runHook(command, toolName);
  if (blocked && (!ruleId || stderr.includes(`(${ruleId})`))) {
    pass++;
    console.log(`  ok   BLOCK  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL BLOCK  ${label} -> blocked=${blocked} ${ruleId ? `expected rule ${ruleId}` : ""}`);
  }
}

function expectAllowed(label: string, command: string, toolName?: string): void {
  const { blocked, stderr } = runHook(command, toolName);
  if (!blocked) {
    pass++;
    console.log(`  ok   ALLOW  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ALLOW  ${label} -> geblockt: ${stderr.split("\n")[0]}`);
  }
}

console.log("\n-- Regressionen: die beiden realen Leaks vom 2026-07-29 --");
// Leak 1: MCP-Bearer-Token aus der Claude-Config gedruckt
expectBlocked(
  "node -e liest .claude.json und druckt Kontext",
  `node -e "const fs=require('fs'); const s=fs.readFileSync(process.env.HOME+'/.claude.json','utf8'); console.log(s.slice(i-350,i+350));"`,
  "mcp-config-content"
);
// Leak 2: Postgres-Passwort aus Pod-Env gedruckt
expectBlocked(
  "kubectl exec ... env | grep -iE db|data|path",
  `ssh example-host "kubectl -n app exec deploy/service -- sh -lc 'env | grep -iE \\"db|data|path|dir\\" | head -10'"`,
  "env-dump"
);

console.log("\n-- Weitere Block-Faelle --");
expectBlocked("bare env", "env", "env-dump");
expectBlocked("printenv am Pipeline-Start", "printenv | sort | head -40", "env-dump");
expectBlocked("PowerShell Env-Drive", "Get-ChildItem Env: | Format-Table", "env-dump", "PowerShell");
expectBlocked("git remote -v", "git remote -v", "git-remote-verbose");
expectBlocked("git remote get-url roh", "git remote get-url origin", "git-remote-verbose");
expectBlocked("k8s secret als yaml", ["kubectl","-n","kherep","get","secret","my-sec","-o","yaml"].join(" "), "k8s-secret-dump");
expectBlocked("k8s secret base64 -d", "kubectl get secret x -o jsonpath='{.data.p}' | base64 -d", "k8s-secret-dump");
expectBlocked("cat .env", "cat /app/.env", "secret-file-read");
expectBlocked("Get-Content id_rsa", "Get-Content ~/.ssh/id_rsa", "secret-file-read", "PowerShell");
expectBlocked("mcpServers grep mit Kontext", "grep -A3 mcpServers ~/.claude.json", "mcp-config-content");

console.log("\n-- Gezieltes Drucken einer Secret-Variablen --");
expectBlocked("echo $DATABASE_URL", "echo $DATABASE_URL", "secret-var-print");
expectBlocked("printenv GITHUB_TOKEN", "printenv GITHUB_TOKEN", "secret-var-print");
expectBlocked("PowerShell env-Drive-Variable", "Write-Output $env:CLIENT_SECRET", "secret-var-print", "PowerShell");

console.log("\n-- Erlaubt: env fuehrt ein Kommando aus, kein Dump --");
expectAllowed("env als Interpreter-Wrapper", "env node build.js");
expectAllowed("env mit Variablen-Prefix", "env NODE_ENV=production npm run build");
expectAllowed("conda env list", "conda env list");
expectAllowed("echo einer harmlosen Variablen", "echo $HOME");

console.log("\n-- Erlaubt: Existenzpruefung statt Wert --");
expectAllowed("env auf Existenz", 'env | grep -q DATABASE_URL && echo vorhanden');
expectAllowed("env zaehlen", "env | grep -c PATH");
expectAllowed("quiet flag after other letters", "env | grep -ixQ PATH");
expectAllowed("count flag before other letters", "env | grep -ci PATH");
expectBlocked("flag without quiet or count stays blocked", "env | grep -iv PATH", "env-dump");
expectBlocked("quiet letter in pattern is not a quiet flag", "env | grep -i q", "env-dump");
expectBlocked("quiet flag does not allow another pipe", "env | grep -q PATH | cat", "env-dump");
expectAllowed("remote-Host-Check ohne Wert", "git remote get-url origin | grep -q '@' && echo token-in-url");
expectAllowed("nur Remote-Namen", "git remote");
expectAllowed("Config nur auf Existenz", "grep -q mcpServers ~/.claude.json && echo konfiguriert");
expectAllowed("Secret-Namen listen ohne Werte", "kubectl -n kherep get secret");
expectAllowed("Variable nur in Ziel-Shell expandiert", `ssh example-host "kubectl exec deploy/x -- sh -lc 'psql \\"\\$DATABASE_URL\\" -Atc \\"select 1\\"'"`);

console.log("\n-- Erlaubt: harmlose Alltagskommandos --");
expectAllowed("git status", "git status --short");
expectAllowed("ls", "ls -la /tmp");
expectAllowed("npm test", "npm test -- --run");
expectAllowed("cat einer normalen Datei", "cat README.md");
expectAllowed("head eines Logs", "head -20 /var/log/app.log");
expectAllowed("env-Zuweisung als Praefix", "NODE_ENV=production node build.js");
expectAllowed("kubectl get pods", "kubectl -n kherep get pods -o wide");

console.log("\n-- Notausgang --");
expectAllowed("bewusst freigegeben", "KHEREP_SECRET_OK=1 env | grep DATABASE_URL");
expectBlocked(
  "Notausgang als spaeterer Text gilt nicht",
  "echo KHEREP_SECRET_OK=1; env",
  "env-dump"
);
expectBlocked(
  "Notausgang nach einem Kommando gilt nicht",
  "printf 'audit KHEREP_SECRET_OK=1' && cat /app/.env",
  "secret-file-read"
);
expectBlocked(
  "Notausgang gilt nicht fuer ein spaeteres Compound-Segment",
  "KHEREP_SECRET_OK=1 echo audit; cat /app/.env",
  "secret-file-read"
);

console.log("\n-- Compound-Kommandos bleiben fail-closed --");
expectBlocked(
  "sichere Existenzpruefung entschuldigt keinen spaeteren Dump",
  "env | grep -q DATABASE_URL; cat /app/.env",
  "env-dump"
);
expectBlocked(
  "sichere Remote-Pruefung entschuldigt keinen spaeteren Rohzugriff",
  "git remote get-url origin | grep -q '@' && git remote get-url origin",
  "git-remote-verbose"
);
expectBlocked(
  "tee-Seitenkanal vor wc bleibt geblockt",
  "cat /tmp/example.env | tee /dev/stderr | wc -l",
  "secret-file-read"
);
expectBlocked(
  "tee-Seitenkanal vor grep -q bleibt geblockt",
  "cat /tmp/example.env | tee /dev/stderr | grep -q TOKEN",
  "secret-file-read"
);
expectBlocked(
  "Umleitung vor wc bleibt fail-closed",
  "cat /tmp/example.env 2>/dev/stderr | wc -l",
  "secret-file-read"
);
expectBlocked(
  "beliebiger Producer vor wc bleibt geblockt",
  "perl -ne 'print STDERR' /tmp/example.env cat /tmp/example.env | wc -l",
  "secret-file-read"
);
expectBlocked(
  "beliebiger Producer vor quiet grep bleibt geblockt",
  "perl -ne 'print STDERR' /tmp/example.env cat /tmp/example.env | grep -q TOKEN",
  "secret-file-read"
);
expectBlocked(
  "wc darf keine Dateiliste aus stdin ausfuehren",
  "cat /tmp/example.env | wc --files0-from=-",
  "secret-file-read"
);
expectAllowed("direkter Producer vor wc bleibt erlaubt", "cat /tmp/example.env | wc -l");

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
