// Issue #693 T1: the Revision grammar with an optional repo-relative path list.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claimViews, MAX_PATH_LENGTH, MAX_PATHS, revisionLines, scopedRevision } from './confluence-claim-text.mts';
import { revisionLines as reexported } from './confluence-evidence.mts';

const SHA = 'a'.repeat(40), CORE = `alpha@${SHA}`;
const p = (line: string): string => `<p>Revision: ${line}</p>`;

test('claim barriers retain adjacent whitespace and repeated marker semantics', () => {
  const marker = String.fromCharCode(1);
  for (const whitespace of ['', ' ', '\t', '\r', '\v', '\f', '\u00a0', '\u2028', '\ufeff']) {
    const body = `<pre>example</pre>${whitespace}${marker}${whitespace}${marker}${whitespace}Revision: ${CORE}`;
    assert.ok(claimViews(body)[1].endsWith(`\nRevision: ${CORE}`), JSON.stringify(whitespace));
    assert.deepEqual(revisionLines(body).bound, [CORE]);
  }
  assert.equal(claimViews(`<pre>example</pre>x${marker}Revision: ${CORE}`)[1].split('\n').at(-1), `x${marker}Revision: ${CORE}`);
  assert.deepEqual(revisionLines(`<p>Revision: ${marker}</p>`).malformed, ['']);
  assert.deepEqual(revisionLines(`<p>Revision: ${marker}${marker}</p>`).malformed, [`${marker}${marker}`]);
});

test('an unscoped line is classified as before and carries no paths', () => {
  assert.deepEqual(revisionLines(p(CORE)), { bound: [CORE], unbound: [], malformed: [], paths: {} });
  assert.deepEqual(revisionLines(p(`owner/alpha@${SHA}`)).bound, [`owner/alpha@${SHA}`]);
  assert.equal(reexported, revisionLines, 'confluence-evidence.mts re-exports the same parser');
});
test('a scoped line binds its core and records its paths', () => {
  const r = revisionLines(p(`${CORE} -- modules/a.mts docs/b.md`));
  assert.deepEqual(r, { bound: [CORE], unbound: [], malformed: [], paths: { [CORE]: ['modules/a.mts', 'docs/b.md'] } });
  assert.deepEqual(scopedRevision(`${CORE} -- src/x.mts`), { core: CORE, paths: ['src/x.mts'] });
  assert.deepEqual(scopedRevision(CORE), { core: CORE, paths: [] });
  assert.deepEqual(revisionLines(p(`${CORE} -- modules/atl-jira-brokers`)).paths, { [CORE]: ['modules/atl-jira-brokers'] }, 'a directory is a path');
  assert.deepEqual(revisionLines(p(`${CORE} -- .github/workflows/ci.yml a.b..c`)).paths[CORE], ['.github/workflows/ci.yml', 'a.b..c']);
});
test('two scoped lines of one core merge into one bound entry with the union of their paths', () => {
  const r = revisionLines(p(`${CORE} -- a.mts b.mts`) + p(`${CORE} -- b.mts c.mts`));
  assert.deepEqual(r.bound, [CORE]);
  assert.deepEqual(r.paths[CORE], ['a.mts', 'b.mts', 'c.mts']);
  const two = revisionLines(p(`${CORE} -- a.mts`) + p(`beta@${'b'.repeat(40)} -- z.mts`));
  assert.deepEqual(two.bound, [CORE, `beta@${'b'.repeat(40)}`]);
  assert.deepEqual(two.paths, { [CORE]: ['a.mts'], [`beta@${'b'.repeat(40)}`]: ['z.mts'] });
});
test('a dirty line with a valid path list stays unbound and contributes no paths', () => {
  const line = `${CORE} -- a.mts (no exact binding: dirty tree)`;
  assert.deepEqual(revisionLines(p(line)), { bound: [], unbound: [line], malformed: [], paths: {} });
  assert.deepEqual(revisionLines(p(`${CORE} -- ../a.mts (no exact binding: dirty tree)`)).malformed.length, 1);
});
test('every path rule violation makes the whole line malformed', () => {
  const many = Array.from({ length: MAX_PATHS + 1 }, (_, i) => `f${i}.mts`).join(' ');
  const exact = Array.from({ length: MAX_PATHS }, (_, i) => `f${i}.mts`).join(' ');
  for (const list of ['/abs.mts', '../up.mts', 'a/../b.mts', './x.mts', 'a/./b', 'a//b', 'dir/', 'src/*.mts', 'a?.mts', 'a[1].mts',
    ':(glob)x', 'c:x', 'a\\b', '-flag', 'x.mts x.mts', 'a.mts -- b.mts', many, 'x'.repeat(MAX_PATH_LENGTH + 1), '.', '..']) {
    const line = `${CORE} -- ${list}`;
    assert.deepEqual(revisionLines(p(line)), { bound: [], unbound: [], malformed: [line], paths: {} }, list);
    assert.equal(scopedRevision(line), null, list);
  }
  assert.deepEqual(revisionLines(p(`${CORE} --`)).malformed, [`${CORE} --`], 'a separator without a path');
  assert.deepEqual(revisionLines(p(`${CORE} -- `)).malformed, [`${CORE} --`]);
  assert.equal(revisionLines(p(`${CORE} -- ${exact}`)).paths[CORE].length, MAX_PATHS);
  assert.equal(revisionLines(p(`${CORE} -- ${'x'.repeat(MAX_PATH_LENGTH)}`)).bound.length, 1);
  assert.deepEqual(revisionLines(p(`${SHA} -- a.mts`)).malformed.length, 1, 'a nameless core stays malformed');
});
test('spaces, tabs and entities collapse as on every other claim line', () => {
  assert.deepEqual(revisionLines(`<p>Revision:  ${CORE}\t--   a.mts&nbsp;b.mts</p>`).paths, { [CORE]: ['a.mts', 'b.mts'] });
  assert.deepEqual(revisionLines(`<p>Revision: <code>${CORE}</code> -- <code>a.mts</code></p>`).paths, { [CORE]: ['a.mts'] });
});
test('a line valid before #693 is classified identically', () => {
  for (const [line, kind] of [[CORE, 'bound'], [`${CORE} (no exact binding: dirty tree)`, 'unbound'],
    ['none (no exact binding: no repository)', 'unbound'], [SHA, 'malformed'], ['alpha@HEAD', 'malformed']] as const) {
    const r = revisionLines(p(line));
    assert.deepEqual(r[kind], [line], line);
    assert.deepEqual(r.paths, {});
  }
  assert.deepEqual(revisionLines(p(CORE) + p(CORE)).bound, [CORE, CORE], 'duplicate unscoped lines keep their old count');
});

// Issue #906: tags are replaced in one pass, and a Revision label counts at a line
// start after horizontal whitespace only; the value may still sit on the next line.
const within200 = (run: () => void): void => { const started = performance.now(); run(); assert.ok(performance.now() - started < 200); };
test('claim text of tags, entities, pre blocks and comments is unchanged', () => {
  const cases: [string, string][] = [['<p>a</p><p>b &amp; c</p>', 'a\n b c'], [p(`r@${SHA}`), `Revision: r@${SHA}`],
    ['<div>x<br/>y</div>', 'x y'], ['a < b', 'a < b'], ['<pre>k</pre><!-- c -->t', 'k t']];
  for (const [body, expected] of cases) assert.equal(claimViews(body)[0], expected, body);
  within200(() => claimViews('<'.repeat(50_000)));
});
test('Revision lines start a line after horizontal blanks', () => {
  const core = `kherep@${'0123456789abcdef'.repeat(2)}01234567`, none = { bound: [], unbound: [], malformed: [], paths: {} };
  assert.deepEqual(revisionLines(`Revision: ${core}`), { ...none, bound: [core] });
  assert.deepEqual(revisionLines(`x\n\n  \t revision :   ${core}  \nREVISION:none (no exact binding: dirty tree)`),
    { ...none, bound: [core], unbound: ['none (no exact binding: dirty tree)'] });
  assert.deepEqual(revisionLines(`Revision:\n  ${core}`), { ...none, bound: [core] });
  assert.deepEqual(revisionLines(`Revision:   \nRevision: ${core}`), { ...none, malformed: [`Revision: ${core}`] });
  assert.deepEqual(revisionLines('a Revision: x'), none);
  assert.deepEqual(revisionLines('Revision:'), { ...none, malformed: [''] });
  for (const body of ['\n'.repeat(50_000), `Revision${' \n'.repeat(25_000)}`]) within200(() => revisionLines(body));
});
