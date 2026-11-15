import { createHash } from 'node:crypto';
import { fail } from './contract.mts';
export type Git = (args:string[])=>string|undefined;
/** `git cat-file --batch` output for `shas`, or undefined when git failed. */
export type Read = (shas:string[])=>Buffer|undefined;
type Commit = {tree:string; parents:string[]; author:string; committer:string};
const MAX_COMMITS = 256;
const HEX = /^[0-9a-f]{40}$/;
const IDENT = /^(author|committer) [^<>\n]*<([^<>\n]*)> \d+ [+-]\d{4}$/;
/** The body of every object in `shas`, each refused unless git echoed its name with `type` and its bytes hash to that name. */
function verified(read:Read, shas:string[], type:'commit'|'tree'):Map<string,Buffer> {
  const out=new Map<string,Buffer>(), unique=[...new Set(shas)];
  if (!unique.length) return out;
  const data=read(unique) ?? fail('target-refused');
  let at=0;
  for (const sha of unique) {
    const eol=data.indexOf(10,at), header=eol<0 ? undefined : /^([0-9a-f]{40}) ([a-z]+) (\d{1,10})$/.exec(data.toString('latin1',at,eol));
    if (!header || header[1]!==sha || header[2]!==type) fail('target-refused');
    const size=Number(header[3]), body=data.subarray(eol+1,eol+1+size);
    if (body.length!==size || data[eol+1+size]!==10 || createHash('sha1').update(`${type} ${size}\0`).update(body).digest('hex')!==sha) fail('target-refused');
    out.set(sha,body);at=eol+2+size;
  }
  if (at!==data.length) fail('target-refused');
  return out;
}
/**
 * Tree, then parents, then author, then committer, exactly. Git shows the last author and committer
 * header, so any later one is refused; other later headers (encoding, gpgsig, mergetag, whose
 * continuation lines start with a space) and the message are not read.
 */
function parseCommit(body:Buffer):Commit {
  const lines=body.toString('utf8').split('\n');
  const tree=/^tree ([0-9a-f]{40})$/.exec(lines[0] ?? '')?.[1] ?? fail('target-refused'), parents:string[]=[];
  let i=1;
  for (let m;(m=/^parent ([0-9a-f]{40})$/.exec(lines[i] ?? ''));i++) parents.push(m[1]);
  const author=IDENT.exec(lines[i] ?? ''), committer=IDENT.exec(lines[i+1] ?? '');
  if (author?.[1]!=='author' || committer?.[1]!=='committer') fail('target-refused');
  for (let j=i+2;j<lines.length && lines[j]!=='';j++) if (/^(?:author|committer) /.test(lines[j])) fail('target-refused');
  return {tree,parents,author:author[2],committer:committer[2]};
}
/** `[mode, name, sha]` of every entry of a tree body. */
function entries(body:Buffer):[string,string,string][] {
  const out:[string,string,string][]=[];
  for (let at=0;at<body.length;) {
    const space=body.indexOf(32,at), nul=space<0 ? -1 : body.indexOf(0,space+1), mode=body.toString('latin1',at,space);
    if (nul<0 || nul+21>body.length || !/^[0-7]{5,6}$/.test(mode) || nul===space+1) fail('target-refused');
    out.push([mode,body.toString('utf8',space+1,nul),body.toString('hex',nul+1,nul+21)]);at=nul+21;
  }
  return out;
}
/** Every commit reachable from `start`, refused when one is missing. */
function ancestry(commits:Map<string,Commit>, start:string):Set<string> {
  const seen=new Set<string>(), stack=[start];
  for (let sha;(sha=stack.pop())!==undefined;) {
    if (seen.has(sha)) continue;
    seen.add(sha);stack.push(...(commits.get(sha) ?? fail('target-refused')).parents);
  }
  return seen;
}
/**
 * Bot authorship and the workflow check of a push, from hash-verified bytes only: git does not verify an
 * object's hash on read, so it only lists and fetches objects here. Every commit reachable from sha but
 * not from base must carry an allowed bot email as author and committer and must leave `.github/workflows`
 * as every parent had it; the remote branch tip `current` must be an ancestor of sha (fast-forward).
 */
export function checkRange(git:Git, read:Read, {sha, base, current, emails}:{sha:string; base:string; current?:string; emails:string[]}):void {
  const listed=git(['rev-list',sha,base,...(current?[current]:[])])?.split('\n');
  if (!listed?.every(line=>HEX.test(line))) fail('target-refused');
  const commits=new Map([...verified(read,listed,'commit')].map(([k,v])=>[k,parseCommit(v)]));
  const known=ancestry(commits,base), reachable=ancestry(commits,sha), added=[...reachable].filter(c=>!known.has(c));
  if (added.length>MAX_COMMITS || current && !reachable.has(current)) fail('target-refused');
  const commit=(c:string)=>commits.get(c)!;
  for (const c of added) { const {author,committer}=commit(c); if (![author,committer].every(e=>emails.includes(e.toLowerCase()))) fail('target-refused'); }
  const roots=verified(read,added.flatMap(c=>[c,...commit(c).parents]).map(c=>commit(c).tree),'tree');
  const github=(c:string)=>entries(roots.get(commit(c).tree)!).filter(([,name])=>name.toLowerCase()==='.github');
  const subtrees=verified(read,[...roots.values()].flatMap(body=>entries(body).filter(([mode,name])=>mode==='40000' && name.toLowerCase()==='.github').map(([,,s])=>s)),'tree');
  // A non-tree `.github` entry counts with its own sha.
  const signature=(c:string)=>github(c).flatMap(([mode,name,s])=>mode==='40000'
    ? entries(subtrees.get(s)!).filter(([,n])=>n.toLowerCase()==='workflows').map(([m,n,x])=>`${name}/${n} ${m} ${x}`)
    : [`${name} ${mode} ${s}`]).sort().join('\n');
  for (const c of added) {
    const own=signature(c), parents=commit(c).parents;
    if ((parents.length ? parents.map(signature) : ['']).some(s=>s!==own)) fail('target-refused');
  }
}
