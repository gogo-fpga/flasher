# 実験の記録

実験・測定・比較の記録です。手順は「experiment-record」スキル（`.agents/skills/experiment-record/SKILL.md`）に従います。生の値は同じ名前の `.csv` にあります。仮想デバイスでの値は、実機の値ではありません。

| 記録 | 内容 | 結論 |
|---|---|---|
| [S0-wasm-build.md](S0-wasm-build.md) | openFPGALoader を Emscripten で WASM にし、仮想 USB で検出を確かめる | JSPI + pthread + `-fwasm-exceptions` で動く。ASYNCIFY はこの VM では最適化が終わらない |
| [S1a-program-sim.md](S1a-program-sim.md) | 4 ボードの SRAM・フラッシュへの書き込みと故障の注入 | 正常な書き込みは一致する。upstream は失敗しても終了コード 0 を返す場合がある |
| [S1b-option-matrix.md](S1b-option-matrix.md) | Emscripten の最適化オプション 17 候補の比較 | 採用の条件を満たす候補はなく、基準の構成（`-Os`、LTO なし）を使う |
| [S2-ci-sim-environment.md](S2-ci-sim-environment.md) | CI シミュレーション失敗と Python 版・CPU 環境差の比較 | 調査完了。Fake MPSSE parser の `0x8e`/`0x8f` 長さ byte 誤読が原因。未初期化の `skip_checksum` が検査経路差を説明 |
| [S3-ci-speed.md](S3-ci-speed.md) | build workflow の cache、artifact、sim shard による所要時間の比較 | 条件を事前登録。測定は未実施 |
