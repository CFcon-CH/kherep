import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import { spawnSync } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

async function reader() {
  return (await import("./stdin-reader.mts")).readStdinBytes;
}

const code = (value: string) => (error: unknown): boolean => {
  assert.equal((error as { code?: string }).code, value);
  return true;
};
const counts = (input: Readable) => ["data", "end", "error", "close"].map(event => input.listenerCount(event));

test("stdin reader preserves complete raw bytes, including split UTF-8, invalid bytes and BOM", async () => {
  const read = await reader();
  const bytes = Buffer.concat([Buffer.from("\ufeffa\0ü€😀\r\n"), Buffer.from([0xff, 0xc3])]);
  const chunks = Array.from(bytes, value => Buffer.from([value]));
  const input = Readable.from(chunks, { objectMode: false });
  const before = counts(input);
  const result = await read({ maxBytes: null }, input);
  assert.deepEqual(result, bytes);
  assert.equal(result.toString("utf8"), bytes.toString("utf8"));
  assert.deepEqual(counts(input), before);
});

test("stdin reader accepts empty, exact and below-cap bytes and drains overflow before rejecting", async t => {
  const read = await reader();
  for (const [size, limit] of [[0, 0], [0, 3], [2, 3], [3, 3], [65_700, 65_700]]) {
    await t.test(`${size}/${limit}`, async () => {
      assert.deepEqual(await read({ maxBytes: limit! }, Readable.from([Buffer.alloc(size!, 97)], { objectMode: false })), Buffer.alloc(size!, 97));
    });
  }
  const input = new PassThrough({ autoDestroy: false });
  let settled = false;
  const result = read({ maxBytes: 3 }, input).finally(() => { settled = true; });
  const failure = assert.rejects(result, code("STDIN_LIMIT_EXCEEDED"));
  input.write(Buffer.alloc(65_700));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "overflow still waits for EOF");
  input.end("tail");
  await failure;
  assert.equal(input.readableEnded, true);
  assert.equal(input.destroyed, false, "borrowed stream is not destroyed by the helper");
});

test("stdin reader handles zero-cap overflow and copies reusable input chunks", async () => {
  const read = await reader();
  await assert.rejects(read({ maxBytes: 0 }, Readable.from([Buffer.from([1])], { objectMode: false })), code("STDIN_LIMIT_EXCEEDED"));
  const input = new PassThrough({ autoDestroy: false });
  const result = read({ maxBytes: null }, input);
  const bytes = Buffer.from("safe");
  input.write(bytes);
  bytes.fill(0);
  input.end();
  assert.equal((await result).toString(), "safe");
});

test("stdin reader rejects invalid options before consuming the source", async () => {
  const read = await reader();
  for (const options of [{}, null, undefined]) {
    const input = new PassThrough({ autoDestroy: false });
    await assert.rejects(read(options as never, input), code("STDIN_INVALID_OPTIONS"));
    assert.equal(input.readableFlowing, null);
    input.destroy();
  }
  for (const maxBytes of [undefined, -1, NaN, Infinity, 1.5, bufferConstants.MAX_LENGTH + 1]) {
    const input = new PassThrough({ autoDestroy: false });
    const before = counts(input);
    await assert.rejects(read({ maxBytes } as never, input), code("STDIN_INVALID_OPTIONS"));
    assert.deepEqual(counts(input), before);
    assert.equal(input.readableFlowing, null);
    input.destroy();
  }
});

test("stdin reader rejects encoded, object-mode and already-consumed sources", async () => {
  const read = await reader();
  const encoded = new PassThrough(); encoded.setEncoding("utf8");
  const objects = Readable.from([{ secret: "synthetic" }]);
  const consumed = new PassThrough(); consumed.on("data", () => {});
  const paused = new PassThrough(); paused.on("data", () => {}); paused.pause();
  const readable = new PassThrough(); readable.on("readable", () => {});
  for (const input of [encoded, objects, consumed, paused, readable]) {
    await assert.rejects(read({ maxBytes: null }, input), code("STDIN_INVALID_SOURCE"));
    input.destroy();
  }
});

test("stdin reader rejects concurrent consumers, retaining another owner's listeners", async () => {
  const read = await reader();
  const input = new PassThrough({ autoDestroy: false });
  const ownerError = () => {};
  input.on("error", ownerError);
  const before = counts(input);
  const first = read({ maxBytes: null }, input);
  await assert.rejects(read({ maxBytes: null }, input), code("STDIN_INVALID_SOURCE"));
  input.end("done");
  assert.equal((await first).toString(), "done");
  assert.deepEqual(counts(input), before);
  assert.equal(input.listeners("error")[0], ownerError);
  assert.equal((await read({ maxBytes: null }, input)).length, 0);
});

test("stdin read errors win over pending overflow and never expose source error text or paths", async () => {
  const read = await reader();
  for (const overflow of [false, true]) {
    const input = new PassThrough({ autoDestroy: false });
    const before = counts(input);
    const result = read({ maxBytes: overflow ? 0 : null }, input);
    if (overflow) input.write("payload");
    const failure = assert.rejects(result, (error: unknown) => {
      const value = error as Error & { code: string; systemCode?: string; cause?: unknown };
      assert.equal(value.code, "STDIN_READ_FAILED");
      assert.equal(value.systemCode, "EIO");
      assert.equal(value.cause, undefined);
      assert.doesNotMatch(String(value), /SYNTHETIC_PRIVATE|payload/);
      return true;
    });
    input.emit("error", Object.assign(new Error("SYNTHETIC_PRIVATE/path payload"), { code: "EIO" }));
    await failure;
    assert.deepEqual(counts(input), before);
    assert.equal(input.destroyed, false);
    input.destroy();
  }
});

test("stdin reader handles ended, errored and owner-closed input without owning its lifetime", async () => {
  const read = await reader();
  const ended = new PassThrough({ autoDestroy: false }); ended.resume(); ended.end();
  await new Promise(resolve => ended.on("end", resolve));
  assert.deepEqual(await read({ maxBytes: null }, ended), Buffer.alloc(0));
  const errored = new PassThrough(); errored.on("error", () => {}); errored.destroy(new Error("synthetic"));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(read({ maxBytes: null }, errored), code("STDIN_READ_FAILED"));
  const open = new PassThrough({ autoDestroy: false });
  let settled = false;
  const result = read({ maxBytes: null }, open).finally(() => { settled = true; });
  const failure = assert.rejects(result, code("STDIN_PREMATURE_CLOSE"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  open.destroy();
  await failure;
  assert.deepEqual(counts(open), [0, 0, 0, 0]);
});

test("invalid runtime sources and later non-byte chunks fail without exposing arbitrary system codes", async () => {
  const read = await reader();
  await assert.rejects(read({ maxBytes: null }, {} as Readable), code("STDIN_INVALID_SOURCE"));
  const closed = new PassThrough(); closed.destroy();
  await assert.rejects(read({ maxBytes: null }, closed), code("STDIN_PREMATURE_CLOSE"));
  const input = new PassThrough({ autoDestroy: false });
  const failure = assert.rejects(read({ maxBytes: null }, input), code("STDIN_INVALID_SOURCE"));
  input.emit("data", "not bytes");
  await failure;
  input.destroy();
  const privateError = new PassThrough({ autoDestroy: false });
  const rejected = assert.rejects(read({ maxBytes: null }, privateError), (error: unknown) => {
    assert.equal((error as { code: string }).code, "STDIN_READ_FAILED");
    assert.equal((error as { systemCode?: string }).systemCode, undefined);
    assert.doesNotMatch(String(error), /SYNTHETIC_PRIVATE/);
    return true;
  });
  privateError.emit("error", { code: "SYNTHETIC_PRIVATE", message: "SYNTHETIC_PRIVATE" });
  await rejected;
  privateError.destroy();
});

test("a throwing error-code accessor cannot escape the fixed read failure or retain listeners", async () => {
  const read = await reader();
  const input = new PassThrough({ autoDestroy: false });
  const before = counts(input);
  const failure = assert.rejects(read({ maxBytes: null }, input), code("STDIN_READ_FAILED"));
  const sourceError = Object.defineProperty({}, "code", { get() { throw new Error("SYNTHETIC_PRIVATE_ACCESSOR"); } });
  let escaped: unknown;
  try { input.emit("error", sourceError); }
  catch (error) { escaped = error; input.emit("error", {}); }
  await failure;
  assert.equal(escaped, undefined);
  assert.deepEqual(counts(input), before);
  input.destroy();
});

test("stdin reader starts a caller-paused source without requiring an owner resume", async () => {
  const read = await reader();
  const input = new PassThrough({ autoDestroy: false });
  input.pause();
  const before = counts(input);
  let settled = false;
  const result = read({ maxBytes: null }, input).finally(() => { settled = true; });
  input.end("paused bytes");
  await new Promise(resolve => setImmediate(resolve));
  const completedWithoutOwnerResume = settled;
  // Release a broken candidate so the regression fails promptly instead of hanging.
  if (!settled) input.resume();
  try {
    assert.equal((await result).toString(), "paused bytes");
    assert.equal(completedWithoutOwnerResume, true);
    assert.deepEqual(counts(input), before);
    assert.equal(input.destroyed, false);
  } finally { input.destroy(); }
});

for (const initiallyPaused of [false, true]) test(`a resume failure on ${initiallyPaused ? "paused" : "fresh"} input rejects privately and permits a later read`, async () => {
  const read = await reader();
  const input = new PassThrough({ autoDestroy: false });
  if (initiallyPaused) input.pause();
  const before = counts(input);
  const originalResume = input.resume;
  let calls = 0;
  let countsAtResume: number[] | undefined;
  input.resume = function () {
    calls++;
    countsAtResume = counts(input);
    throw new Error("SYNTHETIC_PRIVATE_RESUME");
  };
  const result = read({ maxBytes: null }, input).then(() => undefined, error => error as Error & { code: string });
  try {
    await new Promise(resolve => setImmediate(resolve));
    // Settle an old candidate that never attempts resume; keep the verdict below.
    if (calls === 0) input.emit("error", new Error("SYNTHETIC_PRIVATE_NOT_STARTED"));
    const value = await result;
    assert.ok(value);
    assert.equal(value.code, "STDIN_READ_FAILED");
    assert.equal(value.message, "stdin could not be read");
    assert.equal(Object.hasOwn(value, "cause"), false);
    assert.doesNotMatch(String(value) + JSON.stringify(value), /SYNTHETIC_PRIVATE/);
  } finally { input.resume = originalResume; }
  try {
    assert.equal(calls, 1);
    assert.deepEqual(countsAtResume, before.map(count => count + 1), "all listeners precede explicit resume");
    assert.deepEqual(counts(input), before);
    assert.equal(input.destroyed, false);
    const again = read({ maxBytes: null }, input);
    input.end("resumed later");
    assert.equal((await again).toString(), "resumed later");
    assert.deepEqual(counts(input), before);
  } finally { input.destroy(); }
});

test("a synchronous startup error cannot resume the source after releasing it", async () => {
  const read = await reader();
  const input = new PassThrough({ autoDestroy: false });
  const ownerError = () => {};
  input.on("error", ownerError);
  const before = counts(input);
  const originalResume = input.resume;
  let starts = 0;
  input.resume = function () {
    starts++;
    if (starts === 1) {
      input.emit("error", Object.assign(new Error("SYNTHETIC_PRIVATE_START"), { code: "EIO" }));
      return this;
    }
    return Reflect.apply(originalResume, this, []);
  };
  try {
    await assert.rejects(read({ maxBytes: null }, input), (error: unknown) => {
      const value = error as Error & { code: string; systemCode?: string };
      assert.equal(value.code, "STDIN_READ_FAILED");
      assert.equal(value.systemCode, "EIO");
      assert.equal(value.message, "stdin could not be read");
      assert.equal(Object.hasOwn(value, "cause"), false);
      assert.doesNotMatch(String(value) + JSON.stringify(value), /SYNTHETIC_PRIVATE/);
      return true;
    });
  } finally { input.resume = originalResume; }
  try {
    assert.equal(starts, 1, "settlement must prevent a second startup resume");
    assert.equal(input.readableFlowing, false);
    assert.deepEqual(counts(input), before);
    assert.equal(input.listeners("error")[0], ownerError);
    assert.equal(input.destroyed, false);
    const again = read({ maxBytes: null }, input);
    input.end("recovered");
    assert.equal((await again).toString(), "recovered");
    assert.deepEqual(counts(input), before);
  } finally { input.destroy(); }
});

// Allocation faults are confined to a child; normal stream events exercise the
// real helper, including cleanup and a second read after the failure.
const isolatedFailureProgram = String.raw`
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
const { readStdinBytes: read } = await import(HELPER_URL);
const scenario = SCENARIO;
const input = new PassThrough({ autoDestroy: false });
const marker = "SYNTHETIC_PRIVATE_ALLOCATION_PAYLOAD";
const sentinel = Buffer.from(marker);
const originalFrom = Buffer.from, originalConcat = Buffer.concat;
const ownerError = () => {};
input.on("error", ownerError);
const counts = () => ["data", "end", "error", "close"].map(name => input.listenerCount(name));
let eofReports = 0, failedAtEof = false, finalConcatsAfterFailure = 0;
if (scenario === "settled-eof") input.on("end", () => {
  eofReports++;
  failedAtEof = true;
  input.emit("error", Object.assign(new Error(marker), { code: "EIO" }));
});
const before = counts();
const originalPause = input.pause;
let pauses = 0, hits = 0;
if (scenario === "settled-reject") input.pause = function () {
  pauses++;
  return Reflect.apply(originalPause, this, []);
};
const result = read({ maxBytes: null }, input).then(
  value => ({ value }), error => ({ error }),
);
try {
  if (scenario === "copy") {
    Buffer.from = function (...args) {
      if (args[0] === sentinel) { hits++; throw new Error(marker); }
      return Reflect.apply(originalFrom, this, args);
    };
    try { input.write(sentinel); await result; }
    finally { Buffer.from = originalFrom; }
  } else if (scenario === "concat") {
    input.write(sentinel);
    Buffer.concat = function (...args) {
      if (args[1] === sentinel.length && args[0].length === 1 && args[0][0].equals(sentinel)) {
        hits++; throw new Error(marker);
      }
      return Reflect.apply(originalConcat, this, args);
    };
    try { input.end(); await result; }
    finally { Buffer.concat = originalConcat; }
  } else if (scenario === "settled-reject") {
    const inner = Object.assign(new Error(marker), { code: "EIO" });
    const outer = Object.defineProperty(new Error(marker), "code", { get() {
      hits++;
      assert.equal(hits, 1, "error accessor reenters exactly once");
      input.emit("error", inner);
      return "ENOMEM";
    } });
    try { assert.doesNotThrow(() => input.emit("error", outer)); await result; }
    finally { input.pause = originalPause; }
  } else {
    Buffer.concat = function (...args) {
      if (failedAtEof && args[1] === sentinel.length) finalConcatsAfterFailure++;
      return Reflect.apply(originalConcat, this, args);
    };
    try { input.end(sentinel); await result; }
    finally { Buffer.concat = originalConcat; }
  }
  assert.equal(Buffer.from, originalFrom);
  assert.equal(Buffer.concat, originalConcat);
  assert.equal(input.pause, originalPause);
  const outcome = await result;
  assert.ok(outcome.error, "the injected failure must reject, not return partial bytes");
  const error = outcome.error;
  assert.equal(error.code, "STDIN_READ_FAILED");
  assert.equal(error.message, "stdin could not be read");
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal(Object.hasOwn(error, "limitBytes"), false);
  assert.equal(error.systemCode, scenario.startsWith("settled-") ? "EIO" : undefined);
  assert.doesNotMatch(String(error) + JSON.stringify(error), /SYNTHETIC_PRIVATE|ALLOCATION_PAYLOAD/);
  assert.deepEqual(counts(), before);
  assert.equal(input.listeners("error")[0], ownerError);
  assert.equal(input.destroyed, false, "the helper never destroys its borrowed stream");
  if (scenario === "settled-eof") {
    assert.equal(eofReports, 1);
    assert.equal(finalConcatsAfterFailure, 0, "a stale EOF callback must not concatenate after rejection");
  } else assert.equal(hits, 1, "the fault must target the actual allocation or accessor");
  if (scenario === "settled-reject") assert.equal(pauses, 1, "settlement releases the source only once");
  if (scenario === "copy" || scenario === "settled-reject") {
    assert.equal(input.readableFlowing, false);
    const again = read({ maxBytes: null }, input);
    input.end(Buffer.from("reused"));
    assert.equal((await again).toString(), "reused");
  } else assert.equal((await read({ maxBytes: null }, input)).length, 0);
  assert.deepEqual(counts(), before);
  process.stdout.write("OK " + scenario + "\n");
} finally {
  Buffer.from = originalFrom;
  Buffer.concat = originalConcat;
  input.pause = originalPause;
  input.destroy();
}
`;

for (const [scenario, name] of [
  ["copy", "copy failure rejects with a fixed private-safe error and releases the borrowed reader"],
  ["concat", "final allocation failure releases listeners without leaking partial bytes"],
  ["settled-reject", "a reentrant error-code accessor cannot replace the first settled error"],
  ["settled-eof", "an EOF observer's validation error wins over the pending EOF callback"],
]) {
  test(name!, () => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "SYSTEMROOT", "NODE_V8_COVERAGE"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const program = isolatedFailureProgram
      .replace("HELPER_URL", JSON.stringify(new URL("./stdin-reader.mts", import.meta.url).href))
      .replace("SCENARIO", JSON.stringify(scenario));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `OK ${scenario}\n`);
    // Older supported Node releases warn about type stripping on stderr.
    const diagnostics = result.stderr.replace(/\(node:\d+\) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\r?\n/g, "")
      .replace(/\(Use .+?--trace-warnings.+?\)\r?\n/g, "");
    assert.equal(diagnostics, "");
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE|ALLOCATION_PAYLOAD/);
  });
}
