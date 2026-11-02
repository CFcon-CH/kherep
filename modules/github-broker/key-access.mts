import fs from 'node:fs';
import path from 'node:path';
import { fail } from './contract.mts';
import { checkWindowsAccess } from './windows-access.mts';
export function protectedDirectory(directory:string, privateRoot:string=directory):void {
  try {
    const leaf=fs.lstatSync(directory);
    if (!leaf.isDirectory() || leaf.isSymbolicLink()) fail('key-access-denied');
    if (process.platform==='win32') {
      checkWindowsAccess(directory,privateRoot);
      return;
    }
    if (leaf.uid!==process.getuid?.() || leaf.mode & 0o077) fail('key-access-denied');
    let current=directory;
    for (let depth=0;depth<64;depth++) {
      const stat=fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0,process.getuid?.()].includes(stat.uid)) fail('key-access-denied');
      // A root-owned sticky temporary ancestor cannot remove another owner's
      // private child. Other writable ancestors permit path substitution.
      if (stat.mode & 0o022 && !(stat.uid===0 && stat.mode & 0o1000)) fail('key-access-denied');
      const parent=path.dirname(current);
      if (parent===current) return;
      current=parent;
    }
    fail('key-access-denied');
  } catch {fail('key-access-denied');}
}
function sameFile(a:fs.Stats,b:fs.Stats):boolean {
  return b.isFile() && b.nlink===1 && a.ino===b.ino && a.dev===b.dev && a.size===b.size && a.uid===b.uid && a.mode===b.mode && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;
}
export function readProtectedSync(root:string, relative:string, max:number, privateRoot:string=root):Buffer {
  let fd:number|undefined;
  try {
    if (!/^[A-Za-z0-9_.-]+$/.test(relative) || relative==='.' || relative==='..') fail('key-access-denied');
    protectedDirectory(root,privateRoot);
    const file=path.join(root,relative),before=fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size>max || before.size<1 || before.nlink!==1) fail('key-access-denied');
    if (process.platform==='win32') checkWindowsAccess(file,privateRoot);
    else if (before.uid!==process.getuid?.() || before.mode & 0o077) fail('key-access-denied');
    fd=fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
    if (!sameFile(before,fs.fstatSync(fd))) fail('key-access-denied');
    const buffer=Buffer.alloc(max+1),bytes=fs.readSync(fd,buffer,0,buffer.length,0);
    if (bytes>max || bytes!==before.size || !sameFile(before,fs.fstatSync(fd)) || !sameFile(before,fs.lstatSync(file))) fail('key-access-denied');
    if (process.platform==='win32') checkWindowsAccess(file,privateRoot);
    return buffer.subarray(0,bytes);
  } catch {return fail('key-access-denied');}
  finally {if(fd!==undefined) fs.closeSync(fd);}
}
export async function readProtected(root:string, relative:string, max:number, privateRoot:string=root):Promise<Buffer> {
  return readProtectedSync(root,relative,max,privateRoot);
}
