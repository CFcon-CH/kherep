import test from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryXhtml, observationRequest } from './observation-policy.mts';
import { publishObservations, type ObservationBroker } from './observation-publisher.mts';
const finding = {title:'Synthetic finding',bodyStorage:'<p>Synthetic prose</p>',evidence:'assumed',
  labels:['type-observation','evidence-assumed','status-author-model'],placement:{project:'Kherep',app:'-'},links: { candidates: 'a'.repeat(64), approved: [] as { id: string; reason: string }[] }};
const request=(bodyStorage:string)=>({sessionId:'synthetic',turnId:'turn',observations:[{...finding,bodyStorage}]});
for (const key of ['sessionId', 'turnId']) test(`${key}: invalid identity rejects before receipt or broker access`, async () => {
  for (const value of [undefined, null, 42, {}, [], '', ' ', ' bad', 'bad ', 'bad\nvalue', '<markup>', 'UPPER', 'a'.repeat(81)]) {
    let brokerCalls = 0, receiptCalls = 0;
    const broker = new Proxy({} as ObservationBroker, { get() { brokerCalls++; throw new Error('unexpected broker I/O'); } });
    const result = await publishObservations({ ...request(finding.bodyStorage), [key]: value }, broker,
      { claim() { receiptCalls++; throw new Error('unexpected receipt I/O'); } });
    assert.equal(result, 'OBS-RESULT: failed invalid-request');
    assert.equal(brokerCalls, 0); assert.equal(receiptCalls, 0);
  }
});
test('exact 80-character session and turn identities remain admissible', () => {
  const valid = { ...request(finding.bodyStorage), sessionId: 's'.repeat(80), turnId: 't'.repeat(80) };
  assert.deepEqual(observationRequest(valid), valid);
});
for (const key of ['sessionId', 'turnId']) test(`${key}: terminal line separators reject before receipt or broker access`, async () => {
  for (const end of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    let brokerCalls = 0, receiptCalls = 0;
    const broker = new Proxy({} as ObservationBroker, { get() { brokerCalls++; throw new Error('unexpected broker I/O'); } });
    const result = await publishObservations({ ...request(finding.bodyStorage), [key]: `native-id${end}` }, broker,
      { claim() { receiptCalls++; throw new Error('unexpected receipt I/O'); } });
    assert.equal(result, 'OBS-RESULT: failed invalid-request');
    assert.equal(brokerCalls, 0); assert.equal(receiptCalls, 0);
  }
});
for(const body of [
  '<img src="https://canary.invalid/pixel">', '<p style="background:url(https://canary.invalid/pixel)">text</p>',
  '<style>p{background:url(https://canary.invalid/pixel)}</style>', '<link href="https://canary.invalid/style.css"/>',
  '<svg><image href="https://canary.invalid/pixel"/></svg>', '<video src="https://canary.invalid/movie"/>',
  '<audio><source src="https://canary.invalid/sound"/></audio>', '<form action="https://canary.invalid/send"><input/></form>',
  '<p href="https://canary.invalid">text</p>', '<p src="https://canary.invalid">text</p>',
  '<p xmlns="https://canary.invalid">text</p>', '<?xml version="1.0"?><p>text</p>',
  '<!DOCTYPE p SYSTEM "https://canary.invalid/entity"><p>text</p>', '<!--comment--><p>text</p>',
  '<script', '<script>alert(1)</script>', '<p><script', '<p><script>alert(1)</script></p>',
  '<p><script<p></p>', '<p>text<', '<p><p</p>', '<p><<p></p>', '<p></p><script',
  '<ac:structured-macro/>', '<math><mi>resource</mi></math>', '<p>unclosed', '<p></code>',
]) test(`resource or malformed XHTML rejected before any I/O: ${body.split('>')[0]}>`, async()=>{
  let brokerCalls=0,receiptCalls=0;
  const broker=new Proxy({} as ObservationBroker,{get(){brokerCalls++;throw new Error('unexpected broker I/O');}});
  const result=await publishObservations(request(body),broker,{claim(){receiptCalls++;throw new Error('unexpected receipt I/O');}});
  assert.equal(result,'OBS-RESULT: failed invalid-request');assert.equal(brokerCalls,0);assert.equal(receiptCalls,0);
  assert.equal(ordinaryXhtml(body),false);
});
test('ordinary prose XHTML including escaped resource examples remains admissible',()=>{
  const prose='<p>literal -&gt; and -> stay prose</p><h2>Finding</h2><p><strong>Measured</strong> <em>synthetic</em><br/></p>'
    +'<pre><code>&lt;img src="example"&gt;</code></pre><ul><li>One</li></ul>'
    +'<table><thead><tr><th>Check</th></tr></thead><tbody><tr><td>Pass</td></tr></tbody></table>';
  assert.equal(ordinaryXhtml(prose),true);assert.ok(observationRequest(request(prose)));
});
test('product label must be a string and duplicate/base label rules remain enforced',()=>{
  for(const labels of [[...finding.labels,['product-jira']],[...finding.labels,'product-jira','product-jsm'],
    [...finding.labels,'type-observation'],['type-observation','status-author-model','product-jira']]) {
    assert.equal(observationRequest({...request(finding.bodyStorage),observations:[{...finding,labels}]}),null);
  }
  assert.ok(observationRequest({...request(finding.bodyStorage),observations:[{...finding,labels:[...finding.labels,'product-jira']}]}));
});
// Issue #736: links are the adapter's sixth key, required and checked by shape.
test('links are required and checked by shape before any I/O', () => {
    const ok = request('<p>Synthetic prose</p>');
    assert.ok(observationRequest(ok));
    const variants: unknown[] = [undefined, {}, { candidates: 'A'.repeat(64), approved: [] }, { candidates: 'a'.repeat(64) },
        { candidates: 'a'.repeat(64), approved: [{ id: 'x', reason: 'r'.repeat(20) }] },
        { candidates: 'a'.repeat(64), approved: [{ id: '1', reason: 'r'.repeat(20), extra: 1 }] },
        { candidates: 'a'.repeat(64), approved: Array.from({ length: 11 }, (_, i) => ({ id: String(i + 1), reason: 'r'.repeat(20) })) },
        { candidates: 'a'.repeat(64), approved: [], extra: true }];
    for (const links of variants) {
        const r = request('<p>Synthetic prose</p>') as { observations: Record<string, unknown>[] };
        if (links === undefined) delete r.observations[0].links; else r.observations[0].links = links;
        assert.equal(observationRequest(r), null, JSON.stringify(links));
    }
});
