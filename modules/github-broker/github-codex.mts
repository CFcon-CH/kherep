import { entry, start } from './cli.mts';
export const run = entry('codex');
await start('codex',import.meta.url);
