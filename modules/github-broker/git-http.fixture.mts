// Test fixture only: a loopback smart-HTTP Git server through `git http-backend`.
// It answers 401 until a request carries Basic credentials with the expected
// synthetic password, so a push succeeds only through a credential helper.
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
export type GitServer = {url:(slug:string)=>string; close:()=>Promise<void>; authorized:string[]; refused:number};
export async function gitServer(projectRoot:string, password:string):Promise<GitServer> {
  const state={authorized:[] as string[],refused:0};
  const server=http.createServer((req,res)=>{
    const header=req.headers.authorization??'';
    const decoded=header.startsWith('Basic ')?Buffer.from(header.slice(6),'base64').toString('utf8'):'';
    const split=decoded.indexOf(':');
    if(split<0||decoded.slice(split+1)!==password) {
      state.refused++;res.writeHead(401,{'WWW-Authenticate':'Basic realm="synthetic"'});res.end();return;
    }
    state.authorized.push(decoded.slice(0,split));
    const url=new URL(req.url??'/','http://127.0.0.1');
    const child=spawn('git',['http-backend'],{windowsHide:true,env:{...process.env,GIT_PROJECT_ROOT:projectRoot,GIT_HTTP_EXPORT_ALL:'1',
      PATH_INFO:decodeURIComponent(url.pathname),QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method??'GET',
      CONTENT_TYPE:req.headers['content-type']??'',HTTP_CONTENT_ENCODING:String(req.headers['content-encoding']??''),
      REMOTE_USER:decoded.slice(0,split),REMOTE_ADDR:'127.0.0.1',GIT_HTTP_MAX_REQUEST_BUFFER:'100M'}});
    const out:Buffer[]=[];
    child.stdout.on('data',(c:Buffer)=>out.push(c));child.stderr.resume();
    req.pipe(child.stdin);
    child.on('close',()=>{
      const all=Buffer.concat(out);let end=all.indexOf('\r\n\r\n'),skip=4;
      if(end<0){end=all.indexOf('\n\n');skip=2;}
      const headers=all.subarray(0,Math.max(end,0)).toString('utf8').split(/\r?\n/).filter(Boolean);
      let status=200;const fields:Record<string,string>={};
      for(const line of headers){const i=line.indexOf(':');const k=line.slice(0,i).trim(),v=line.slice(i+1).trim();if(k.toLowerCase()==='status')status=Number.parseInt(v,10);else fields[k]=v;}
      res.writeHead(status,fields);res.end(end<0?all:all.subarray(end+skip));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  return {
    url:slug=>`http://127.0.0.1:${port}/${slug}.git`,
    close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}),
    get authorized(){return state.authorized;},
    get refused(){return state.refused;},
  };
}
