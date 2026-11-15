#!/usr/bin/env node
// PostToolUse hook: warns when Edit/Write/MultiEdit inserts ASCII-transliterated
// German Umlaut words (fuer, ueber, aendern, ...) into a German doc file (.md/.xml/.txt).
// Soft warn only: injects additionalContext so the model self-corrects to real ae/oe/ue -> ä/ö/ü.
// Global rule "Echte Umlaute in deutschen Texten".
//   - ss stays ss (Swiss Hochdeutsch, no ß) -> NO ss-tokens in the denylist.
//   - Whole-word denylist, NOT a digraph scan -> no false positives on neue/Confluence/Traefik/Daemon/true.
//   - Only .md/.xml/.txt with German context. Code/config/data and filenames/paths/shell stay ASCII.
// Design: Kherep/Gotchas/Umlaut-Transliteration-Gap.md

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Whole-word transliteration tokens (ASCII form of an ae/oe/ue word). No ss->ß tokens.
const DENY = [
  'fuer', 'ueber', 'ueberhaupt', 'ueblich', 'ueblicherweise', 'gegenueber', 'ueberpruefen',
  'aendern', 'aendert', 'aenderst', 'aenderung', 'aenderungen', 'geaendert', 'geaenderte', 'geaenderten', 'geaenderter',
  'pruefen', 'prueft', 'pruefung', 'geprueft', 'vorpruefung',
  'koennen', 'koennte', 'koennten', 'koenntest',
  'muessen', 'muesste', 'muessten',
  'waehlen', 'waehlt', 'auswaehlen', 'gewaehlt',
  'oeffnen', 'oeffnet', 'geoeffnet', 'oeffentlich', 'oeffentliche',
  'moeglich', 'moeglichkeit', 'moeglichkeiten', 'unmoeglich', 'ermoeglichen', 'ermoeglicht',
  'zurueck', 'rueckgaengig', 'ruecksprache', 'beruecksichtigen', 'beruecksichtigt',
  'naechste', 'naechsten', 'naechster', 'naechstes',
  'fuehren', 'fuehrt', 'ausfuehren', 'ausgefuehrt', 'durchfuehren', 'einfuehren', 'gefuehrt',
  'hoeren', 'aufhoeren', 'aufhoerst', 'gehoert', 'gehoeren',
  'laeuft', 'ablaeuft', 'laeufen',
  'loeschen', 'loescht', 'geloescht', 'loesung', 'loesen', 'geloest', 'ausloesen', 'ausloeser', 'ausloest',
  'noetig', 'benoetigt', 'benoetigen', 'benoetigte',
  'erklaeren', 'erklaert', 'erklaerung',
  'enthaelt', 'enthaelten',
  'haengt', 'haengen', 'zusammenhaengen', 'abhaengig',
  'faellt', 'faellen', 'auffaellig', 'auffaellige',
  'laesst', 'verlaesst',
  'gefaehrlich', 'ungefaehr',
  'verfuegbar', 'verfuegung', 'verfuegt',
  'waehrend',
  'zusaetzlich', 'zustaendig',
  'taeglich', 'taeglichen',
  'spaeter', 'spaetere', 'spaetestens',
  'haeufig', 'haeufige', 'haeufigste',
  'gemaess',
  'naemlich',
  'wuerde', 'wuerden', 'wuerdest',
  'duerfen', 'duerfte', 'duerften',
  'genuegt', 'genuegen', 'genuegend',
  'hoehe', 'hoeher', 'erhoehen', 'erhoeht',
  'groesse', 'groesser', 'groessen', 'vergroessern',
  'schoen', 'schoener',
  'stoeren', 'gestoert',
  'vollstaendig', 'vollstaendige', 'unvollstaendig',
  'verschluesselt', 'verschluesseln', 'entschluesselbar', 'entschluesseln',
  'fluechtig',
  'inkompatibilitaet', 'kompatibilitaet',
  'passwoerter', 'passwoertern',
  'bloecke',
  'vorwaerts', 'rueckwaerts',
  'schuetzt', 'schuetzen', 'geschuetzt',
  'schlaegt', 'vorschlaegt',
  'ploetzlich',
  'hinzugefuegt', 'hinzugefuegte', 'einfuegen', 'eingefuegt',
  'aufgeraeumt',
  'ankuendigen', 'angekuendigt',
  'zugaenge', 'zugaenglich',
  'spruenge',
  'praefix',
  'oberflaeche', 'oberflaechen',
  'kuendigen', 'gekuendigt',
  'gruen',
  'beduerftig', 'beduerfnis',
  'rueckweg', 'rueckstand',
];

// Files whose basename lists the tokens as literals -> skip to avoid self-trigger.
const EXCLUDE_BASENAME = ['umlaut-transliteration-gap'];

// German-context markers (no Umlauts themselves) so we only warn on actually-German files.
const DE_STOPWORDS = /\b(?:der|die|das|und|nicht|ist|sind|wird|werden|mit|auf|sich|oder|eine|einen|einem|dem|den|im|zum|zur|als|auch|nur|kein|keine|wenn|dann|weil|damit|muss|dass|beim|vom)\b/i;

// Only the fields carrying the JUST WRITTEN text, per tool. Everything else in
// a PostToolUse payload stays unread and is therefore not typed here.
interface TranslitPayload {
  tool_name?: unknown;
  tool_input?: {
    file_path?: unknown;
    path?: unknown;
    content?: unknown;
    new_string?: unknown;
    edits?: unknown;
  } | null;
}

interface Warning {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
  systemMessage: string;
}

// Just-written text only (not pre-existing content).
function newText(payload: TranslitPayload): string {
  const input = payload.tool_input ?? {};
  const texts: string[] = [];
  if (payload.tool_name === 'Write') {
    if (typeof input.content === 'string') texts.push(input.content);
  } else if (payload.tool_name === 'Edit') {
    if (typeof input.new_string === 'string') texts.push(input.new_string);
  } else if (payload.tool_name === 'MultiEdit') {
    if (Array.isArray(input.edits)) {
      for (const ed of input.edits as { new_string?: unknown }[]) {
        if (typeof ed?.new_string === 'string') texts.push(ed.new_string);
      }
    }
  }
  return texts.join('\n');
}

function warning(payload: TranslitPayload | null): Warning | null {
  if (!payload || !['Edit', 'Write', 'MultiEdit'].includes(String(payload.tool_name))) return null;

  const input = payload.tool_input ?? {};
  const filePath = typeof input.file_path === 'string' ? input.file_path
    : typeof input.path === 'string' ? input.path : '';

  // Only German doc surfaces. Code/config/data stay ASCII -> not our concern.
  if (!/\.(?:md|xml|txt)$/i.test(filePath)) return null;

  const base = path.basename(filePath).toLowerCase();
  if (EXCLUDE_BASENAME.some((x) => base.includes(x))) return null;

  const text = newText(payload);
  if (!text) return null;

  // Only treat as German prose if it has a German marker (stopword or a real Umlaut).
  if (!DE_STOPWORDS.test(text) && !/[äöüÄÖÜ]/.test(text)) return null;

  const hits = text.match(new RegExp('\\b(?:' + DENY.join('|') + ')\\b', 'gi'));
  if (!hits) return null;

  const unique = [...new Set(hits.map((h) => h.toLowerCase()))];
  const list = unique.slice(0, 12).join(', ') + (unique.length > 12 ? ', ...' : '');

  const msg =
    `[umlaut-translit-watch] ASCII Umlaut-Transliteration in just-written content of ${path.basename(filePath)}: ${list}.\n` +
    `Global rule "Echte Umlaute in deutschen Texten": fix ae/oe/ue -> ä/ö/ü. ` +
    `Keep ss as ss (Swiss Hochdeutsch, no ß). Do NOT touch filenames/paths/shell (those stay ASCII).`;

  return {
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
    systemMessage: `Umlaut-Transliteration in ${path.basename(filePath)}: ${list}`,
  };
}

async function main(): Promise<void> {
  try {
    const found = warning(JSON.parse((await (await import("./lib/stdin-reader.mts")).readStdinBytes({ maxBytes: null })).toString("utf8")) as TranslitPayload | null);
    if (found) process.stdout.write(JSON.stringify(found));
  } catch {
    // Fail-open: a hook that cannot answer says nothing and exits 0.
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
