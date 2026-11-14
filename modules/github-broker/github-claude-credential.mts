import { credentialEntry, startCredential } from './credential.mts';
export const run = credentialEntry('claude');
await startCredential('claude',import.meta.url);
