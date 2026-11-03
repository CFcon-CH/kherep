import {canonical,uuid,object,keys} from './target-delivery-state.mts';
import type {PreparedOriginalPort,OriginalPointerExpectation,OriginalPointerLease} from './target-resume-port.mts';
export interface OriginalPointerToken {readonly originalPointer:unique symbol}
interface LeaseState {adapter:PreparedOriginalPort;expected:string;lease:OriginalPointerLease;epoch:string;active:boolean;consumed:boolean}
const leases=new WeakMap<OriginalPointerToken,LeaseState>();
export function assertOriginalPointerLease(token:OriginalPointerToken,adapter:PreparedOriginalPort,expected:OriginalPointerExpectation):void {
 const s=leases.get(token);if(!s||!s.active||s.adapter!==adapter||s.expected!==canonical(expected)||s.lease.epoch!==s.epoch)throw Error('original pointer unavailable');
 if(s.lease.assertActive()!==undefined)throw Error('native lease check must be synchronous');
}
export function consumeOriginalPointerToken(token:OriginalPointerToken,expected:OriginalPointerExpectation):void {
 const s=leases.get(token);if(!s||s.consumed)throw Error('original pointer consumed');assertOriginalPointerLease(token,s.adapter,expected);s.consumed=true;
}
export async function withOriginalPointerExclusion<T>(adapter:PreparedOriginalPort,expected:OriginalPointerExpectation,body:(token:OriginalPointerToken,epoch:string)=>Promise<T>):Promise<T|{status:'original-processing'|'unavailable'|'unknown'}> {
 if(!adapter.withRetiredPointerFence)return {status:'unavailable'};
 let active=true,called=false,finished=false,token:OriginalPointerToken|undefined,result:T|undefined;
 try {
  const returned=await adapter.withRetiredPointerFence(structuredClone(expected),lease=>{
   if(!active||called||!lease||!uuid(lease.epoch)||typeof lease.assertActive!=='function'||lease.assertActive.constructor.name==='AsyncFunction')throw Error('native exclusion unavailable');called=true;
   token=Object.freeze({}) as OriginalPointerToken;const issued=token;leases.set(issued,{adapter,expected:canonical(expected),lease,epoch:lease.epoch,active:true,consumed:false});
   const work=Promise.resolve().then(async()=>{assertOriginalPointerLease(issued,adapter,expected);result=await body(issued,lease.epoch);finished=true;return result;}).finally(()=>{const s=leases.get(issued);if(s)s.active=false;});
   // A broken provider may return or throw without awaiting its callback. Keep
   // the continuation fenced and its rejection observed, without retrying it.
   void work.catch(()=>{});return work;
  });
  if(called&&(!finished||returned!==result))throw Error('native exclusion ended early');
  if(!called&&(!object(returned)||!keys(returned,['status'])||!['original-processing','unavailable','unknown'].includes(returned.status as string)))throw Error('native exclusion result invalid');
  return returned;
 }finally{active=false;if(token){const s=leases.get(token);if(s)s.active=false;}}
}
