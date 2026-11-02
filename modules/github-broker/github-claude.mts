import { entry, start } from './cli.mts';
export const run = entry('claude');
await start('claude',import.meta.url);
