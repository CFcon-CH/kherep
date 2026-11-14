#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const subject = path.join(import.meta.dirname, 'prepare-secrets.mts');
type Secrets = Record<string, Buffer>;
const baseline = (): Secrets => ({ mcp_json: Buffer.from('{"mcpServers":{}}\n') });
const yamlFor = (values: Secrets): Buffer => Buffer.from(`data:\n${Object.entries(values).map(([key, value]) => `  ${key}: ${value.toString('base64')}`).join('\n')}\n`);
const invoke = (outDir: string, yaml: Buffer) => spawnSync(process.execPath, [subject, outDir], { input: yaml, encoding: 'utf8' });
let passed = 0;
function test(name: string, fn: (root: string) => void): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kherep-prepare-secrets-'));
    try {
        fn(root);
        passed++;
        process.stdout.write(`PASS ${name}\n`);
    }
    catch (error) {
        process.stderr.write(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
    finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
function rejected(root: string, values: Secrets, pattern: RegExp, yaml = yamlFor(values)): void {
    const outDir = path.join(root, 'out'), result = invoke(outDir, yaml);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.equal(fs.existsSync(outDir), false);
}
test('materializes only retained outputs with exact bytes and protected POSIX modes', root => {
    const values = { mcp_json: Buffer.from('{\r\n "mcpServers":{}\r\n}\r\n') };
    const out = path.join(root, 'out'), result = invoke(out, yamlFor(values));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(out).sort(), ['mcp.json']);
    for (const [name, bytes] of [['mcp.json', values.mcp_json]] as const)
        assert.deepEqual(fs.readFileSync(path.join(out, name)), bytes);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(out).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(out, 'mcp.json')).mode & 0o777, 0o600);
    }
});
test('rejects non-canonical base64 before output', root => { const values = baseline(), yaml = Buffer.from(yamlFor(values).toString().replace(values.mcp_json.toString('base64'), values.mcp_json.toString('base64') + '=')); rejected(root, values, /non-canonical base64.*mcp_json/, yaml); });
test('rejects invalid UTF-8 JSON before output', root => { const values = baseline(); values.mcp_json = Buffer.from([0xc3, 0x28]); rejected(root, values, /mcp_json is not valid UTF-8/); });
test('rejects malformed MCP JSON', root => { const values = baseline(); values.mcp_json = Buffer.from('{'); rejected(root, values, /mcp_json is not valid JSON/); });
test('rejects non-object MCP JSON', root => { const values = baseline(); values.mcp_json = Buffer.from('[]'); rejected(root, values, /mcp_json must contain a JSON object/); });
test('rejects missing retained fields and duplicate required fields', root => { const values = baseline(); delete values.mcp_json; rejected(root, values, /missing or empty decrypted secret key/); const full = baseline(), yaml = Buffer.concat([yamlFor(full), Buffer.from(`  mcp_json: ${full.mcp_json.toString('base64')}\n`)]); rejected(root, full, /duplicate decrypted secret key/, yaml); });
test('does not materialize unrelated obsolete bundle fields', root => { const values = { ...baseline(), obsolete_payload: Buffer.from('synthetic-unused') }, out = path.join(root, 'out'); assert.equal(invoke(out, yamlFor(values)).status, 0); assert.equal(fs.readdirSync(out).length, 1); });
test('requires an explicit output directory', root => { const result = spawnSync(process.execPath, [subject], { input: yamlFor(baseline()), encoding: 'utf8' }); assert.equal(result.status, 2); assert.match(result.stderr, /usage: prepare-secrets\.mts OUT_DIR/); assert.deepEqual(fs.readdirSync(root), []); });
test('refuses an existing output directory without changing any bytes', root => { const values = baseline(), out = path.join(root, 'out'); assert.equal(invoke(out, yamlFor(values)).status, 0); const before = new Map(fs.readdirSync(out).map(name => [name, fs.readFileSync(path.join(out, name))])); values.mcp_json = Buffer.from('{"changed":true}\n'); const result = invoke(out, yamlFor(values)); assert.notEqual(result.status, 0); assert.match(result.stderr, /EEXIST/); assert.deepEqual(fs.readdirSync(out).sort(), [...before.keys()].sort()); for (const [name, bytes] of before)
    assert.deepEqual(fs.readFileSync(path.join(out, name)), bytes); });
// Issue #906: a value line is indent, key, blanks and one blank-free value; any other form is ignored.
const yamlLine = (line: string): Buffer => Buffer.from(`data:\n${line}\n`);
test('reads a value line with tabs, trailing blanks or CRLF', root => { ['  mcp_json: e30=', '\tmcp_json:\te30=  \r'].forEach((line, index) => {
    const out = path.join(root, `out${index}`), result = invoke(out, yamlLine(line));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(out, 'mcp.json'), 'utf8'), '{}');
}); });
test('ignores an empty, inner-blank or unindented value line, a long one in linear time', root => {
    // The bound is on the time beyond the last short line, so the CLI start-up does not count (#914).
    let control = 0;
    for (const line of ['  mcp_json:', '  mcp_json: e30= x', 'mcp_json: e30=', ` mcp_json:${' '.repeat(50_000)}a${' '.repeat(50_000)}b`]) {
        const started = performance.now();
        rejected(root, {}, /missing or empty decrypted secret key: mcp_json/, yamlLine(line));
        const elapsed = performance.now() - started;
        if (line.length < 100) { control = elapsed; continue; }
        assert.ok(elapsed - control < 2000, `${line.length} characters took ${(elapsed - control).toFixed(0)} ms beyond a short line`);
    }
});
if (!process.exitCode)
    process.stdout.write(`prepare-secrets: ${passed}/${passed} passed\n`);
