import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
/** The one checked import closure consumed by both installer transactions. */
export function githubBrokerFiles(repo:string):string[] {
  const root=path.join(repo,'modules','github-broker'), seen=new Set<string>();
  function visit(name:string):void {
    if (seen.has(name)) return;
    if (!/^[a-z-]+\.mts$/.test(name)) throw new Error('github-broker-invalid-source');
    const file=path.join(root,name),stat=fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('github-broker-invalid-source');
    seen.add(name);
    const source=fs.readFileSync(file,'utf8');
    for(const [,specifier] of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      if(specifier.startsWith('node:')) continue;
      if (!/^\.\/[a-z-]+\.mts$/.test(specifier)) throw new Error('github-broker-invalid-import');
      visit(specifier.slice(2));
    }
  }
  visit('github-claude.mts');visit('github-codex.mts');
  // Entrypoints install last. Enumeration completes before the first copy.
  return [...seen].sort((a,b)=>Number(a.startsWith('github-'))-Number(b.startsWith('github-'))||a.localeCompare(b));
}
export function copyGithubBroker(repo:string, workspace:string, transaction:{copyFile:(source:string,target:string)=>string}):string[] {
  return githubBrokerFiles(repo).map(name=>transaction.copyFile(path.join(repo,'modules','github-broker',name),path.join(workspace,'tools','github-broker',name)));
}
function isMainModule(url: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return url === pathToFileURL(path.resolve(entry)).href
      || url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}
if (isMainModule(import.meta.url)) {
  if(process.argv.length!==3) process.exitCode=1;
  else process.stdout.write(`${githubBrokerFiles(process.argv[2]).join('\n')}\n`);
}
