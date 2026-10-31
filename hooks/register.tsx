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
const handoff = atom({ plugin: 'handoff', key: 'handoff' } as const, null)
const isUsageHeld = atom({ plugin: 'handoff', key: 'isUsageHeld' } as const, false)
// null: not checked yet in this session; '': the thresholds are fine (3.2)
const configWarning = atom({ plugin: 'handoff', key: 'configWarning' } as const, null)
const lastTurnAt = atom({ plugin: 'handoff', key: 'lastTurnAt' } as const, null)

type Timer = { cancel: () => void }
type Settings = { isOn: boolean; count: number; intervalMs: number; usageStop: number; warn: number; autoGen: number }

let timer: Timer | undefined
let agentTimer: Timer | undefined

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

const save = ($: EngineInterface, c: Cycle) => update($, cycle, () => c)
const hold = ($: EngineInterface) => save($, { phase: 'held', kept: 0, dueAt: 0, isRetry: false, note: '' })
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

// One keep-alive step (1.1-1.5, 1.8); after N keeps, the handoff for being away (3.1).
const tick = async ($: EngineInterface, s: Settings) => {
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

// 5 (抑止中に離席の条件): an unchanged handoff is shown again instead of regenerated.
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
  const isBusy = (await $.agent.list()).some(a => a.status === 'running' || a.status === 'pending')
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

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const URL_RE = /https?:\/\/[^\s)>\]"'`]+/g

const generate = async ($: EngineInterface) => {
  const steps: Step[] = [
    { label: 'Reading the conversation', result: '', isDone: false },
    { label: 'Finding the files you used', result: '', isDone: false },
    { label: 'Listing skills, tools and links', result: '', isDone: false },
    { label: 'Writing the handoff', result: '', isDone: false },
    { label: 'Saving and checking', result: '', isDone: false },
  ]
  const done = async (i: number, result: string) => {
    steps[i] = { ...steps[i], result, isDone: true }
    await patch($, { steps: [...steps] })
  }
  await patch($, { status: 'generating', steps: [...steps], isStale: false, error: '' })

  try {
    const messages = await $.session.messages()
    await done(0, count(messages.length, 'message'))

    const uses = messages.flatMap(m => m.toolUses)
    const files = [...new Set(uses.flatMap(u => ['file_path', 'notebook_path'].map(k => u.input[k]).filter((v): v is string => typeof v === 'string')))]
    await done(1, count(files.length, 'file'))

    const skills = [...new Set(uses.filter(u => u.tool === 'Skill').map(u => String(u.input.skill ?? '')).filter(Boolean))]
    const tools = [...new Set(uses.map(u => u.tool))]
    const links = [...new Set(messages.flatMap(m => m.text.match(URL_RE) ?? []))].slice(0, 30)
    await done(2, `${count(skills.length, 'skill')}, ${count(links.length, 'link')}`)

    const startedAt = await $.clock.now()
    const ticker = $.clock.every(5000, () => void showElapsed($, steps, 3, startedAt))
    const r = await $.model.fork({ prompt: handoffPrompt(files, skills, tools, links) }).finally(() => ticker.cancel())
    if (!r.isAnswered) throw new Error(`fork: ${r.reason}`)
    await done(3, `${Math.round(((await $.clock.now()) - startedAt) / 1000)}s`)

    const home = (await $.env.get('HOME')) ?? ''
    const project = (await $.session.cwd()).split('/').filter(Boolean).at(-1) ?? 'session'
    const now = await $.clock.now()
    const last = await read($, lastTurnAt)
    const text = `Generated: ${when(now)}${last === null ? '' : ` · Last reply: ${when(last)}`}\n\n${r.text}`
    const path = `${home}/.claude/handoffs/${stamp(now)}-${project}.md`
    await $.fs.write(path, text)
    if ((await $.fs.read(path)) !== text) throw new Error(`could not read back what was saved: ${path}`)
    await done(4, path.split('/').at(-1) ?? path)

    await patch($, { status: 'ready', path, text })
  } catch (err) {
    await patch($, { status: 'failed', error: String(err) })
  }
}

const handoffPrompt = (files: string[], skills: string[], tools: string[], links: string[]) => {
  const list = (xs: string[]) => (xs.length === 0 ? 'なし' : xs.map(x => `- ${x}`).join('\n'))
  return `ここまでの会話を、新しいセッションで作業を再開するための引き継ぎ書にまとめてください。これは自動の依頼で、ユーザーのメッセージではありません。ツールは使えません。引き継ぎ書の本文だけを Markdown で出力してください。

先頭に1行で、これが引き継ぎ書であることと、内容を確認して作業を再開する指示を書いてください。続けて次の節をこの順で書き、該当がない節は「なし」とします。

1. 作業の目的と範囲
2. ユーザーの制約と指示
3. 現在の進捗
4. 検証済みの内容と結果
5. 変更済みだが未検証の内容
6. 未実施の内容
7. 失敗した方法とその理由
8. 決定事項と却下した案
9. 調査済みの事実と関連ファイル
10. 未完了の事項と次の具体的な作業
11. ユーザーの回答を待っている事項
12. 推奨スキル

書き方:
- 会話を一次情報とし、会話にないことは書かない。推測は推測と明記する。
- 省略すると再調査が必要になる情報（失敗の理由、数値、決定の根拠）を優先して残す。数値はそのまま書く。
- 既存の仕様書、計画、コミットにある内容は複製せず、パスや URL で参照する。
- 会話の中にしか実体がないもの（番号や名前で呼んだ指摘や案、貼り付けた内容、画像など）は、番号や名前だけでなく要旨も書く。
- API キー、パスワード、個人情報は伏せる。
- 長さは会話の規模に応じて必要十分にし、長くても 3000 語程度に収める。
- 会話の言語で書く。

会話から機械的に抽出した事実（参考にし、関係するものだけを書く）:

使ったファイル:
${list(files)}

使ったスキル:
${list(skills)}

使ったツール:
${list(tools)}

会話に出たリンク:
${list(links)}`
}

// 4.1: regenerate when stale, check the file, /clear, then send the handoff.
const switchSession = async ($: EngineInterface) => {
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
}

// 5: continue this session.
const closeHandoff = async ($: EngineInterface) => {
  const note = await read($, handoff)
  if (note === null) return
  await patch($, { isShown: false })
  if (note.reasons.includes('usage')) await update($, isUsageHeld, () => true)
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
  await update($, configWarning, () => problems.join('、'))
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
  if (note.status === 'waiting') return 'Handoff: waiting for running work to finish'
  if (note.status === 'generating') return `Preparing handoff${stale}`
  if (note.status === 'failed') return `Handoff failed: ${note.error}`
  return `Handoff ready: ${note.text.length.toLocaleString('en-US')} chars${stale}`
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

  const icon = (x: number, y: number, kind: 'done' | 'busy' | 'todo' | 'failed') => {
    if (kind === 'done') return `<circle cx="${x}" cy="${y}" r="8" fill="${TONE.success}"/><path d="M${x - 3.5} ${y}l2.5 2.5 4.5-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    if (kind === 'failed') return `<circle cx="${x}" cy="${y}" r="8" fill="${TONE.error}"/><path d="M${x - 3} ${y - 3}l6 6m0-6l-6 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>`
    if (kind === 'busy') return `<circle class="k" cx="${x}" cy="${y}" r="7" fill="none" stroke-width="2"/><circle cx="${x}" cy="${y}" r="7" fill="none" stroke="${TONE.warning}" stroke-width="2" stroke-linecap="round" stroke-dasharray="14 30"><animateTransform attributeName="transform" type="rotate" from="0 ${x} ${y}" to="360 ${x} ${y}" dur="0.9s" repeatCount="indefinite"/></circle>`
    return `<circle class="k" cx="${x}" cy="${y}" r="7" fill="none" stroke-width="1.5"/>`
  }

  const parts: string[] = []
  let y = SVG_PAD + 10
  parts.push(icon(SVG_PAD + 8, y, note.status === 'ready' ? 'done' : note.status === 'failed' ? 'failed' : 'busy'))
  parts.push(`<text x="${SVG_PAD + 24}" y="${y + 5}" fill="${tone}" font-size="14" font-weight="700">${xml(headingOf(note))}</text>`)
  const chip = note.reasons.map(r => REASON[r]).join(' · ')
  const chipW = Math.round(chip.length * 6.5) + 18
  parts.push(`<rect class="chip" x="${right - chipW}" y="${y - 10}" width="${chipW}" height="20" rx="10"/><text class="m" x="${right - chipW / 2}" y="${y + 4}" text-anchor="middle" font-size="11">${xml(chip)}</text>`)

  if (note.steps.length > 0) {
    y += 22
    const ratio = note.steps.filter(step => step.isDone).length / note.steps.length
    const barW = right - SVG_PAD
    parts.push(`<rect class="k" x="${SVG_PAD}" y="${y}" width="${barW}" height="4" rx="2"/>`)
    if (ratio > 0) parts.push(`<rect x="${SVG_PAD}" y="${y}" width="${Math.max(4, Math.round(barW * ratio))}" height="4" rx="2" fill="${tone}"/>`)
    y += 10
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

  if (note.status === 'ready') {
    y += 8
    parts.push(`<line class="rule" x1="${SVG_PAD}" y1="${y}" x2="${right}" y2="${y}"/>`)
    y += 20
    parts.push(`<text class="m" x="${SVG_PAD}" y="${y}" font-size="12">${xml(clip(`Saved to ${note.path}`, Math.floor((right - SVG_PAD) / 7)))}</text>`)
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
    const note = await read($, handoff)
    if (note?.status === 'waiting') agentTimer = $.clock.after(0, () => void waitForAgents($))
    if (note?.status === 'generating') await patch($, { status: 'failed', error: 'interrupted by a mod reload' })
    if (c?.phase === 'due' && note?.status !== 'waiting') await requestHandoff($, ['away'])
    // A settings change reloads the module with new options: check the thresholds again.
    await update($, configWarning, () => null)
    await checkThresholds($, s).catch(() => undefined)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    timer?.cancel()
    agentTimer?.cancel()
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await patch($, { isStale: true })
    return result
  }).catch(($, e, next) => next(e)) // never block a compact

  // 6: a resumed session keeps its cache only within the TTL; time the cycle from its last response.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'resume' && s.isOn && e.prompt_cache_likely_expired === false) {
      const sinceMs = (e.seconds_since_last_response ?? 0) * 1000
      await idleFrom($, s, { phase: 'off', kept: 0, dueAt: 0, isRetry: false, note: '' }, Math.max(0, s.intervalMs - sinceMs), false)
    }
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
    await save($, { phase: 'turn', kept: 0, dueAt: 0, isRetry: false, note: '' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const endedAt = await $.clock.now()
    await update($, lastTurnAt, () => endedAt)

    const note = await read($, handoff)
    const isShowing = note !== null && note.isShown
    const base: Cycle = { phase: 'off', kept: 0, dueAt: 0, isRetry: false, note: '' }
    if (isShowing) await hold($) // 4: no keep-alive while the confirmation waits
    else if (s.isOn) await idleFrom($, s, base, s.intervalMs, false)
    else await save($, base)

    await checkThresholds($, s).catch(() => undefined)

    const percent = (await $.session.usage()).context.percent
    if (percent === undefined) return result // 2: none right after a compact

    // 2: warn once per crossing of the warning threshold.
    const wasWarned = await read($, isWarned)
    if (percent > s.warn && !wasWarned) $.ui.toast(`Context is at ${percent}%. Consider a handoff.`)
    if (percent > s.warn !== wasWarned) await update($, isWarned, () => percent > s.warn)

    // 5: the usage hold lifts once usage falls below the warning threshold.
    if (percent < s.warn) await update($, isUsageHeld, () => false)

    if (percent >= 100) $.ui.toast('Context is full. Run /compact or start a handoff.')
    else if (percent > s.autoGen && !(await read($, isUsageHeld)) && !isShowing) await requestHandoff($, ['usage'])
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const c = await read($, cycle)
    const note = await read($, handoff)
    const percent = (await $.session.usage()).context.percent
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
          {note.status === 'ready' ? <Button key="switch" variant="primary" label="Start new chat with it" onPress={() => void $.clock.after(0, () => void switchSession($))} /> : null}
          {note.status === 'ready' ? <Button key="copy" variant="secondary" label="Copy handoff prompt" onPress={() => $.ui.copy({ text: `Read ${note.path} and resume the work it describes.` })} /> : null}
          {note.status === 'ready' ? <Button key="open" variant="secondary" label="Open file" onPress={() => openFile($, note.path)} /> : null}
          {note.status === 'failed' ? <Button key="retry" variant="primary" label="Try again" onPress={() => requestHandoff($, ['manual'])} /> : null}
          {isBusy ? null : <Button key="close" variant="secondary" label="Close" onPress={() => closeHandoff($)} />}
        </Box>
      )
      if (e.surface !== 'terminal' && 'Svg' in ui) {
        const { Svg } = ui
        const width = Math.max(320, Math.min(640, (e.props.bodyColumns || 80) * 8 - 32))
        const drawn = noteSvg(note, width)
        return (
          <Box flexDirection="column" gap={1}>
            <Svg key="note" source={drawn.source} alt={headingOf(note)} width={width} height={drawn.height} isInteractive={isBusy ? true : undefined} />
            {buttons}
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
                <Box width={33} flexShrink={0}>
                  <Text dimColor={!step.isDone && !isCurrent} wrap="truncate-end">{i + 1}. {step.label}</Text>
                </Box>
                {bar(`bar-${i}`, step.isDone ? 1 : isCurrent ? 0.5 : 0, color, BAR, BAR_PX)}
                <Text dimColor wrap="truncate-middle">{step.result}{isCurrent ? ' …' : ''}</Text>
              </Box>
            )
          })}
          {note.status === 'ready' ? <Text dimColor wrap="truncate-middle">Saved to {note.path}</Text> : null}
          <Box marginTop={1}>{buttons}</Box>
        </Box>
      )
    }

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
