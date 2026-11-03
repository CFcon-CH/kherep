// Issue #757. The usage-band mod: the weekly Claude plan budget as a band above the prompt,
// in the terminal and in the desktop app's Code tab, on Windows and macOS alike.
//
// It is also a second feeder of <CLAUDE_HOME>/.cache/usage-watch/state.json: after each turn
// the engine measures the session (`session.measure`) and the mod writes the seven_day window
// in the recorder's v1 shape, so hooks/usage-watch.mts has a reading where no status line runs.
// It never toasts by itself, never claims a marker and never writes last-input: those belong
// to hooks/usage-record.mts. `notified` is carried over while the window key is unchanged.
// `$.fs.write` is not atomic; parseState treats a half-written file as no state, and the
// 60-second tick reads again. Nothing of a prompt or a payload is read or written, and every
// error is swallowed so no hook blocks the session.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionRateLimit } from 'claude-code'

import { bandView, evaluate, parseState, parseWindow, userNotice, windowKey, type UsageState } from './lib/usage-window.mts'

const held = atom({ plugin: 'usage-band', key: 'state' } as const, null as UsageState | null)
const readAt = atom({ plugin: 'usage-band', key: 'readAt' } as const, 0)
const TICK_MS = 60_000
const CHURN_MS = 60_000
const LEVEL_STYLE = {
  threshold: { bold: true, color: 'red' },
  pace: { bold: true, color: 'yellow' },
  calm: { dimColor: true },
} as const
// Flipped only if measurement M3 shows the desktop app does not show systemMessage and M3b
// shows that $.ui.toast draws there (issue #757).
const DESKTOP_PROMPT_TOAST: boolean = false

async function stateFile($: EngineInterface): Promise<string | null> {
  const claudeHome = await $.env.get('CLAUDE_HOME')
  if (claudeHome) return `${claudeHome}/.cache/usage-watch/state.json`
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  return home ? `${home}/.claude/.cache/usage-watch/state.json` : null
}

async function readState($: EngineInterface, file: string): Promise<UsageState | null> {
  return parseState(await $.fs.read(file).catch(() => null))
}

// The band draws from both values; `readAt` is the "now" the band judges the window at.
async function hold($: EngineInterface, state: UsageState | null, nowMs: number): Promise<void> {
  await update($, readAt, () => nowMs)
  await update($, held, () => state)
}

async function refresh($: EngineInterface): Promise<void> {
  const file = await stateFile($)
  if (!file) return
  await hold($, await readState($, file), await $.clock.now())
}

async function record($: EngineInterface, limits: readonly SessionRateLimit[], nowMs: number): Promise<void> {
  const week = limits.find((limit) => limit.kind === 'seven_day')
  const window = parseWindow(week?.percentUsed, week?.resetsAt)
  if (!window) return
  const file = await stateFile($)
  if (!file) return
  const previous = await readState($, file)
  const key = windowKey(window.resetsAt)
  const sameWindow = previous?.window_key === key
  if (previous && sameWindow && previous.used_percentage === window.used
    && nowMs - Date.parse(previous.observed_at) < CHURN_MS) {
    await hold($, previous, nowMs)
    return
  }
  const verdict = evaluate(window, nowMs)
  const state: UsageState = {
    v: 1, window_key: key, resets_at: window.resetsAt, used_percentage: window.used,
    elapsed_percentage: verdict.elapsed, observed_at: new Date(nowMs).toISOString(),
    conditions: { threshold: verdict.threshold, pace: verdict.pace },
    notified: previous && sameWindow ? { ...previous.notified } : {},
  }
  await $.fs.write(file, `${JSON.stringify(state, null, 2)}\n`)
  await hold($, state, nowMs)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await refresh($).catch(() => {})
    $.clock.every(TICK_MS, () => { refresh($).catch(() => {}) })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      await record($, e.rateLimits, await $.clock.now())
    } catch {
      // A reading that cannot be written is not worth an error.
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    try {
      const state = await read($, held)
      const view = state ? bandView(state, await read($, readAt)) : null
      if (!view) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      return h(Box, null, h(Text, LEVEL_STYLE[view.level], view.text)) as RenderElement
    } catch {
      return next(e)
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (DESKTOP_PROMPT_TOAST) {
      try {
        const state = await read($, held)
        const text = state ? userNotice(state, await $.clock.now()) : ''
        if (text && (await $.session.surfaces()).some((surface) => surface !== 'terminal')) $.ui.toast(text)
      } catch {
        // The toast is a fallback; the prompt goes on regardless.
      }
    }
    return next(e)
  })
}
