import { credentialEntry, startCredential } from './credential.mts';
export const run = credentialEntry('codex');
await startCredential('codex',import.meta.url);
