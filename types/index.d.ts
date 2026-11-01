// off: 維持オフ / turn: 実ターン中 / idle: 次の維持を待つ / keeping: 維持リクエスト中
// stopped: 維持停止 / due: N 回維持して生成の時刻になった / held: 引き継ぎ書の表示中か続行後で、維持しない
export type Phase = 'off' | 'turn' | 'idle' | 'keeping' | 'stopped' | 'due' | 'held'
export type Cycle = { phase: Phase; kept: number; dueAt: number; isRetry: boolean; note: string }

export type Reason = 'away' | 'usage' | 'manual'
export type Step = { label: string; result: string; isDone: boolean }
// waiting: 作業終了待ち / generating: 生成中 / ready: 確認待ち / failed: 生成失敗
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
