import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const usage = (r: { cache_read_input_tokens: number }) => ({
  input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, ...r,
})
const HIT = { isAnswered: true, text: 'ok', usage: usage({ cache_read_input_tokens: 1000 }) }
const MISS = { isAnswered: true, text: 'ok', usage: usage({ cache_read_input_tokens: 0 }) }
const FAIL = { isAnswered: false, reason: 'empty-reply', usage: usage({ cache_read_input_tokens: 0 }) }
const NOTE = { isAnswered: true, text: '# 引き継ぎ書', usage: usage({ cache_read_input_tokens: 1000 }) }

const MESSAGES = [
  { role: 'user', text: 'see https://example.com/doc', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { file_path: '/repo/a.ts' } }] },
]

const BAND = {
  plugin: 'handoff',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const setup = (on: any, forks: unknown[], o: { rateLimits?: unknown[]; percent?: number; busyAgents?: () => boolean; agentListFails?: boolean; clearDelayMs?: number; forkDelayMs?: number; stale?: Record<string, unknown>; messages?: unknown[] } = {}) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  let forkCalls = 0
  const saved: Record<string, any> = {}
  const files: Record<string, string> = {}
  const calls: string[] = []
  on('state.set', ($: unknown, e: { key: string; value: unknown }, next: (e: unknown) => unknown) => {
    saved[e.key] = e.value
    return next(e)
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, percent: o.percent ?? 10 }, rateLimits: o.rateLimits ?? [] } }))
  on('model.fork', async () => {
    const answer = forks[Math.min(forkCalls++, forks.length - 1)]
    if (o.forkDelayMs) await clock.sleep(o.forkDelayMs)
    if (answer instanceof Error) throw answer
    return { value: answer }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.toast', () => ({ value: undefined }))
  on('agent.list', () => {
    if (o.agentListFails) throw new Error('agent.list failed')
    return { value: o.busyAgents?.() ? [{ id: 'a', status: 'running' }] : [] }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  // What an earlier load left in $.state, read until this load writes the key.
  on('state.get', ($: unknown, e: { key: string }, next: (e: unknown) => unknown) =>
    o.stale && e.key in o.stale && !(e.key in saved) ? { value: { value: o.stale[e.key], version: 1 } } : next(e))
  on('classic.SessionStart', () => ({}))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('session.messages', () => ({ value: o.messages ?? MESSAGES }))
  on('session.cwd', () => ({ value: '/repo/my-project' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => ((files[e.path] = e.text), { value: undefined }))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: files[e.path] }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: e.path in files }))
  on('command.run', async (_: unknown, e: { command: string }) => {
    calls.push(`/${e.command}`)
    if (o.clearDelayMs) await clock.sleep(o.clearDelayMs)
    return { value: {} }
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => (calls.push(`submit:${e.text}`), { text: e.text }))
  return { clock, forks: () => forkCalls, cycle: () => saved.cycle, handoff: () => saved.handoff, files, calls }
}

const endTurn = async ($: any) => {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('keeps three times, then writes the handoff', async ($, on) => {
  const { clock, forks, cycle, handoff, files } = setup(on, [HIT, HIT, HIT, NOTE])
  await endTurn($)
  expect(cycle().phase).toBe('idle')

  await clock.advance(50 * MIN)
  expect(forks()).toBe(1)
  expect(cycle().kept).toBe(1)

  await clock.advance(100 * MIN)
  expect(cycle().kept).toBe(3)

  await clock.advance(50 * MIN)
  expect(forks()).toBe(4)
  expect(cycle().phase).toBe('held')
  expect(handoff().status).toBe('ready')
  expect(handoff().reasons).toEqual(['away'])
  expect(handoff().path).toMatch(/^\/home\/u\/\.claude\/handoffs\/\d{4}-\d\d-\d\d-\d{6}-my-project\.md$/)
  expect(files[handoff().path]).toMatch(/^Generated: \d{4}-\d\d-\d\d \d\d:\d\d · Last reply: \d{4}-\d\d-\d\d \d\d:\d\d\n\n# 引き継ぎ書$/)
  expect(handoff().steps.map((s: { result: string }) => s.result).slice(0, 3)).toEqual(['2 messages', '1 file', '0 skills, 1 link'])
})

test('a real turn resets the count', async ($, on) => {
  const { clock, cycle } = setup(on, [HIT])
  await endTurn($)
  await clock.advance(50 * MIN)
  await endTurn($)
  expect(cycle().kept).toBe(0)
  expect(cycle().phase).toBe('idle')
})

test('a failure retries once after 5 min, then stops', async ($, on) => {
  const { clock, forks, cycle } = setup(on, [FAIL])
  await endTurn($)
  await clock.advance(50 * MIN)
  expect(cycle().isRetry).toBe(true)
  await clock.advance(5 * MIN)
  expect(forks()).toBe(2)
  expect(cycle().phase).toBe('stopped')
})

test('a cache miss stops keeping', async ($, on) => {
  const { clock, cycle } = setup(on, [MISS])
  await endTurn($)
  await clock.advance(50 * MIN)
  expect(cycle().phase).toBe('stopped')
})

test('a plan near its limit stops keeping without a fork', async ($, on) => {
  const { clock, forks, cycle } = setup(on, [HIT], { rateLimits: [{ kind: 'five_hour', percentUsed: 95 }] })
  await endTurn($)
  await clock.advance(50 * MIN)
  expect(forks()).toBe(0)
  expect(cycle().phase).toBe('stopped')
})

test('keep-alive off draws the off state', { options: { keepAlive: false } }, async ($, on) => {
  const { clock, forks, cycle } = setup(on, [HIT])
  await endTurn($)
  await clock.advance(60 * MIN)
  expect(forks()).toBe(0)
  expect(cycle().phase).toBe('off')
})

test('usage past the threshold writes the handoff; closing holds it', async ($, on) => {
  const { clock, forks, handoff } = setup(on, [NOTE], { percent: 85 })
  await endTurn($)
  await clock.settle()
  expect(handoff().status).toBe('ready')
  expect(handoff().reasons).toEqual(['usage'])

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'close' } as any)
  await ui.unmount()
  await endTurn($)
  await clock.settle()
  expect(forks()).toBe(1) // held: no second handoff at 85%
})

test('the band offers the handoff and switching clears then sends it', async ($, on) => {
  const { clock, calls } = setup(on, [NOTE], { percent: 85 })
  await endTurn($)
  await clock.settle()
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await terminal.find({ type: 'Text', text: /Handoff ready/ }))?.text).toBe('Handoff ready: 67 chars')
  await terminal.unmount()

  // desktop draws the band as one SVG; its alt carries the heading
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('Handoff ready: 67 chars')
  expect(String(svg?.props.source)).toContain('Saved to')
  expect((await ui.findAll({ type: 'Button' })).length).toBe(4)
  await ui.press({ key: 'switch' } as any)
  await clock.settle()
  await ui.unmount()
  expect(calls).toHaveLength(2)
  expect(calls[0]).toBe('/clear')
  expect(calls[1]).toMatch(/^submit:Generated: .+\n\n# 引き継ぎ書$/)
})

test('a resumed session within the TTL keeps from its last response', async ($, on) => {
  const { clock, cycle } = setup(on, [HIT])
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 600, prompt_cache_likely_expired: false } as any)
  expect(cycle().phase).toBe('idle')
  expect(cycle().dueAt - clock.now()).toBe(40 * MIN)
})

test('a resumed session past the TTL does not keep', async ($, on) => {
  const { cycle } = setup(on, [HIT])
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 4000, prompt_cache_likely_expired: true } as any)
  expect(cycle()).toBeUndefined()
})

test('thresholds out of order are warned in the band', { options: { warnPercent: 85, autoGenPercent: 80 } }, async ($, on) => {
  setup(on, [HIT])
  await endTurn($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    expect((await ui.find({ type: 'Text', text: /Settings:/ }))?.text).toBe('Settings: warning threshold (85%) is not below auto-handoff (80%)')
    await ui.unmount()
  }
})

const START = { cwd: '/repo/my-project', surface: 'desktop', isInteractive: true } as const

test('a reload resumes a waiting handoff from a timer, not inside session.start', async ($, on) => {
  let isBusy = true
  const { clock, forks, handoff } = setup(on, [NOTE], { busyAgents: () => isBusy })
  await $.ui.mount({ ...BAND, surface: 'desktop' } as any).then(ui => ui.press({ key: 'handoff' } as any))
  await clock.settle()
  expect(handoff().status).toBe('waiting')

  isBusy = false
  await $.session.start(START as any)
  expect(forks()).toBe(0) // session.start returned before generating
  await clock.settle()
  expect(handoff().status).toBe('ready')
})

test('the elapsed-time ticker never undoes a finished step', async ($, on) => {
  const { clock, handoff } = setup(on, [NOTE], { forkDelayMs: 10_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'handoff' } as any)
  await clock.advance(10_000) // the fork answers as the ticker fires
  await clock.settle()
  expect(handoff().status).toBe('ready')
  expect(handoff().steps[3]).toEqual({ label: 'Writing the handoff', result: '10s', isDone: true })
})

test('a reload checks the thresholds again', async ($, on) => {
  setup(on, [HIT], { stale: { configWarning: 'warning threshold (85%) is not below auto-handoff (80%)' } })
  await $.session.start(START as any)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect(await ui.find({ type: 'Text', text: /Settings:/ })).toBeUndefined()
})

test('a reload in the due phase still prepares the handoff', async ($, on) => {
  const { clock, handoff } = setup(on, [NOTE], { stale: { cycle: { phase: 'due', kept: 3, dueAt: 0, isRetry: false, note: '' } } })
  await $.session.start(START as any)
  await clock.settle()
  expect(handoff().status).toBe('ready')
  expect(handoff().reasons).toEqual(['away'])
})

test('search directories are not counted as files', async ($, on) => {
  const messages = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'g', tool: 'Grep', input: { pattern: 'x', path: '/repo' } }] }]
  const { clock, handoff } = setup(on, [NOTE], { messages })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'handoff' } as any)
  await clock.settle()
  expect(handoff().steps[1].result).toBe('0 files')
})

test('a thrown keep-alive retries once, then stops', async ($, on) => {
  const { clock, forks, cycle } = setup(on, [new Error('boom')])
  await endTurn($)
  await clock.advance(50 * MIN)
  expect(cycle().phase).toBe('idle')
  expect(cycle().isRetry).toBe(true)
  await clock.advance(5 * MIN)
  expect(forks()).toBe(2)
  expect(cycle().phase).toBe('stopped')
  expect(cycle().note).toContain('keep-alive failed')
})

test('a failed agent lookup still generates the handoff', async ($, on) => {
  const { clock, handoff } = setup(on, [NOTE], { agentListFails: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'handoff' } as any)
  await clock.settle()
  expect(handoff().status).toBe('ready')
})

test('a double press of switch clears only once', async ($, on) => {
  const { clock, calls } = setup(on, [NOTE], { percent: 85, clearDelayMs: 1_000 })
  await endTurn($)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'switch' } as any)
  await clock.advance(500) // the first /clear is still running
  await ui.press({ key: 'switch' } as any)
  await clock.advance(2_000)
  await clock.settle()
  expect(calls.filter(c => c === '/clear')).toHaveLength(1)
})

test('a /clear starts the next conversation without the old handoff', async ($, on) => {
  const { clock, cycle, handoff } = setup(on, [NOTE], { percent: 85 })
  await endTurn($)
  await clock.settle()
  expect(handoff().status).toBe('ready')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
  expect(handoff()).toBeNull()
  expect(cycle()).toBeNull()
})

test('closing a manual handoff past the threshold holds the automatic one', async ($, on) => {
  const { clock, forks } = setup(on, [NOTE], { percent: 85 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'handoff' } as any)
  await clock.settle()
  await ui.press({ key: 'close' } as any)
  await ui.unmount()
  await endTurn($)
  await clock.settle()
  expect(forks()).toBe(1)
})

test('a long heading is clipped before the reason chip', async ($, on) => {
  const { clock } = setup(on, [{ isAnswered: false, reason: 'x'.repeat(200), usage: usage({ cache_read_input_tokens: 0 }) }])
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  await ui.press({ key: 'handoff' } as any)
  await clock.settle()
  const svg = await ui.find({ type: 'Svg' })
  const heading = String(svg?.props.source).match(/font-weight="700">([^<]*)</)?.[1] ?? ''
  expect(heading.startsWith('Handoff failed')).toBe(true)
  expect(heading.endsWith('…')).toBe(true)
  expect(heading.length).toBeLessThan(80)
})
