#!/usr/bin/env node
// OP-1137. Dieselben Prüfungen wie die JavaScript-Fassung, jetzt auf node:test.
// Die eigene pass/fail-Zählerei ist damit weg; der Vertrag bleibt: der Lauf
// muss auch einzeln als `node workspace-scope.test.mts` grün oder rot sein,
// weil die CI-Schleife jede Suite genau so startet.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { checkoutFor } from "./orchestra-checkout.mts";
import {
  isKherepScope,
  isWithinPath,
  normalizePathLike,
  workspaceForPayload,
} from "./workspace-scope.mts";

// Das Geschwister-Verzeichnis neben dem Workspace, das genauso anfängt und
// trotzdem nie Workspace ist. Unverändert aus der JavaScript-Fassung.
test("normalisiert Windows-Trenner und Punkt-Segmente", () => {
  assert.equal(normalizePathLike("D:\\Work\\Kherep\\repo\\..\\analysis"), "D:/Work/Kherep/analysis");
  assert.equal(normalizePathLike("D:\\Work\\\\"), "D:/Work");
  assert.equal(normalizePathLike("D:\\"), "D:");
  assert.equal(normalizePathLike("///"), "/");
});

test("vergleicht Nachfahren auf beiden Plattformen", () => {
  assert.ok(isWithinPath("d:\\work\\repo", "D:\\Work"));
  assert.ok(isWithinPath("/Users/example/Work/repo", "/Users/example/Work"));
});

test("ein Payload mit cwd setzt den Scope, ein Transkript-Slug nie", () => {
  assert.ok(isKherepScope({ cwd: "D:\\Work\\repo" }, { KHEREP_WORKSPACE: "D:\\Work" }));
  assert.ok(isKherepScope({ cwd: "/Users/example/Work/repo" }, { KHEREP_WORKSPACE: "/Users/example/Work" }));
  assert.ok(!isKherepScope({ transcript_path: "C:/tmp/d--work/session.jsonl" }, {}));
  assert.ok(!isKherepScope({ cwd: "/Users/example/Work-copy" }, { KHEREP_WORKSPACE: "/Users/example/Work" }));
  assert.ok(!isKherepScope({ cwd: "/Users/example/Work/repo" }, {}));
});

test("ein gesetzter Workspace trägt ein altes Payload ohne cwd", () => {
  assert.equal(workspaceForPayload({}, { KHEREP_WORKSPACE: "/Users/example/Work" }), "/Users/example/Work");
  assert.equal(workspaceForPayload({}, { KHEREP_WORKSPACE: "" }), "");
});

// Die Checkout-Suche misst am echten Dateisystem, weil sie genau das tut: ein
// Kandidat gilt erst, wenn claude/hooks darunter wirklich liegt.
const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-checkout-"));
const canonicalCheckout = path.join(checkoutRoot, "kherep");
after(() => fs.rmSync(checkoutRoot, { recursive: true, force: true }));

test("die Checkout-Suche verwendet nur den kanonischen Klonnamen", () => {
  fs.mkdirSync(path.join(canonicalCheckout, "claude", "hooks"), { recursive: true });
  assert.equal(checkoutFor({}, "", { KHEREP_WORKSPACE: checkoutRoot }), normalizePathLike(canonicalCheckout));
});
