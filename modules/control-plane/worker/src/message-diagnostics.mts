import { isMessageDiagnostic, type MessageDiagnostic } from "../../protocol-diagnostics.mts";
export function readDiagnostic(raw: unknown, state: string, progressAt?: unknown): MessageDiagnostic | undefined {
  try {
    const value: unknown = JSON.parse(String(raw));
    if (!isMessageDiagnostic(value)) return undefined;
    if (value.stage === "target-progress" ? state !== "accepted" || value.observedAt !== progressAt
      : value.stage === "upstream-egress" ? state !== "queued" : state !== "refused") return undefined;
    return value;
  } catch { return undefined; }
}
// Observational writes are isolated from the admission/state SQL and never throw.
export function storeDiagnostic(sql: SqlStorage, messageId: string, diagnostic?: MessageDiagnostic): void {
  try { sql.exec("UPDATE messages SET diagnostic_json=? WHERE id=?", diagnostic ? JSON.stringify(diagnostic) : null, messageId); }
  catch { /* Missing detail does not change the existing admission result. */ }
}
