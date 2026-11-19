// Preloaded with `node --import` into a bootstrap step under test, so the step
// takes its terminal branch while fd 0 stays the plain pipe the test writes
// to. Only process.stdin is replaced, and only its isTTY flag and setRawMode;
// the step still reads fd 0 itself with fs.readSync. The real stdin stream is
// never created, so fd 0 stays blocking and each read waits for the test.
//
// Every setRawMode call is recorded and, when TERMINAL_PRELOAD_LOG names a
// file, written there on exit: a test can then prove that raw mode was
// switched off again even on the paths that end the process.
import fs from "node:fs";

const rawModes: boolean[] = [];
const terminal = {
  isTTY: true,
  setRawMode(mode: boolean) {
    rawModes.push(mode);
    return terminal;
  },
};

Object.defineProperty(process, "stdin", { configurable: true, enumerable: true, value: terminal });

process.on("exit", () => {
  const log = process.env.TERMINAL_PRELOAD_LOG;
  if (log) fs.writeFileSync(log, JSON.stringify(rawModes));
});
