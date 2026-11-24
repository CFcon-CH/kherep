// Which file names make a page code-bound for the scanner. Synthetic storage bodies only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { namesCodeFile } from './confluence-claim-text.mts';
import { drainageRules } from './confluence-drainage-rules.mts';
import { classifyClaim } from './confluence-evidence.mts';
import { decideArgs, harness, prepareArgs, TODAY } from './evidence-cli.fixture.mts';

const PAGE = '/wiki/spaces/K/pages/77';
// A page title as the space writes them: a file name plus at least three plain words.
const TITLE = 'Notes: why src/stop.mts closes sockets twice';
const link = (href: string, text = TITLE): string => `<a href="${href}">${text}</a>`;
const OWN = '<p>src/stop.mts closes every socket of the pool.</p>';
const TRACKER = '<p>Finding: KEY-12 is in state Open.</p>';
const RELATED = `<h2>Related pages in this space</h2><p>${link('/wiki/spaces/K/pages/78')} is another topic.</p>`;
const FOOTER = '<h2>Related pages</h2><ul><li>x</li></ul>';
const CONFIRMED = ['type-observation', 'evidence-confirmed', 'status-author-model', 'runtime-claude-code-mac'];
const ASSUMED = ['type-observation', 'evidence-assumed', 'status-author-model', 'runtime-claude-code-mac'];
const snap = (body: string, labels = CONFIRMED) => ({ id: '1', version: 3, title: 'Synthetic title', spaceId: '9', parentId: null, body, labels });
const flagged = (body: string, labels = CONFIRMED): boolean => drainageRules([snap(body, labels)], false).some(c => c.problem === 'revision-missing-or-invalid');

test('the title in a page link names no code file of this page', () => {
  for (const href of [PAGE, `${PAGE}#Section`, `${PAGE}/Some+title`, `${PAGE}?x=1`, '/wiki/pages/viewpage.action?pageId=77', '/wiki/pages/viewpage.action?pageId=77&amp;x=1']) {
    assert.equal(namesCodeFile(`<p>See ${link(href)}.</p>`), false, href);
  }
  assert.equal(namesCodeFile(`<p><a class="x" href="${PAGE}" title="t">${TITLE}</a></p>`), false);
  assert.equal(namesCodeFile(`<ul><li><p>${link(PAGE)}</p></li><li><p>${link(PAGE, 'Why lib/b.py was retired')}</p></li></ul>`), false);
});

test('a file name in the page\'s own text counts, also when a page link repeats it', () => {
  for (const body of [OWN, `<p>src/stop.mts retries, see ${link(PAGE)}.</p>`, `<p>${link(PAGE)} and src/b.mts</p>`, '<p><code>lib/x.test.mts</code></p>', '<pre>y.go</pre>']) {
    assert.equal(namesCodeFile(body), true, body);
  }
});

test('a page link that is only a path, or little more, names that file', () => {
  for (const text of ['src/queue.mts', 'src/queue.mts:12', 'see src/queue.mts', 'src/queue.mts retries forever', 'src/queue.mts &amp; more &amp; less',
    'a1 b2 c3 src/queue.mts', 'src/a.mts, src/b.mts, src/c.mts', 'src/queue.mts config/deploy/prod.yaml', 'src/queue.mts tools/lint/run.mjs',
    'Users\\john\\src\\queue.mts', 'app/[locale]/(group)/page.tsx', 'src/queue.mts v1 beta2', 'src/queue.mts ./run/now ../do/it', 'src/queue.mts my_word other-word x1y2',
    'src / lib / net / queue.mts', 'kherep / modules / brokers / queue.mts', 'src \\ lib \\ net \\ queue.mts', 'src &gt; lib &gt; net &gt; queue.mts', 'src › lib › net › queue.mts',
    'src&#47;lib&#47;net&#47;queue.mts', 'src&sol;lib&sol;net&sol;queue.mts', 'C:\\Program Files\\My Cool New\\src\\queue.mts', 'Pr&uuml;fung src/queue.mts gepr&uuml;ft neu']) {
    assert.equal(namesCodeFile(`<p>${link(PAGE, text)}</p>`), true, text);
  }
  assert.equal(namesCodeFile(`<p>${link(PAGE, 'src/queue.mts drops stale receipts')}</p>`), false);
  assert.equal(namesCodeFile(`<p>${link(PAGE, 'Why "src/queue.mts" (the queue) failed, twice!')}</p>`), false, 'punctuation around a word does not break it');
  assert.equal(namesCodeFile(`<p>${link(PAGE, 'Prüfung der Säule über src/queue.mts &mdash; neu')}</p>`), false, 'letters of any alphabet are words and common title entities are spaces');
});

test('only a site-relative page link counts as one, by its own href', () => {
  for (const anchor of [
    link('https://example.com/blob/main/src/stop.mts'),
    link(`https://example.com${PAGE}`),
    link(`https://example.com/?to=${PAGE}`),
    link('/wiki/spaces/K/overview'),
    link(`${PAGE}abc`),
    link('/wiki/pages/viewpage.action?other=77'),
    `<a title="${PAGE}" href="https://example.com/x">${TITLE}</a>`,
    `<a data-href="${PAGE}" href="https://example.com/x">${TITLE}</a>`,
    `<a href="https://example.com/x" href="${PAGE}">${TITLE}</a>`,
    `<a>${TITLE}</a>`,
  ]) assert.equal(namesCodeFile(`<p>${anchor}</p>`), true, anchor);
});

test('an anchor that is not plain link text hides nothing', () => {
  for (const body of [
    `<p><a href="${PAGE}">title</p>${OWN}`,
    `<a href="${PAGE}">${OWN}</a>`,
    `<p><a href="${PAGE}">the old title <!-- x --> src/stop.mts of sockets</a></p>`,
    `<p><a href="${PAGE}">the old title <![CDATA[x]]> src/stop.mts of sockets</a></p>`,
    `<!-- <a href="${PAGE}"> -->${OWN}<!-- </a> -->`,
    `<![CDATA[<a href="${PAGE}">]]>${OWN}<![CDATA[</a>]]>`,
    `<?x <a href="${PAGE}"> ?>${OWN}<?x </a> ?>`,
    `<!-- > ${link(PAGE)} -->`,
    `<p><a href="${PAGE}" >${TITLE}</a ></p>`,
    `<p><a href="${PAGE}" x='1'>${TITLE}</a></p>`,
    `<p><a href="${PAGE}"><b>${TITLE}</b></a></p>`,
    `<abbr href="${PAGE}">${TITLE}</abbr>`,
  ]) assert.equal(namesCodeFile(body), true, body);
});

test('a bare product name is not a file; a path, a line reference or a longer name is', () => {
  for (const text of ['Node.js 24 runs it.', 'It ends. Node.js starts.', '(Node.js), "Next.js" and Vue.js.', 'Node.js: the runtime']) {
    assert.equal(namesCodeFile(`<p>${text}</p>`), false, text);
  }
  for (const text of ['src/Node.js', 'node.js', './Vue.js', '..\\Next.js', 'Legend.js', 'Vue.js:12 throws', 'Node.js/lib holds it', 'src/<b>Node.js</b> starts it',
    'src/ Node.js', 'foo.Node.js', 'x-Node.js', 'Node.js-like', 'Node.js.mts', 'src\\Node.js', 'lib/<code>Vue.js</code>']) {
    assert.equal(namesCodeFile(`<p>${text}</p>`), true, text);
  }
  assert.equal(namesCodeFile('<p>Node.js and src/a.mts</p>'), true, 'a file next to a product name still counts');
});

test('leaving out a title changes nothing else on the page', () => {
  assert.equal(namesCodeFile(`<p>a${link(PAGE)}.mts</p>`), false, 'the words around a title are never joined');
  assert.equal(namesCodeFile(`<p>src/${link(PAGE)}queue.mts</p>`), true);
  for (const before of ['<p>If a < b ', '<p>x < ']) {
    assert.equal(namesCodeFile(`${before}${link(PAGE, 'Notes: why the pool closes')} src/stop.mts fails.</p>`), true, 'a raw < before the link hides no own file');
    assert.equal(namesCodeFile(`<p>< src/a.mts ${link(PAGE, 'Notes: why the pool closes')}</p>`), false, 'and adds none');
  }
});

test('a link to the page itself is not a link to another page', () => {
  const own = `<p>${link('/wiki/spaces/K/pages/1', 'src/stop.mts closes every socket of the pool')}</p>`;
  assert.equal(namesCodeFile(own, '1'), true);
  assert.equal(namesCodeFile(own, '2'), false);
  assert.equal(namesCodeFile(`<p>${link('/wiki/spaces/K/pages/1#Own', 'src/stop.mts closes every socket of the pool')}</p>`, '1'), true);
  assert.equal(flagged(own), true, 'the scanner knows the id of the page it reads');
});

test('reading titles is linear on broken anchors and regions', () => {
  for (const part of [`<a href="${PAGE}">`, '<a ', '<a href="', '<a x="1" ', '<!--', '<![CDATA[', '<?', `<a${' '.repeat(50)}`, `<a href="${PAGE}">x.mts y `, `<a href="${PAGE}">a.mts b c d</a>`]) {
    const started = performance.now();
    namesCodeFile(part.repeat(20_000));
    assert.ok(performance.now() - started < 1500, part);
  }
});

test('scanner: a link title or a product name asks for no Revision, an own file name does', () => {
  const linked = TRACKER + RELATED;
  assert.equal(flagged(linked), false);
  assert.equal(flagged(linked + FOOTER), false);
  assert.equal(flagged('<p>The worker runs on Node.js.</p>'), false);
  assert.equal(flagged(linked + OWN), true);
  assert.equal(flagged(`<p>src/stop.mts closes sockets, see ${link(PAGE)}.</p>`), true);
  assert.equal(flagged(`<p>${link(PAGE, 'src/stop.mts')} closes sockets.</p>`), true, 'a link that is only a file name names it');
  assert.equal(flagged('<p>src/Node.js starts it.</p>'), true);
  assert.equal(flagged(`${linked}<p>Code: reads the queue</p>`), true, 'a Code: label is not a file name and still counts');
  assert.equal(flagged(`${linked}<p>Revision: not a revision</p>`), true, 'a malformed Revision line is still a defect');
});

test('confirm path: the classification still counts a file name in a title', () => {
  for (const body of [TRACKER + RELATED, `<p>The pool closes twice, see ${link(PAGE, 'KEY-12: why src/stop.mts closes sockets twice')}.</p>`, '<p>KEY-12: the worker runs on Node.js.</p>']) {
    const c = classifyClaim(snap(body), true);
    assert.equal(c.kind, 'code', body);
    assert.equal(classifyClaim(snap(body.replace(/<a [^>]*>|<\/a>/g, ' ')), true).kind, 'code', body);
  }
});

test('a page is never easier to confirm or refute, only a superseded one may leave out titles', async () => {
  const tracker = (over: Record<string, unknown>) => ({ kind: 'tracker', source: 'KEY-12', sourceClass: 'tracker', command: 'jira get --key KEY-12',
    excerpt: 'key: KEY-12\nstate: Done', measuredAt: TODAY, verdict: 'reproduces', kindOverride: 'The claim is the tracker state of KEY-12.', ...over });
  const run = async (body: string, labels: string[], measurement: object, supersede: boolean): Promise<string> => {
    const h = harness({ '1': { body, labels }, '77': { body: '<p>newer</p>', labels: ASSUMED } });
    await h.run({ ...prepareArgs, kind: 'tracker' });
    h.files.set('/synthetic/evidence/m.json', JSON.stringify(measurement));
    h.out.length = 0;
    await h.run({ ...decideArgs, ...(supersede ? { 'superseded-by': '77', 'body-approved': undefined } : {}) });
    return h.out.filter(l => /^(?:outcome|reason)/.test(l)).join(' ');
  };
  const refused = 'outcome: unknown reason: promoted-body-revision-invalid';
  const body = `${TRACKER}${RELATED}${FOOTER}`;
  for (const [name, text] of [['a title', body], ['a product name', `<p>KEY-12: the worker runs on Node.js.</p>${FOOTER}`]] as const) {
    assert.equal(await run(text, ASSUMED, tracker({}), false), refused, `${name}, confirm`);
    assert.equal(await run(text, ASSUMED, tracker({ verdict: 'contradicts' }), false), refused, `${name}, refute`);
    assert.equal(await run(text, CONFIRMED, tracker({ verdict: 'contradicts' }), true), 'outcome: superseded reason: measured', `${name}, supersede`);
  }
  assert.equal(await run(`${TRACKER}${OWN}${FOOTER}`, CONFIRMED, tracker({ verdict: 'contradicts' }), true), refused, 'an own file name still asks for a Revision line');
  assert.equal(await run(`<p>KEY-12: ${link('/wiki/spaces/K/pages/1', 'src/stop.mts closes every socket of the pool')}</p>${FOOTER}`, CONFIRMED, tracker({ verdict: 'contradicts' }), true), refused, 'a self-link still counts');
});

test('everyFileName counts titles and product names as before', () => {
  for (const body of [TRACKER + RELATED, '<p>The worker runs on Node.js.</p>']) {
    const strict = (b: string) => drainageRules([snap(b)], false, true).some(c => c.problem === 'revision-missing-or-invalid');
    assert.deepEqual([flagged(body), strict(body)], [false, true], body);
  }
});
