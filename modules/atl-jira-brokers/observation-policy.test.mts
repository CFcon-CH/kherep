import test from 'node:test';
import assert from 'node:assert/strict';
import { failed, invalidRequest, ordinaryXhtml, observationRequest } from './observation-policy.mts';
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
// Issue #989: the policy refuses a link reason with the receipt check's own bound,
// and names the findings when the reason is the request's only defect.
const linked = (...reasons: unknown[]) => ({ ...request('<p>Synthetic prose</p>'), observations: reasons.map(reason =>
    ({ ...finding, links: { candidates: 'a'.repeat(64), approved: [{ id: '11', reason }] } })) });
test('a link reason outside 10 to 300 printable characters is an invalid request', () => {
    for (const reason of ['r'.repeat(10), 'r'.repeat(300)]) assert.ok(observationRequest(linked(reason)), String(reason.length));
    for (const reason of ['', 'r'.repeat(9), 'r'.repeat(301), 'line one\nline two', 'tab\there and there', 42])
        assert.equal(observationRequest(linked(reason)), null, JSON.stringify(reason));
});
test('invalidRequest names reason-only defects and stays bare for any other defect', () => {
    assert.equal(invalidRequest(linked('r'.repeat(20), 'short')), 'OBS-RESULT: failed invalid-request why=2:reason-invalid');
    assert.equal(invalidRequest(linked('', 'r'.repeat(20), 'r'.repeat(301))), 'OBS-RESULT: failed invalid-request why=1:reason-invalid,3:reason-invalid');
    for (const value of [{ ...linked('short'), sessionId: 'BAD ID' }, linked(42), { ...linked('short'), extra: true }, null, [], 'text',
        { ...linked('short'), observations: [{ ...linked('short').observations[0], bodyStorage: '<img src="x">' }] }])
        assert.equal(invalidRequest(value), 'OBS-RESULT: failed invalid-request', JSON.stringify(value));
});
test('failed never renders why= together with created=', () => {
    assert.equal(failed('links-refused', [], '1:another-title'), 'OBS-RESULT: failed links-refused why=1:another-title');
    assert.equal(failed('links-refused', ['101'], 'unknown'), 'OBS-RESULT: failed links-refused created=101');
    assert.equal(failed('create-unverified', ['101']), 'OBS-RESULT: failed create-unverified created=101');
});
