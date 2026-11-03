// Issue #757. `claude plugin test` suite of the usage-band mod. The file system, the
// environment and the clock are the test's own hooks beneath the plugin; each band check
// runs over the terminal and the desktop surface.
import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { formatLocal, parseState, WEEK_SECONDS, windowKey, type UsageState } from './lib/usage-window.mts'

const RESETS = 1738857600 // Thu 06 Feb 2025 16:00 UTC
const at = (elapsedPercent: number) => (RESETS - WEEK_SECONDS + WEEK_SECONDS * elapsedPercent / 100) * 1000
const HOME = '/home/example/.claude'
const FILE = `${HOME}/.cache/usage-watch/state.json`
// The engine resolves a path for its host (D:\home\... on Windows): compare the tail.
const isStateFile = (p: string) => p.replace(/\\/g, '/').endsWith(FILE)
const SURFACES = ['terminal', 'desktop'] as const
const PROPS = {
  hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 160,
  scroll: { offset: 0, bodyRows: 7 }, view: {},
}

function state(over: Partial<UsageState> = {}): UsageState {
  return {
    v: 1, window_key: windowKey(RESETS), resets_at: RESETS, used_percentage: 55, elapsed_percentage: 20,
    observed_at: new Date(at(20)).toISOString(), conditions: { threshold: true, pace: true }, notified: {}, ...over,
  }
}

// The world beneath the plugin: one state file, its writes recorded, an engine that draws "engine".
function world(on: On, initial: string | null, nowMs = at(20)) {
  const disk = { text: initial, writes: [] as { path: string; text: string }[], failReads: false, failWrites: false }
  mock.env(on, { CLAUDE_HOME: HOME })
  const clock = mock.clock(on, { now: nowMs })
  on('fs.read', (_, e) => (disk.failReads || disk.text === null || !isStateFile(e.path) ? { deny: 'ENOENT' } : { value: disk.text }))
  on('fs.write', (_, e) => {
    if (disk.failWrites) return { deny: 'EACCES' }
    disk.writes.push({ path: e.path, text: e.text })
    disk.text = e.text
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'engine') as RenderElement
  })
  return { disk, clock }
}

const start = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.session.start({ cwd: '/', surface, isInteractive: true })

async function band($: Engine, surface: 'terminal' | 'desktop', props = PROPS) {
  const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props })
  const text = await ui.find({ type: 'Text' })
  await ui.unmount()
  return text
}

const measure = (rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]) =>
  ({ context: { window: 200_000 }, rateLimits, changed: ['rateLimits' as const] })

test('B1 the band shows used, elapsed, local reset time, highlighted by level', async ($, on) => {
  const { disk } = world(on, JSON.stringify(state()))
  await start($)
  for (const surface of SURFACES) {
    const text = await band($, surface)
    expect(text?.text).toContain('55% used')
    expect(text?.text).toContain('20% of the week elapsed')
    expect(text?.text).toContain(`resets ${formatLocal(RESETS)}`)
    expect(text?.text).toContain(': half of the budget is gone; usage runs ahead of the week')
    expect(text?.props).toMatchObject({ bold: true, color: 'red' })
  }
  disk.text = JSON.stringify(state({ used_percentage: 35, conditions: { threshold: false, pace: true } }))
  await start($)
  for (const surface of SURFACES) expect((await band($, surface))?.props).toMatchObject({ bold: true, color: 'yellow' })
  disk.text = JSON.stringify(state({ used_percentage: 20, conditions: { threshold: false, pace: false } }))
  await start($)
  for (const surface of SURFACES) {
    const text = await band($, surface)
    expect(text?.props).toMatchObject({ dimColor: true })
    expect(text?.text).not.toContain(': ')
  }
})

test('B2 no state, a window that is over, or a survey: the band passes to the engine', async ($, on) => {
  const { disk } = world(on, null)
  await start($)
  for (const surface of SURFACES) expect((await band($, surface))?.text).toBe('engine')
  disk.text = JSON.stringify(state({ resets_at: at(10) / 1000 }))
  await start($)
  for (const surface of SURFACES) expect((await band($, surface))?.text).toBe('engine')
  disk.text = JSON.stringify(state())
  await start($)
  for (const surface of SURFACES) expect((await band($, surface, { ...PROPS, hasSurvey: true }))?.text).toBe('engine')
})

test('B3 session.measure writes the seven_day window in the v1 shape', async ($, on) => {
  const seeded = state({ notified: { threshold: '2025-02-01T00:00:00.000Z' } })
  const { disk, clock } = world(on, JSON.stringify(seeded))
  await start($)
  await $.session.measure(measure([{ kind: 'five_hour', percentUsed: 90 }]))
  expect(disk.writes).toHaveLength(0)
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 61, resetsAt: new Date(RESETS * 1000).toISOString() }]))
  expect(disk.writes).toHaveLength(1)
  expect(isStateFile(disk.writes[0]?.path ?? "")).toBe(true)
  const written = parseState(disk.writes[0]?.text ?? null)
  expect(written?.window_key).toBe(windowKey(RESETS))
  expect(written?.used_percentage).toBe(61)
  expect(written?.observed_at).toBe(new Date(clock.now()).toISOString())
  expect(written?.notified).toEqual(seeded.notified)
  // The same figure again within a minute: no churn.
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 61, resetsAt: new Date(RESETS * 1000).toISOString() }]))
  expect(disk.writes).toHaveLength(1)
  const next = RESETS + WEEK_SECONDS
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 2, resetsAt: new Date(next * 1000).toISOString() }]))
  const rolled = parseState(disk.writes[1]?.text ?? null)
  expect(rolled?.window_key).toBe(windowKey(next))
  expect(rolled?.notified).toEqual({})
  for (const surface of SURFACES) expect((await band($, surface))?.text).toContain('2% used')
})

test('B4 the 60-second tick brings a changed file to the band', async ($, on) => {
  const { disk, clock } = world(on, JSON.stringify(state()))
  await start($)
  expect((await band($, 'desktop'))?.text).toContain('55% used')
  disk.text = JSON.stringify(state({ used_percentage: 30, conditions: { threshold: false, pace: false } }))
  await clock.advance(60_000)
  for (const surface of SURFACES) {
    const text = await band($, surface)
    expect(text?.text).toContain('30% used')
    expect(text?.props).toMatchObject({ dimColor: true })
  }
})

test('B5 prompt.submit passes the prompt unchanged, toasts nothing, writes nothing of it', async ($, on) => {
  const { disk } = world(on, JSON.stringify(state()))
  const seen: string[] = []
  let toasts = 0
  on('prompt.submit', (_, e) => (seen.push(e.text), { text: e.text }))
  on('ui.toast', () => (toasts++, { value: undefined }))
  await start($)
  await $.prompt.submit({ text: 'Example Corp secret', wait: false, origin: { kind: 'composer' } })
  await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 62, resetsAt: new Date(RESETS * 1000).toISOString() }]))
  expect(seen).toEqual(['Example Corp secret'])
  expect(toasts).toBe(0)
  expect(disk.writes.map((w) => w.text).join('')).not.toContain('Example Corp')
})

test('B6 failing reads and writes never escape a hook', async ($, on) => {
  const { disk } = world(on, '{"v":1,')
  await start($)
  for (const surface of SURFACES) expect((await band($, surface))?.text).toBe('engine')
  disk.failReads = true
  disk.failWrites = true
  await start($)
  const result = await $.session.measure(measure([{ kind: 'seven_day', percentUsed: 70, resetsAt: new Date(RESETS * 1000).toISOString() }]))
  expect(result).toEqual({ changed: ['rateLimits'] })
  for (const surface of SURFACES) expect((await band($, surface))?.text).toBe('engine')
})
