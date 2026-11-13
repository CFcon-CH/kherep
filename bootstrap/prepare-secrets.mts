#!/usr/bin/env node
// Read decrypted SOPS YAML from stdin, validate the complete required payload
// in memory, and only then materialize protected preflight files.

import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { isRecord } from "./shape.mts";

const outDir = process.argv[2];
if (process.argv.length !== 3 || !outDir) {
  console.error("usage: prepare-secrets.mts OUT_DIR");
  process.exit(2);
}

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    // Preserve a BOM as U+FEFF so JSON/shebang validation cannot approve bytes
    // that downstream consumers would interpret differently.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
};

const yaml = decodeUtf8(fs.readFileSync(0), 'decrypted SOPS YAML');
const required = ['mcp_json'];
const encoded = new Map<string, string>();
for (const line of yaml.split(/\r?\n/)) {
  const match = line.trimEnd().match(/^\s+(mcp_json):\s*(\S*)$/);
  if (!match) continue;
  if (encoded.has(match[1])) throw new Error(`duplicate decrypted secret key: ${match[1]}`);
  encoded.set(match[1], match[2]);
}

const decoded: Record<string, Buffer> = {};
for (const key of required) {
  const value = encoded.get(key);
  if (!value) throw new Error(`missing or empty decrypted secret key: ${key}`);
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`non-canonical base64 for decrypted secret key: ${key}`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) {
    throw new Error(`invalid or empty decoded secret key: ${key}`);
  }
  decoded[key] = bytes;
}

const decodedText: Record<string, string> = {};
for (const key of required) {
  const text = decodeUtf8(decoded[key], `decrypted ${key}`);
  if (text.includes('\0')) throw new Error(`decrypted ${key} must not contain NUL bytes`);
  if (!text.trim()) throw new Error(`decrypted ${key} must contain non-whitespace text`);
  decodedText[key] = text;
}

let mcp: unknown;
try { mcp = JSON.parse(decodedText.mcp_json); }
catch { throw new Error('decrypted mcp_json is not valid JSON'); }
if (!isRecord(mcp)) {
  throw new Error('decrypted mcp_json must contain a JSON object');
}

// The caller supplies an existing protected parent. Requiring a fresh leaf
// prevents retries or attacker-planted files from being silently reused.
fs.mkdirSync(outDir, { mode: 0o700 });
fs.chmodSync(outDir, 0o700);
const writeExclusive = (name: string, bytes: Uint8Array, mode: number): void => {
  const target = path.join(outDir, name);
  const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  }
  finally { fs.closeSync(fd); }
};
writeExclusive('mcp.json', decoded.mcp_json, 0o600);
