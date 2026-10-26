# S3 CI の速度改善

- 状態: 計画
- 日付: 2026-10-26
- 担当: Devin
- 関連: PR #8 の build workflow

## 目的と仮説

emsdk と fixture の cache、build artifact の job 間共有、sim の 3 shard 化が、CI の結果を保ったまま wall-clock time を短縮できるか調べます。baseline は 843〜864 秒で、sim は約 614 秒、WASM build は約 128 秒、fixture 生成は約 41 秒、Chromium install は約 18 秒です。sim shard は `ae0fc01` の CI log にある per-test duration を使い、LPT で割り当てました。

## 採否の基準（結果を見る前に書く）

- warm run の wall-clock time は、5 回の baseline の中央値の 80% 以下であること。wall-clock time は workflow run の `created_at` から最後の job の完了までとします。
- すべての baseline、cold、warm run で `.wasm` の SHA-256 が `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c`、`.mjs` の SHA-256 が `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` と一致すること。
- 各 run のテスト数が sim 43（3 shard 合計）、Web 30、Playwright 15 であること。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `ae0fc019ae9fc69c73b635772f5124a7b01a9af7` |
| ホスト | GitHub-hosted `ubuntu-26.04` |
| Emscripten / emsdk | emsdk 6.0.13。WASM hash を全 run で照合 |
| Node.js / Chromium | Node.js 24。Playwright の Chromium を毎 run install |
| submodule | 基準は PR #8 の `ae0fc01`。新 workflow では同一 branch commit を build し、sim/E2E は artifact を使う |
| 使ったツールの版 | GitHub Actions release version と SHA は `RESEARCH.md` に記録 |
| 出力先と状態 | `build/`。baseline は従来どおり build、cold は cache 無効、warm は cache 有効 |
| 変える条件 | workflow: baseline、cache 無効の cold、cache 有効の warm |
| 変えない条件 | runner、submodule、build option、test source、期待 artifact hash |
| 繰り返し | baseline 5 回、cold 3 回、warm 5 回。concurrency group の pending run を置き換えないよう順番に dispatch |

## 手順

以下の run はこの記録を作成した時点では開始しません。順に dispatch し、各 run が完了してから次を開始します。

| 順 | variant | 回 | ref | cache |
|---:|---|---:|---|---|
| 1〜5 | baseline | 1〜5 | `devin/1792988632-ci-dependabot` (`ae0fc01`) | 旧 workflow |
| 6〜8 | cold | 1〜3 | `devin/1793006611-ci-speedup` | `workflow_dispatch` の `cache=false` |
| 9〜13 | warm | 1〜5 | `devin/1793006611-ci-speedup` | `workflow_dispatch` の `cache=true` |

wall-clock は Actions run API の作成時刻と最後に完了した job の終了時刻から計算します。各 workflow summary の hash と各 job の test count を記録し、`.csv` に生の値を追加します。

## 計測器の検証

sim shard checker は、各 shard の TAP に失敗がないこと、pass したテスト名と table が一致すること、二重 pass と未使用 entry がないことを検査します。baseline と新 workflow のテスト数および build hash が一致しない run は速度比較に使いません。

## 結果

## 捨てた試行と経緯

実験 run は未開始です。

## 結論

未確定。warm run の結果を取得した後に判定します。

## 未確認の点

GitHub-hosted runner の混雑による時間の変動、cache が cold/warm run 間で期待どおり hit するかは未確認です。

## ログ

run ごとの ID、wall-clock、hash、test count は [S3-ci-speed.csv](S3-ci-speed.csv) に記録します。
