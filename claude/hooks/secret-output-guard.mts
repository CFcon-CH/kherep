#!/usr/bin/env node
/**
 * PreToolUse guard: blockt Shell-Kommandos, deren AUSGABE regelmaessig Secrets
 * in Transcripts und gespeicherte Beobachtungen schreibt.
 *
 * Anlass: Messung ueber 107 Projekt-Transcripts ergab 19 Vorkommen mit 11
 * verschiedenen echten Secret-Werten in Tool-Outputs, verteilt auf 9 Sessions.
 * CLAUDE.md verlangt bereits, solche Werte nie unverpackt auszugeben - die Regel
 * ist verhaltensbasiert und wurde wiederholt gerissen. Enforcement statt
 * Gedaechtnis (CLAUDE.md, Autonomie-Sektion "Config-Self-Heal").
 *
 * Der Guard blockt die FORM des Kommandos, nicht seinen Output. Er kann den
 * Output nicht sehen - deshalb greift er an der einzigen Stelle, an der ein
 * Leak noch verhinderbar ist.
 *
 * Erlaubt bleibt jede existenz-pruefende Variante (grep -q, grep -c, wc, test -n),
 * weil die nur ja/nein druckt.
 *
 * Bewusster Notausgang, sichtbar und auditierbar (wie deploy-guard):
 *   KHEREP_SECRET_OK=1 <command>
 * Nur setzen, wenn der Wert wirklich gebraucht wird (z.B. Rotation) UND das
 * Ergebnis anschliessend in Privacy-Tags gefuehrt wird (CLAUDE.md, Capture-Privacy).
 *
 * Wired in ~/.claude/settings.json unter hooks.PreToolUse, matcher "Bash|PowerShell".
 * Run tests: node secret-output-guard.test.mts
 */

// The process import is the global process; nothing needs it since lib/hook-syntax.mts replaced `node --check` (#278).
import process from "node:process";

// The field this hook reads from a PreToolUse payload.
interface ToolPayload {
  tool_input?: { command?: unknown } | null;
}

const PRIV_TAG = "<" + "private>...</" + "private>";

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let d: ToolPayload = {};
  try {
    d = JSON.parse(raw || "{}") as ToolPayload;
  } catch {
    process.exit(0);
  }

  const cmd = ((d.tool_input && d.tool_input.command) || "") as string;
  if (!cmd) process.exit(0);

  function hasAmbiguousCompound(command: string): boolean {
    return /[\r\n;&`()<>]|\$\(|\|\|/.test(command);
  }

  // Sichtbarer, bewusster Notausgang. Nur eine echte Shell-Prefix-Zuweisung
  // gilt; ein spaeteres Vorkommen oder mehrdeutige Compound-Syntax nicht.
  if (/^\s*KHEREP_SECRET_OK=1\s+\S/.test(cmd) && !hasAmbiguousCompound(cmd)) process.exit(0);

  // Nur das VOLLSTAENDIGE Kommando darf eine Existenz-/Zaehlpruefung sein.
  // Ambige Compound-Syntax bleibt fail-closed. Ein abschliessendes Status-echo
  // ist erlaubt, solange es ausschliesslich statischen Text ausgibt.
  function isExistenceOnly(command: string): boolean {
    let body = command.trim();
    const statusEcho = /\s*&&\s*echo\s+["']?[A-Za-z0-9_.:@/+ -]+["']?\s*$/i;
    body = body.replace(statusEcho, "").trim();
    if (!body || hasAmbiguousCompound(body)) return false;

    const quietGrep = /^grep\s+-(?=[a-zA-Z]*[qc])[a-zA-Z]+\b[^|]*$/i;
    const wcConsumer =
      /^wc(?:\s+(?:-[clmwL]+|--(?:bytes|chars|lines|words|max-line-length)))*$/;
    const measureConsumer = /^Measure-Object\b[^|]*$/i;
    const envProducer = /^(?:env|printenv(?:\s+[A-Za-z_][A-Za-z0-9_]*)?)$/i;
    const remoteProducer = /^git\s+remote\s+get-url\s+origin$/i;
    const fileProducer = /^(?:cat|head|tail|type|Get-Content|gc)\b[^|]*$/i;
    const shellTest = /^test\s+-[nz]\b[^|]*$/i;
    const pathTest = /^Test-Path\b[^|]*$/i;
    if (quietGrep.test(body) || shellTest.test(body) || pathTest.test(body)) return true;

    const stages = body.split("|").map((stage) => stage.trim());
    if (stages.length !== 2) return false;
    const [producer, consumer] = stages;
    if (quietGrep.test(consumer)) {
      return envProducer.test(producer) || remoteProducer.test(producer) || fileProducer.test(producer);
    }
    return fileProducer.test(producer) &&
      (wcConsumer.test(consumer) || measureConsumer.test(consumer));
  }

  const existenceOnly = isExistenceOnly(cmd);

  const RULES = [
    {
      id: "env-dump",
      // Nur die DUMP-Form: env/printenv ohne Operand, also gefolgt von Ende, Pipe,
      // Separator, Redirect oder schliessendem Quote (`sh -lc 'env | ...'` - der
      // reale Leak-Fall). `env node x.js`, `env VAR=1 cmd` und `conda env list`
      // fuehren ein Kommando aus und bleiben erlaubt.
      re: /(?:^|[;&|`("'\s])(?:env|printenv)\s*(?=$|['"`)]|\||;|&|>)|Get-ChildItem\s+Env:|\bgci\s+env:/i,
      skipIfExistenceOnly: true,
      fix: "Nicht die ganze Umgebung drucken. Existenz pruefen (`env | grep -q NAME && echo ja`) oder die Variable NUR innerhalb der Ziel-Shell expandieren, z.B. `sh -lc 'psql \"$DATABASE_URL\" -Atc ...'`.",
    },
    {
      id: "secret-var-print",
      // Gezieltes Drucken einer Variablen, deren Name nach Secret klingt
      re: /\b(?:printenv|echo|Write-Output|Write-Host)\s+\$?\{?(?:env:)?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|DATABASE_URL|AUTH|CREDENTIAL)[A-Za-z_]*\}?/i,
      skipIfExistenceOnly: true,
      fix: "Den Wert nicht drucken. Existenz pruefen (`[ -n \"$VAR\" ] && echo gesetzt`) oder die Variable direkt an das Zielkommando durchreichen, ohne sie sichtbar zu machen.",
    },
    {
      id: "mcp-config-content",
      re: /(\.claude\.json|mcpServers|["']Authorization["']\s*:)/i,
      skipIfExistenceOnly: true,
      fix: "Die MCP-Konfiguration enthaelt Bearer-Tokens. Nur auf Existenz pruefen, oder den Wert innerhalb eines Skripts lesen und dort verwenden, ohne ihn zu drucken.",
    },
    {
      id: "git-remote-verbose",
      re: /\bgit\s+remote\s+(-v\b|get-url\b)/i,
      skipIfExistenceOnly: true,
      fix: "CLAUDE.md verbietet das: eingebettete Tokens leaken so. Fuer die blosse Existenz `git remote` (ohne -v), fuer den Host-Check `git remote get-url origin | grep -q '@'`.",
    },
    {
      id: "k8s-secret-dump",
      re: /kubectl[^\n]*\bget\s+secrets?\b[^\n]*(-o\s*=?\s*(json|yaml|jsonpath)|base64\s+(-d|--decode))/i,
      skipIfExistenceOnly: false,
      fix: "Secret-Inhalte nie ins Transcript. Nur Namen und Keys listen, oder den Wert direkt im Ziel-Pod konsumieren statt ihn herauszuziehen.",
    },
    {
      id: "secret-file-read",
      re: /\b(cat|bat|less|more|head|tail|type|Get-Content|gc)\b[^\n|]*?(\.env\b|\bsecrets?\.(json|ya?ml|txt)|\bcredentials?\b[^\n|]*\.(json|ya?ml|txt)|id_rsa|\.pem\b|\.pfx\b)/i,
      skipIfExistenceOnly: true,
      fix: "Datei enthaelt mutmasslich Secrets. Nur die benoetigte Einzelinformation extrahieren, oder die Datei im Zielprozess lesen lassen statt sie zu drucken.",
    },
  ];

  for (const r of RULES) {
    if (!r.re.test(cmd)) continue;
    if (r.skipIfExistenceOnly && existenceOnly) continue;
    process.stderr.write(
      `[secret-output-guard] BLOCKED (${r.id}): dieses Kommando druckt mutmasslich einen Secret-Wert ` +
        `ins Transcript. Tool-Outputs können in Transcripts und gespeicherten Beobachtungen landen - ` +
        `ein Leak ist danach nur noch per Rotation plus Purge zu bereinigen.\n\n` +
        `Besserer Weg: ${r.fix}\n\n` +
        `Wenn der Wert wirklich gebraucht wird (z.B. Rotation): sichtbar mit ` +
        `\`KHEREP_SECRET_OK=1 <command>\` erneut absetzen und das Ergebnis in Privacy-Tags fuehren (${PRIV_TAG}).\n`
    );
    process.exit(2);
  }

  process.exit(0);
});
