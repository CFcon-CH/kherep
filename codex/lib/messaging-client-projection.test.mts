import assert from "node:assert/strict";
import test from "node:test";

import path from "node:path";

import { command, render, type RenderOptions } from "./parity-config.mts";

const MATCHER = "^mcp__kherep_messaging__(sessions|send|inbox|reply|status)$";

function options(enabled: boolean): RenderOptions {
  return {
    contextHook: "/codex/hooks/context.mts", hookDir: "/codex/hooks/kherep", mcpServers: [],
    node: "/usr/bin/node", messagingClient: { enabled,
      bridge: "/codex/orchestra/control-plane/node/mcp-stdio-bridge.mts",
      intentHook: "/codex/orchestra/control-plane/node/mcp-intent-hook.mts",
      configRoot: "/operator/config" },
  };
}

test("renders the messaging client table and exact intent hook only when opted in", () => {
  const disabled = render(options(false));
  assert.doesNotMatch(disabled, /kherep_messaging|mcp-intent-hook|mcp-stdio-bridge/);

  const enabled = render(options(true));
  assert.equal(enabled.match(/\[mcp_servers\.kherep_messaging\]/g)?.length, 1);
  assert.match(enabled, new RegExp(`matcher = ${JSON.stringify(MATCHER).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // Issue #538: the intent hook runs through the hook adapter in pre-intent. The adapter
  // path is joined from hookDir, so the expected command is rendered the same way (win32).
  const o = options(true);
  const intent = command(o.node, path.join(o.hookDir, "codex-hook-adapter.mts"), o.messagingClient!.intentHook,
    "pre-intent", "--config-root", o.messagingClient!.configRoot);
  assert.ok(enabled.includes(`command = ${JSON.stringify(intent)}`), "the pre-intent adapter command");
  assert.match(enabled, /command = "\/usr\/bin\/node"/);
  assert.match(enabled, /args = \["\/codex\/orchestra\/control-plane\/node\/mcp-stdio-bridge\.mts", "--config-root", "\/operator\/config"\]/);
  assert.doesNotMatch(enabled, /approval_mode|permissionDecision|Authorization|Bearer|token/i);
});

import fs from 'node:fs';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {install} from '../install.mts';
import {fixtureModelOptions} from './model-policy.fixture.mts';
import {MESSAGING_CLIENT_GRAPH} from '../../modules/control-plane/node/messaging-client-graph.mts';
test('actual Codex candidate copies exact runtime graph and preserves operator config bytes',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'706-codex-candidate-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const codexHome=path.join(root,'codex'),registry=path.join(root,'registry.json');fs.mkdirSync(codexHome);
 const capabilities=JSON.parse(fs.readFileSync(new URL('../parity/capabilities.json',import.meta.url),'utf8'));
 fs.writeFileSync(registry,JSON.stringify({mcpServers:Object.fromEntries(capabilities.mcpServers.map((name:string)=>[name,{type:'http',url:'https://example.invalid/'+name}]))}),{mode:0o600});
 const config=path.join(codexHome,'config.toml'),operator='# synthetic operator config\nsynthetic_operator_setting = "keep"\n';fs.writeFileSync(config,operator);
 const result=install({...fixtureModelOptions(),codexHome,claudeConfigDir:path.join(root,'claude'),claudeRegistryFile:registry,workspace:path.join(root,'workspace'),nodePath:process.execPath,log(){},skipPluginRegistration:true,installAtlassianTools:false,resolveRegistryRuntime:()=> 'fixture',runCodex:()=> 'ok',controlPlaneOutbox:path.join(root,'config','control-plane','outbox'),messagingClient:true});
 assert.equal(result.receipt.messagingClient.status,'configured');assert.ok(fs.readFileSync(config,'utf8').includes(operator));
 const source=path.resolve(import.meta.dirname,'../../modules/control-plane');for(const relative of MESSAGING_CLIENT_GRAPH){const a=path.join(source,relative),b=path.join(result.targets.messagingClient,relative);assert.deepEqual(fs.readFileSync(a),fs.readFileSync(b));assert.equal(fs.statSync(a).mode&511,fs.statSync(b).mode&511);}
 for(const entry of ['mcp-local','mcp-intent-hook','mcp-stdio-bridge'])await import(pathToFileURL(path.join(result.targets.messagingClient,'node',entry+'.mts')).href);
 const receipt=JSON.parse(fs.readFileSync(result.targets.receipt,'utf8'));assert.equal(receipt.messagingClient.status,'configured');assert.ok(fs.readFileSync(config,'utf8').includes(operator));
});
