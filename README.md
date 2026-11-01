# cc-mod-handoff

`handoff` is a Claude Code mod that keeps the main conversation's prompt cache warm while you are away, writes a long conversation down as a handoff note, and picks the work up again in a fresh conversation.

- **Cache keep-alive**: every 50 minutes after a reply ends, it sends the main conversation's request again through `$.model.fork`, which extends the cache's TTL. By default it does this up to 3 times. A session reopened with `/resume` or `claude --resume` within the interval counts from its last reply.
- **Handoff note**: it summarizes the conversation into a note in the conversation's language and saves it to `~/.claude/handoffs/<date-time>-<project>.md` when either of these happens:
  - you are away: 50 more minutes pass after the last keep-alive
  - the context fills past 80%
- **Fresh start**: once the note is ready, a confirmation band appears above the prompt. **Resume in a fresh chat** runs `/clear` and sends the note as the first message; `/resume` still opens the old conversation. **Copy resume prompt** copies a line that points a new chat at the note, **View note** opens it, and **Keep going here** closes the band. If the conversation moves on before you choose (a new turn or a compact), the heading says so and the note is written again when you resume.
- **Band**: the context fill, the keep-alive state (for example `Cache kept warm · next refresh 14:20 (2 left)`) and a **Handoff** button that writes a note at any time.

## Requirements

- macOS. **View note** opens the note with `open`, and the note's folder comes from `HOME`. Other systems are untested.
- A 1-hour TTL on the main conversation's prompt cache, the default on Pro and Max plans. Where it is 5 minutes (with an API key, for example), the first keep-alive finds no cache hit and the keep-alive stops.
- For conversations past 200k tokens, set `idleCompaction: false`. On Claude Code v2.1.309, without it, the conversation is compacted about 54 minutes after a reply ends and the keep-alive goes to waste. This may change between Claude Code versions.

## Install

At the prompt of a Claude Code session; answer `y` to add the marketplace, then pick a scope:

```
/plugin install handoff --marketplace tukaelu/cc-mod-handoff
```

From a shell:

```bash
claude plugin install handoff --marketplace tukaelu/cc-mod-handoff
```

## Settings

Set in `/config` (in a terminal) or in `~/.claude/settings.json` under `pluginConfigs`, the values going under the plugin's `options`. Loaded with `--plugin-dir`, the plugin's name may be `handoff@inline`.

```json
"pluginConfigs": {
  "handoff": {
    "options": { "keepAliveIntervalMin": 1 }
  }
}
```

| Setting | Key | Default |
|---|---|---|
| Cache keep-alive | `keepAlive` | on |
| Keep-alive count | `keepAliveCount` | 3 |
| Keep-alive interval (min) | `keepAliveIntervalMin` | 50 (1 to 55) |
| Stop at plan usage (%) | `usageStopPercent` | 90 |
| Context warning (%) | `warnPercent` | 60 |
| Auto-handoff at (%) | `autoGenPercent` | 80 |

The band warns when the thresholds are out of order: the warning must be below the auto-handoff, and the auto-handoff below Claude Code's auto-compact.

## Cost

Taking the whole context sent as plain input as 1, one keep-alive costs about 0.1 as a cache read (about 0.05 on Opus 5.5 and Sonnet 5.5). Coming back after the cache expired writes it all again, about 2. On a subscription, the keep-alive uses plan usage instead of money, and it stops once any plan usage window reaches `usageStopPercent`.

## Development

Run Claude Code with this folder as a plugin folder:

```bash
claude --plugin-dir /path/to/cc-mod-handoff
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## License

MIT
