import {expect,it} from 'vitest';
import {digestMcpArguments,REMOTE_MCP_CAPABILITY} from '../../protocol-mcp.mts';
import {registry,FACTS} from './helpers.mts';
import {pair} from './message-loop-fixture.mts';
import {query} from './message-retention-fixture.mts';

it('bound guarded retries compare content, address and exact origin; pruned and legacy sends refuse while status survives',async()=>{
 const {a,b}=await pair();
 await registry().updateRegistration(a,FACTS,[],['messaging.v1','messaging.ack.v1','messaging.loop-brake.v1','messaging.origin.v1']);
 const message={messageId:crypto.randomUUID(),from:{nodeId:a,session:'session'},to:{nodeId:b,session:'session'},text:'Synthetic original',senderOrigin:{nodeId:a,sentAt:'2026-01-01T00:00:00.000Z'}};
 const send=(m:typeof message)=>registry().sendMessage(m,`node:${a}`);
 const first=await send(message);expect(first.ok).toBe(true);if(!first.ok)return;
 expect(first.effects.deliveries[0].body.loop?.version).toBe(1);
 expect((await send(message)).ok).toBe(true);
 for(const patch of [{text:'changed'},{to:{...message.to,session:'other'}},{senderOrigin:undefined},{senderOrigin:{nodeId:a,sentAt:'2026-01-02T00:00:00.000Z'}}])expect((await send({...message,...patch} as typeof message)).ok).toBe(false);
 await registry().reportMessageStatus(b,{messageId:message.messageId,state:'delivered'});
 await registry().ackMessageStatus(a,{name:'message.status.ack',messageId:message.messageId,state:'delivered'});
 expect((await registry().mcpMessageStatus(a,message.messageId))?.state).toBe('delivered');
 expect((await send(message)).ok).toBe(false);
 const legacy={...message,messageId:crypto.randomUUID()};expect((await send(legacy)).ok).toBe(true);
 await query(sql=>sql.exec('UPDATE messages SET message_binding=NULL WHERE id=?',legacy.messageId));
 expect((await send(legacy)).ok).toBe(false);
});

it('MCP recovery checks the actual payload before an early successful replay',async()=>{
 const {a,b}=await pair();
 await registry().updateRegistration(a,FACTS,[{name:'codex',kind:'cli'}],['messaging.v1','messaging.ack.v1','messaging.loop-brake.v1',REMOTE_MCP_CAPABILITY]);
 const credential=await registry().rotateMcpCredential(a);if(!credential.ok)throw Error(credential.error);
 const args={to:{nodeId:b,session:'session'},text:'Synthetic MCP original'},requestId=crypto.randomUUID(),callId=crypto.randomUUID();
 const argumentsDigest=await digestMcpArguments(args);
 expect((await registry().registerMcpIntent(a,{requestId,runtime:'codex',sessionId:'session',threadId:'session',callId,tool:'send',argumentsDigest})).ok).toBe(true);
 const intent={nodeId:a,credentialVersion:credential.version,requestId,runtime:'codex' as const,sessionId:'session',threadId:'session',callId,tool:'send' as const,argumentsDigest};
 expect((await registry().sendMcpMessage(intent,args.to,args.text)).ok).toBe(true);
 expect((await registry().sendMcpMessage(intent,args.to,args.text)).ok).toBe(true);
 expect((await registry().sendMcpMessage(intent,args.to,'changed')).ok).toBe(false);
 expect((await registry().sendMcpMessage(intent,{...args.to,session:'other'},args.text)).ok).toBe(false);
});
