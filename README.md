# handoff

離席中に主会話のプロンプトキャッシュを維持し、長い会話を引き継ぎ書にまとめて新しい会話で再開できるようにする Claude Code の mod です。

## できること

- **キャッシュ維持**：応答が終わってから50分ごとに、`$.model.fork` で主会話と同じリクエストを送り、キャッシュの TTL を延ばします。既定では3回まで維持します。
- **引き継ぎ書の生成**：次のどちらかで、会話を引き継ぎ書にまとめて `~/.claude/handoffs/<日時>-<プロジェクト名>.md` に保存します。
  - 3回維持してからさらに50分たった（離席）
  - コンテキスト使用率が80%を超えた
- **新しい会話での再開**：引き継ぎ書ができると、プロンプトの上のバンドに確認が出ます。「Start new chat with it」を押すと、`/clear` してから引き継ぎ書を最初のメッセージとして送ります。元の会話は `/resume` で開き直せます。
- **バンド**（表示は英語）：コンテキスト使用率、キャッシュ維持の状態（例：`Cache kept warm · next refresh 14:20 (2 left)`）、いつでも引き継ぎ書を作れる「Handoff」ボタンを表示します。

## 前提

- 主会話のプロンプトキャッシュの TTL が 1h であること。Pro / Max のプラン内なら既定で 1h です。API キー利用時などで 5m のときは、1回目の維持でキャッシュに当たらないことを検知し、維持を止めます。
- 200k トークンを超える会話では、`idleCompaction: false` の設定を推奨します。Claude Code v2.1.309 では、設定しないと応答の終了から約54分後に会話が要約され、維持が無駄になります。この挙動は Claude Code の版によって変わる可能性があります。

## インストール

開発中は、このリポジトリを plugin フォルダとして指定して起動します。

```bash
claude --plugin-dir /path/to/cc-mod-handoff
```

## 設定

Claude Code の設定メニュー、または settings の `pluginConfigs` で変更できます。`pluginConfigs` のキーは plugin 名の `handoff` です。`--plugin-dir` で読み込んだ場合は `handoff@inline` になることがあります。

| 項目 | キー | 既定値 |
|---|---|---|
| Cache keep-alive | `keepAlive` | オン |
| Keep-alive count | `keepAliveCount` | 3回 |
| Keep-alive interval (min) | `keepAliveIntervalMin` | 50分（1〜55 の範囲で指定） |
| Stop at plan usage (%) | `usageStopPercent` | 90% |
| Context warning (%) | `warnPercent` | 60% |
| Auto-handoff at (%) | `autoGenPercent` | 80% |

警告しきい値 < 自動生成しきい値 < Claude Code の自動 compact しきい値 になっていないと、バンドに警告を出します。

## 費用

コンテキスト全体を通常の入力として送ったときの費用を1とすると、維持1回の費用はキャッシュの読み込みとして約0.1です（Opus 5.5 と Sonnet 5.5 は約0.05）。キャッシュが切れてから戻ると、全文を書き込み直すので約2かかります。サブスクリプションでは、費用の代わりにプランの使用量を消費します。プランの使用量のどれかの枠が `usageStopPercent` 以上になると、維持を止めます。

## 開発

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
