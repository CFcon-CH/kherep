import { readFileSync } from "node:fs";
import ts from "typescript";
import { containedFile } from "./coverage-paths.mts";

export function dropErasedTypes(lcov: string, root: string): { lcov: string; dropped: string[] } {
  const dropped: string[] = [];
  const records = lcov.split(/(?<=end_of_record\r?\n)/);
  const tail = records.at(-1)?.includes("end_of_record") ? "" : records.pop() ?? "";
  const kept = records.filter(record => {
    const name = /^SF:(.+)$/m.exec(record)?.[1];
    if (!name || !/\.(mts|cts|ts)$/.test(name)) return true;
    const source = ts.createSourceFile(name, readFileSync(containedFile(root, name), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length || !source.statements.length) return true;
    const erased = source.statements.every(statement => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true));
    if (erased) dropped.push(name);
    return !erased;
  });
  return { lcov: kept.join("") + tail, dropped };
}
