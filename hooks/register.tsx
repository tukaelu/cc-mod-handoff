import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cycle, Handoff, Reason, Step } from '../types'

const MIN = 60_000
const RETRY_MS = 5 * MIN
const AGENT_POLL_MS = 30_000
const BAR = 12 // cells of a step's bar in the confirmation band (terminal)
const GAUGE = 12 // cells of the context gauge (terminal)
const BAR_PX = 120 // the same bars on surfaces that draw SVG
const GAUGE_PX = 96
const BAR_H = 6
// SVG cannot read the theme: fixed mid tones that read on light and dark.
const TONE: Record<string, string> = { success: '#4caf7d', warning: '#d6a23a', error: '#e5534b', subtle: '#9a9a9a' }

// A thin rounded bar: `ratio` of it filled in `tone`, on a track that follows the color scheme.
const barSvg = (ratio: number, tone: string, width: number) => {
  const fill = Math.round(width * Math.max(0, Math.min(1, ratio)))
  const r = BAR_H / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAR_H}" viewBox="0 0 ${width} ${BAR_H}">
<style>.k{fill:#e4e4e2}@media (prefers-color-scheme: dark){.k{fill:#3a3a3a}}</style>
<rect class="k" width="${width}" height="${BAR_H}" rx="${r}"/>
${fill > 0 ? `<rect width="${Math.max(fill, BAR_H)}" height="${BAR_H}" rx="${r}" fill="${TONE[tone] ?? TONE.subtle}"/>` : ''}
</svg>`
}
const KEEP_PROMPT = 'This is an automated prompt-cache keep-alive, not a user message. Reply with only: ok'

const cycle = atom({ plugin: 'handoff', key: 'cycle' } as const, null)
const isWarned = atom({ plugin: 'handoff', key: 'isWarned' } as const, false)
const isFull = atom({ plugin: 'handoff', key: 'isFull' } as const, false)
const handoff = atom({ plugin: 'handoff', key: 'handoff' } as const, null)
const isUsageHeld = atom({ plugin: 'handoff', key: 'isUsageHeld' } as const, false)
// null: not checked yet in this session; '': the thresholds are fine (3.2)
const configWarning = atom({ plugin: 'handoff', key: 'configWarning' } as const, null)
const lastTurnAt = atom({ plugin: 'handoff', key: 'lastTurnAt' } as const, null)
// Turn ends by session id, kept across processes: a `claude --resume` starts a new one with no classic.SessionStart.
const LAST_TURNS = 'lastTurns'
const storedTurns = async ($: EngineInterface) => ((await $.store.get(LAST_TURNS)) ?? {}) as Record<string, number>

type Timer = { cancel: () => void }
type Settings = { isOn: boolean; count: number; intervalMs: number; usageStop: number; warn: number; autoGen: number }

let timer: Timer | undefined
let agentTimer: Timer | undefined
let isSwitching = false

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const when = (ms: number) => `${day(new Date(ms))} ${hhmm(ms)}`

const stamp = (ms: number) => {
  const d = new Date(ms)
  return `${day(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const OFF: Cycle = { phase: 'off', kept: 0, dueAt: 0, isRetry: false, note: '' }
const save = ($: EngineInterface, c: Cycle) => update($, cycle, () => c)
const hold = ($: EngineInterface) => save($, { ...OFF, phase: 'held' })
const patch = ($: EngineInterface, p: Partial<Handoff>) => update($, handoff, note => (note === null ? note : { ...note, ...p }))

const schedule = async ($: EngineInterface, s: Settings, c: Cycle) => {
  timer?.cancel()
  timer = $.clock.after(Math.max(0, c.dueAt - (await $.clock.now())), () => void tick($, s))
}

const idleFrom = async ($: EngineInterface, s: Settings, c: Cycle, waitMs: number, isRetry: boolean) => {
  const next: Cycle = { ...c, phase: 'idle', dueAt: (await $.clock.now()) + waitMs, isRetry }
  await save($, next)
  await schedule($, s, next)
}

// 6: a resumed session keeps its cache only within the interval; time the cycle from its last response.
const resumeFrom = async ($: EngineInterface, s: Settings, sinceMs: number) => {
  if (s.isOn && sinceMs < s.intervalMs) await idleFrom($, s, OFF, s.intervalMs - sinceMs, false)
}

// A thrown step is a failed keep: retry once, then stop.
const tick = async ($: EngineInterface, s: Settings) => {
  try {
    await keep($, s)
  } catch (err) {
    const c = await read($, cycle)
    if (c === null) return
    if (c.phase === 'idle' || c.phase === 'keeping') {
      if (!c.isRetry) return idleFrom($, s, c, RETRY_MS, true)
      return save($, { ...c, phase: 'stopped', note: `keep-alive failed: ${String(err)}` })
    }
    // The away handoff broke before its note existed: say so instead of waiting forever.
    const isLost = c.phase === 'due' || (c.phase === 'held' && (await read($, handoff)) === null)
    if (isLost) await save($, { ...c, phase: 'stopped', note: `could not start the handoff: ${String(err)}` })
  }
}

// One keep-alive step (1.1-1.5, 1.8); after N keeps, the handoff for being away (3.1).
const keep = async ($: EngineInterface, s: Settings) => {
  const c = await read($, cycle)
  if (c === null || c.phase !== 'idle') return
  if (c.kept >= s.count) {
    await save($, { ...c, phase: 'due' })
    return requestHandoff($, ['away'])
  }

  const limit = (await $.session.usage()).rateLimits.find(r => r.percentUsed >= s.usageStop)
  if (limit) return save($, { ...c, phase: 'stopped', note: `plan usage ${limit.kind} at ${limit.percentUsed}%` })

  await save($, { ...c, phase: 'keeping' })
  const r = await $.model.fork({ prompt: KEEP_PROMPT })
  const now = await read($, cycle)
  if (now === null || now.phase !== 'keeping') return // a real turn started meanwhile

  if (r.isAnswered && r.usage.cache_read_input_tokens > 0) {
    return idleFrom($, s, { ...now, kept: now.kept + 1 }, s.intervalMs, false)
  }
  if (r.isAnswered) return save($, { ...now, phase: 'stopped', note: 'no cache hit; the TTL may be 5m' })
  if (!now.isRetry) return idleFrom($, s, now, RETRY_MS, true)
  return save($, { ...now, phase: 'stopped', note: `keep-alive failed: ${r.reason}` })
}

// 5 (away while held): an unchanged handoff is shown again instead of regenerated.
const requestHandoff = async ($: EngineInterface, reasons: Reason[]) => {
  const note = await read($, handoff)
  if (note !== null && (note.status === 'waiting' || note.status === 'generating')) {
    return patch($, { reasons: [...new Set([...note.reasons, ...reasons])] })
  }
  if (note !== null && note.status === 'ready' && !note.isStale) {
    await hold($)
    return patch($, { reasons: [...new Set([...note.reasons, ...reasons])], isShown: true })
  }
  await hold($)
  await update($, handoff, () => ({ status: 'waiting', reasons, steps: [], path: '', text: '', error: '', isStale: false, isShown: true }))
  // Generation outlasts a hook's 10 s budget: run it from a timer, not from the caller's hook.
  agentTimer = $.clock.after(0, () => void waitForAgents($))
}

// 3.3: wait for subagents; a real turn start cancels the wait.
const waitForAgents = async ($: EngineInterface) => {
  agentTimer?.cancel()
  const note = await read($, handoff)
  if (note === null || note.status !== 'waiting') return
  // A failed lookup must not leave the band stuck in 'waiting', which has no Close.
  const isBusy = (await $.agent.list().catch(() => [])).some(a => a.status === 'running' || a.status === 'pending')
  if (isBusy) {
    agentTimer = $.clock.after(AGENT_POLL_MS, () => void waitForAgents($))
    return
  }
  return generate($)
}

const showElapsed = async ($: EngineInterface, steps: Step[], i: number, startedAt: number) => {
  const now = await $.clock.now()
  if (steps[i].isDone) return // done() may have landed while reading the clock
  steps[i] = { ...steps[i], result: `${Math.round((now - startedAt) / 1000)}s` }
  await patch($, { steps: [...steps] })
}

const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g

const generate = async ($: EngineInterface) => {
  const steps: Step[] = [
    { label: 'Summarizing', result: '', isDone: false },
    { label: 'Writing to disk & verifying', result: '', isDone: false },
  ]
  const done = async (i: number, result: string) => {
    steps[i] = { ...steps[i], result, isDone: true }
    await patch($, { steps: [...steps] })
  }
  await patch($, { status: 'generating', steps: [...steps], isStale: false, error: '' })

  try {
    const messages = await $.session.messages()
    const uses = messages.flatMap(m => m.toolUses)
    const files = [...new Set(uses.flatMap(u => ['file_path', 'notebook_path'].map(k => u.input[k]).filter((v): v is string => typeof v === 'string')))]
    const skills = [...new Set(uses.filter(u => u.tool === 'Skill').map(u => String(u.input.skill ?? '')).filter(Boolean))]
    const tools = [...new Set(uses.map(u => u.tool))]
    const links = [...new Set(messages.flatMap(m => m.text.match(URL_RE) ?? []))].slice(0, 30)

    const startedAt = await $.clock.now()
    const ticker = $.clock.every(5000, () => void showElapsed($, steps, 0, startedAt))
    const r = await $.model.fork({ prompt: handoffPrompt(files, skills, tools, links) }).finally(() => ticker.cancel())
    if (!r.isAnswered) throw new Error(`fork: ${r.reason}`)
    await done(0, `${Math.round(((await $.clock.now()) - startedAt) / 1000)}s`)

    const home = (await $.env.get('HOME')) ?? ''
    const project = (await $.session.cwd()).split('/').filter(Boolean).at(-1) ?? 'session'
    const now = await $.clock.now()
    const last = await read($, lastTurnAt)
    const text = `Generated: ${when(now)}${last === null ? '' : ` · Last reply: ${when(last)}`}\n\n${r.text}`
    const path = `${home}/.claude/handoffs/${stamp(now)}-${project}.md`
    await $.fs.write(path, text)
    if ((await $.fs.read(path)) !== text) throw new Error(`could not read back what was saved: ${path}`)
    await done(1, path.split('/').at(-1) ?? path)

    await patch($, { status: 'ready', path, text })
  } catch (err) {
    await patch($, { status: 'failed', error: String(err) })
  }
}

const handoffPrompt = (files: string[], skills: string[], tools: string[], links: string[]) => {
  const list = (xs: string[]) => (xs.length === 0 ? 'None' : xs.map(x => `- ${x}`).join('\n'))
  return `Summarize the conversation so far as a handoff note for resuming the work in a new session. This is an automated request, not a message from the user. No tools are available. Output only the body of the note, in Markdown.

Start with one line saying that this is a handoff note and telling the reader to review it and then resume the work. Then write the following sections in this order; for a section with nothing to report, write "None".

1. Goal and scope of the work
2. The user's constraints and instructions
3. Current progress
4. What has been verified, and the results
5. What has been changed but not verified
6. What has not been done yet
7. Approaches that failed, and why
8. Decisions made and options rejected
9. Facts already investigated, and related files
10. Open items and the concrete next steps
11. Questions waiting for the user's answer
12. Recommended skills

How to write it:
- Treat the conversation as the primary source and write nothing that is not in it. Mark guesses as guesses.
- Keep first what would otherwise have to be looked up again: the reasons for failures, numbers, the grounds for decisions. Write numbers as they are.
- Do not copy what existing specs, plans or commits already hold; refer to them by path or URL.
- For things that exist only in the conversation (points or options referred to by number or name, pasted content, images), write their gist, not only the number or name.
- Redact API keys, passwords and personal information.
- Make it as long as the conversation needs, and no longer than about 3000 words.
- Write the whole note, section headings included, in the language the user writes in.

Facts extracted mechanically from the conversation (for reference; include only those that matter):

Files used:
${list(files)}

Skills used:
${list(skills)}

Tools used:
${list(tools)}

Links in the conversation:
${list(links)}`
}

// 4.1: regenerate when stale, check the file, /clear, then send the handoff.
// A second press must not /clear the conversation the first one started.
const switchSession = async ($: EngineInterface) => {
  if (isSwitching) return
  isSwitching = true
  try {
    let note = await read($, handoff)
    if (note === null) return
    if (note.isStale) {
      await generate($)
      note = await read($, handoff)
      if (note === null || note.status !== 'ready') return
    }
    if (!(await $.fs.exists(note.path))) return patch($, { status: 'failed', error: `handoff file not found: ${note.path}` })
    const text = note.text
    await $.command.run({ command: 'clear' })
    await $.prompt.submit({ text, asUser: true })
  } finally {
    isSwitching = false
  }
}

// 5: continue this session.
const closeHandoff = async ($: EngineInterface, s: Settings) => {
  const note = await read($, handoff)
  if (note === null) return
  await patch($, { isShown: false })
  // Closing any handoff past the threshold holds the automatic one, not only a 'usage' one.
  const percent = (await $.session.usage()).context.percent
  if (note.reasons.includes('usage') || (percent !== undefined && percent > s.autoGen)) await update($, isUsageHeld, () => true)
  await hold($) // the cycle starts again at the next real turn's end
}

// 3.2: warning < auto-generation < Claude Code's auto-compact, checked once per session.
const checkThresholds = async ($: EngineInterface, s: Settings) => {
  if ((await read($, configWarning)) !== null) return
  const problems: string[] = []
  if (s.warn >= s.autoGen) problems.push(`warning threshold (${s.warn}%) is not below auto-handoff (${s.autoGen}%)`)
  const context = (await $.session.usage({ breakdown: 'summary' })).context
  const limit = context.breakdown?.autoCompactThreshold
  if (limit !== undefined && context.window > 0) {
    const compact = Math.floor((limit / context.window) * 100)
    if (s.autoGen >= compact) problems.push(`auto-handoff (${s.autoGen}%) is not below auto-compact (${compact}%)`)
  }
  await update($, configWarning, () => problems.join('; '))
}

const openFile = async ($: EngineInterface, path: string) => {
  const r = await $.process.run(['open', path])
  if (r.exitCode !== 0) $.ui.toast(`Could not open the file: ${r.stderr}`)
}

// The keep-alive state in words a person reads at a glance, with the dot's color.
const statusOf = (c: Cycle | null, s: Settings): { text: string; tone: string } | null => {
  if (c === null || c.phase === 'turn' || c.phase === 'held') return null
  if (c.phase === 'off') return { text: 'Cache keep-alive off', tone: 'subtle' }
  if (c.phase === 'keeping') return { text: 'Refreshing the cache…', tone: 'warning' }
  if (c.phase === 'stopped') return { text: `Cache keep-alive stopped (${c.note})`, tone: 'error' }
  if (c.phase === 'due') return { text: 'Away for a while — preparing a handoff', tone: 'warning' }
  const left = s.count - c.kept
  const retry = c.isRetry ? ' (retrying after a failure)' : ''
  if (left === 0) return { text: `Cache kept warm · handoff at ${hhmm(c.dueAt)}${retry}`, tone: 'success' }
  return { text: `Cache kept warm · next refresh ${hhmm(c.dueAt)} (${left} left)${retry}`, tone: 'success' }
}

const headingOf = (note: Handoff) => {
  const stale = note.isStale ? ' (conversation moved on)' : ''
  if (note.status === 'waiting') return 'Waiting for running agents to finish'
  if (note.status === 'generating') return `Drafting a handoff note${stale}…`
  if (note.status === 'failed') return `Couldn't write the note: ${note.error}`
  return `Note saved · ${note.text.length.toLocaleString('en-US')} chars${stale}`
}

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Hiragino Sans','Segoe UI',sans-serif"
const REASON: Record<Reason, string> = { away: 'away', usage: 'context', manual: 'manual' }
const xml = (text: string) => text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

const SVG_PAD = 16
const SVG_ROW = 26

// The confirmation band drawn whole, for surfaces with `Svg` (7.1); the buttons stay native beneath it.
const noteSvg = (note: Handoff, width: number) => {
  const tone = TONE[note.status === 'ready' ? 'success' : note.status === 'failed' ? 'error' : 'warning']
  const isBusy = note.status === 'waiting' || note.status === 'generating'
  const current = note.steps.findIndex(step => !step.isDone)
  const right = width - SVG_PAD

  const icon = (x: number, y: number, kind: 'done' | 'busy' | 'todo') => {
    if (kind === 'done') return `<circle cx="${x}" cy="${y}" r="8" fill="${TONE.success}"/><path d="M${x - 3.5} ${y}l2.5 2.5 4.5-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    if (kind === 'busy') return `<circle class="k" cx="${x}" cy="${y}" r="7" fill="none" stroke-width="2"/><circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${TONE.warning}" stroke-width="2" stroke-linecap="round" stroke-dasharray="14 30"><animateTransform attributeName="transform" type="rotate" from="0 ${x} ${y}" to="360 ${x} ${y}" dur="0.9s" repeatCount="indefinite"/></circle>`
    return `<circle class="k" cx="${x}" cy="${y}" r="7" fill="none" stroke-width="1.5"/>`
  }

  const parts: string[] = []
  let y = SVG_PAD + 10
  // Waiting has no steps yet: the heading carries the only sign of life.
  const isWaiting = note.status === 'waiting'
  const headX = isWaiting ? SVG_PAD + 24 : SVG_PAD
  if (isWaiting) parts.push(icon(SVG_PAD + 8, y, 'busy'))
  const chip = note.reasons.map(r => REASON[r]).join(' · ')
  const chipW = Math.round(chip.length * 6.5) + 18
  const headingChars = Math.floor((right - chipW - 8 - headX) / 8)
  parts.push(`<text x="${headX}" y="${y + 5}" fill="${tone}" font-size="14" font-weight="700">${xml(clip(headingOf(note), headingChars))}</text>`)
  parts.push(`<rect class="chip" x="${right - chipW}" y="${y - 10}" width="${chipW}" height="20" rx="10"/><text class="m" x="${right - chipW / 2}" y="${y + 4}" text-anchor="middle" font-size="11">${xml(chip)}</text>`)

  if (note.steps.length > 0) {
    y += 12
    note.steps.forEach((step, i) => {
      const cy = y + SVG_ROW / 2 + 2
      const kind = step.isDone ? 'done' : note.status === 'generating' && i === current ? 'busy' : 'todo'
      parts.push(icon(SVG_PAD + 8, cy, kind))
      parts.push(`<text class="${kind === 'todo' ? 'm' : 't'}" x="${SVG_PAD + 24}" y="${cy + 4.5}" font-size="13">${xml(step.label)}</text>`)
      const result = step.result === '' ? '' : `${step.result}${kind === 'busy' ? ' …' : ''}`
      parts.push(`<text class="m" x="${right}" y="${cy + 4.5}" text-anchor="end" font-size="12" font-variant-numeric="tabular-nums">${xml(clip(result, 40))}</text>`)
      y += SVG_ROW
    })
  } else if (isBusy) {
    y += 8
  }

  // Below about 600 px the four buttons wrap to two rows: drop the path line to stay within the band's height.
  if (note.status === 'ready' && width >= 600) {
    y += 8
    parts.push(`<line class="rule" x1="${SVG_PAD}" y1="${y}" x2="${right}" y2="${y}"/>`)
    y += 20
    parts.push(`<text class="m" x="${SVG_PAD}" y="${y}" font-size="12">${xml(clip(`Stored at ${note.path}`, Math.floor((right - SVG_PAD) / 7)))}</text>`)
  }
  const height = y + SVG_PAD - 4

  return {
    height,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">
<style>
.t{fill:#1f1f1f}.m{fill:#6e6e6e}.k{stroke:#d9d9d6;fill:#e4e4e2}.chip{fill:#ececea}.rule{stroke:#e2e2df}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{stroke:#3d3d3d;fill:#3a3a3a}.chip{fill:#2e2e2e}.rule{stroke:#333}}
circle.k{fill:none}
</style>
${parts.join('\n')}
</svg>`,
  }
}

export const register: Register = (on, options) => {
  const s: Settings = {
    isOn: options.keepAlive !== false,
    count: Number(options.keepAliveCount ?? 3),
    intervalMs: Number(options.keepAliveIntervalMin ?? 50) * MIN,
    usageStop: Number(options.usageStopPercent ?? 90),
    warn: Number(options.warnPercent ?? 60),
    autoGen: Number(options.autoGenPercent ?? 80),
  }

  // A hot reload drops the timers; pick the work up again from $.state.
  on('session.start', async ($, e, next) => {
    const c = await read($, cycle)
    if (c?.phase === 'idle') await schedule($, s, c)
    if (c?.phase === 'keeping') await idleFrom($, s, c, 0, c.isRetry)
    if (c === null) {
      const at = (await storedTurns($).catch(() => ({}) as Record<string, number>))[await $.session.id()]
      if (at !== undefined) {
        await update($, lastTurnAt, () => at)
        await resumeFrom($, s, (await $.clock.now()) - at)
      }
    }
    const note = await read($, handoff)
    if (note?.status === 'waiting') agentTimer = $.clock.after(0, () => void waitForAgents($))
    if (note?.status === 'generating') await patch($, { status: 'failed', error: 'interrupted by a mod reload' })
    if (c?.phase === 'due' && note?.status !== 'waiting') await requestHandoff($, ['away'])
    // A settings change reloads the module with new options: check the thresholds again.
    await update($, configWarning, () => null)
    await checkThresholds($, s).catch(() => undefined)
    return next(e)
  })

  // A /clear or resume goes on in this process with no session.start: start the next conversation clean.
  on('session.end', async ($, e, next) => {
    timer?.cancel()
    agentTimer?.cancel()
    await Promise.all([
      update($, cycle, () => null),
      update($, handoff, () => null),
      update($, isWarned, () => false),
      update($, isFull, () => false),
      update($, isUsageHeld, () => false),
      update($, configWarning, () => null),
      update($, lastTurnAt, () => null),
    ])
    return next(e)
  }).catch(($, e, next) => next(e)) // never hold up an exit

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await patch($, { isStale: true })
    return result
  }).catch(($, e, next) => next(e)) // never block a compact

  // A resume within this process: no session.start, but the settings hook's input says how long ago.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume' && e.seconds_since_last_response !== undefined) await resumeFrom($, s, e.seconds_since_last_response * 1000)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    timer?.cancel()
    const note = await read($, handoff)
    if (note?.status === 'waiting') {
      agentTimer?.cancel()
      await update($, handoff, () => null) // 3.3: a real turn cancels the wait
    } else if (note !== null) {
      await patch($, { isStale: true })
    }
    await save($, { ...OFF, phase: 'turn' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const endedAt = await $.clock.now()
    await update($, lastTurnAt, () => endedAt)
    // A broken store only costs the next resume its keep-alive, never this turn's.
    await (async () => {
      const kept = Object.entries(await storedTurns($)).filter(([, at]) => endedAt - at < s.intervalMs)
      await $.store.set(LAST_TURNS, { ...Object.fromEntries(kept), [await $.session.id()]: endedAt })
    })().catch(() => undefined)

    const note = await read($, handoff)
    const isShowing = note !== null && note.isShown
    if (isShowing) await hold($) // 4: no keep-alive while the confirmation waits
    else if (s.isOn) await idleFrom($, s, OFF, s.intervalMs, false)
    else await save($, OFF)

    await checkThresholds($, s).catch(() => undefined)

    const percent = (await $.session.usage()).context.percent
    if (percent === undefined) return result // 2: none right after a compact

    // 2: warn once per crossing of the warning threshold.
    const wasWarned = await read($, isWarned)
    if (percent > s.warn && !wasWarned) $.ui.toast(`Context is at ${percent}%. Consider a handoff.`)
    if (percent > s.warn !== wasWarned) await update($, isWarned, () => percent > s.warn)

    // 5: the usage hold lifts once usage falls below the warning threshold.
    if (percent < s.warn) await update($, isUsageHeld, () => false)

    // Once per filling, like the warning above.
    const wasFull = await read($, isFull)
    if (percent >= 100 && !wasFull) $.ui.toast('Context is full. Run /compact or start a handoff.')
    if (percent >= 100 !== wasFull) await update($, isFull, () => percent >= 100)
    if (percent >= 100) return result
    if (percent > s.autoGen && !(await read($, isUsageHeld)) && !isShowing) await requestHandoff($, ['usage'])
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const c = await read($, cycle)
    const note = await read($, handoff)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const status = statusOf(c, s)
    // The terminal's element table carries an `Svg` that draws nothing: test the surface too.
    const bar = (key: string, ratio: number, tone: string, cells: number, px: number) => {
      if (e.surface !== 'terminal' && 'Svg' in ui) {
        const { Svg } = ui
        return <Svg key={key} source={barSvg(ratio, tone, px)} alt={`${Math.round(ratio * 100)}%`} width={px} height={BAR_H} />
      }
      const filled = Math.round(cells * ratio)
      return (
        <Text key={key}>
          <Text color={tone}>{'▰'.repeat(filled)}</Text>
          <Text color="subtle">{'▱'.repeat(cells - filled)}</Text>
        </Text>
      )
    }

    if (note !== null && note.isShown) {
      const isBusy = note.status === 'waiting' || note.status === 'generating'
      const buttons = (
        <Box gap={1}>
          {note.status === 'ready' ? <Button key="switch" variant="primary" label="Resume in a fresh chat" onPress={() => void $.clock.after(0, () => void switchSession($))} /> : null}
          {note.status === 'ready' ? <Button key="copy" variant="secondary" label="Copy resume prompt" onPress={() => $.ui.copy({ text: `Read ${note.path} and resume the work it describes.` })} /> : null}
          {note.status === 'ready' ? <Button key="open" variant="secondary" label="View note" onPress={() => openFile($, note.path)} /> : null}
          {note.status === 'failed' ? <Button key="retry" variant="primary" label="Try again" onPress={() => requestHandoff($, ['manual'])} /> : null}
          {isBusy ? null : <Button key="close" variant="secondary" label="Keep going here" onPress={() => closeHandoff($, s)} />}
        </Box>
      )
      if (e.surface !== 'terminal' && 'Svg' in ui) {
        const { Svg } = ui
        // Measured on desktop only: 85 columns span a band about 768 px wide, so about 9 px a column.
        // Other surfaces keep the narrower guess until measured.
        const cols = e.props.bodyColumns || 80
        const width = Math.max(320, e.surface === 'desktop' ? Math.min(960, cols * 9 - 24) : Math.min(640, cols * 8 - 32))
        const drawn = noteSvg(note, width)
        return (
          <Box flexDirection="column" gap={1}>
            <Svg key="note" source={drawn.source} alt={headingOf(note)} width={width} height={drawn.height} isInteractive={isBusy ? true : undefined} />
            {isBusy ? null : buttons}
          </Box>
        )
      }
      const current = note.steps.findIndex(step => !step.isDone)
      const tone = note.status === 'ready' ? 'success' : note.status === 'failed' ? 'error' : 'warning'
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text bold color={tone}>{headingOf(note)}</Text>
          {note.steps.map((step, i) => {
            const isCurrent = note.status === 'generating' && i === current
            const color = step.isDone ? 'success' : isCurrent ? 'warning' : 'subtle'
            return (
              <Box key={`step-${i}`} gap={1} alignItems="center">
                <Box width={2} flexShrink={0} justifyContent="center">
                  <Text color={color}>{step.isDone ? '✓' : isCurrent ? '▸' : '·'}</Text>
                </Box>
                <Box width={38} flexShrink={0}>
                  <Text dimColor={!step.isDone && !isCurrent} wrap="truncate-end">{i + 1}. {step.label}</Text>
                </Box>
                {bar(`bar-${i}`, step.isDone ? 1 : isCurrent ? 0.5 : 0, color, BAR, BAR_PX)}
                <Text dimColor wrap="truncate-middle">{step.result}{isCurrent ? ' …' : ''}</Text>
              </Box>
            )
          })}
          {note.status === 'ready' ? <Text dimColor wrap="truncate-middle">Stored at {note.path}</Text> : null}
          {isBusy ? null : <Box marginTop={1}>{buttons}</Box>}
        </Box>
      )
    }

    const percent = (await $.session.usage()).context.percent
    const warning = await read($, configWarning)
    const level = percent === undefined || percent <= s.warn ? 'success' : percent <= s.autoGen ? 'warning' : 'error'
    return (
      <Box flexDirection="column">
        <Box gap={2} alignItems="center">
          <Box gap={1} alignItems="center">
            <Text dimColor>Context</Text>
            {bar('gauge', (percent ?? 0) / 100, level, GAUGE, GAUGE_PX)}
            <Text bold color={level}>{percent ?? '-'}%</Text>
          </Box>
          {status === null ? null : (
            <Box gap={1} alignItems="center">
              <Text color={status.tone}>●</Text>
              <Text dimColor>{status.text}</Text>
            </Box>
          )}
          <Box flexGrow={1} />
          <Button key="handoff" variant="secondary" label="Handoff" onPress={() => requestHandoff($, ['manual'])} />
        </Box>
        {warning ? <Text color="warning">Settings: {warning}</Text> : null}
      </Box>
    )
  })
}
