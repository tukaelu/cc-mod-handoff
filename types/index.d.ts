// off: keep-alive off / turn: a real turn runs / idle: waiting for the next keep-alive / keeping: a keep-alive request runs
// stopped: keep-alive stopped / due: kept N times, time to write the note / held: a note is shown or was closed; no keep-alive
export type Phase = 'off' | 'turn' | 'idle' | 'keeping' | 'stopped' | 'due' | 'held'
export type Cycle = { phase: Phase; kept: number; dueAt: number; isRetry: boolean; note: string }

export type Reason = 'away' | 'usage' | 'manual'
export type Step = { label: string; result: string; isDone: boolean }
// waiting: for running agents to finish / generating: writing the note / ready: waiting for a choice / failed: could not write it
export type Handoff = {
  status: 'waiting' | 'generating' | 'ready' | 'failed'
  reasons: Reason[]
  steps: Step[]
  path: string
  text: string
  error: string
  isStale: boolean
  isShown: boolean
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { cycle: Cycle | null; isWarned: boolean; isFull: boolean; handoff: Handoff | null; isUsageHeld: boolean; configWarning: string | null; lastTurnAt: number | null }
  }
}
