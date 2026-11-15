import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
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
