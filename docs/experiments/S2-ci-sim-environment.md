# S2 CI シミュレーション環境差の診断

- 状態: 実施中
- 日付: 2026-10-26
- 担当: Devin
- 関連: PR #8

## 目的と仮説

CI で失敗する GW1N 内部フラッシュの CRC 読み戻しと USB 切断のテストについて、fixture 生成時の Python 版差または CPU 競合がローカルでも失敗を起こすか確認する。どちらも再現しない場合だけ、Fake USB の命令とレジスタ更新を記録して、CI とローカルを比較する。

## 採否の基準（結果を見る前に書く）

Python 3.14 で生成した fixture を使う4テストのうち1件以上が失敗し、Python 3.12 の fixture では4件すべてが成功した場合、fixture 環境差で再現したと判定する。再現しなければ、CPU 競合下で4テストを3回ずつ実行する。計12回のうち1件でも失敗すれば、CPU 競合で再現したと判定する。これも再現しない場合だけ、CI とローカルの Fake USB trace を比較する。

## 条件

| 項目 | 値 |
|---|---|
| 基準の commit | `0e3d8a6334baf1397b72bdbd582675187b5b89f1` |
| ホスト | Ubuntu 22.04.5 LTS、Linux 6.8.0-1061-aws、x86_64 |
| QEMU | 使用しない |
| Buildroot / GCC / カーネル | 使用しない |
| 使用したツールとバージョン | Node.js 24.21.0、Python 3.12.13 / 3.14.8、uv 0.13.4 |
| WASM `.wasm` / `.mjs` SHA-256 | `84cb4077c3d02ab5392d47798e6a10d540ad8db9e547424926501bdaaccd285c` / `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| 出力先と状態 | `build/fixtures`。Python 3.12 の `.fs` を `build/fixtures-py312` に保存 |
| 変える条件 | fixture 生成 Python 版、必要な場合は CPU 競合と Fake USB trace |
| 変えない条件 | fixture requirements、WASM、Node.js、テスト対象と assertion |
| 繰り返し | Python 版比較は各4件を1回。CPU 競合は4件を3回ずつ。 |

## 手順

```sh
uv python install 3.14
mkdir -p build/python314-bin
ln -s "$(uv python find 3.14)" build/python314-bin/python3
mv build/fixtures/venv build/fixtures-py312/venv
PATH="$PWD/build/python314-bin:$PATH" tests/fixtures/build-fs.sh
sha256sum build/fixtures/*.fs build/fixtures-py312/*.fs
WASM_BUILD_ROOT=build/ci-compare \
  node --test --test-name-pattern='^(flash programming: Tang Nano (1K|4K|9K)|USB disconnect during transfer is reported without a hang)$' \
  tests/sim/program.test.mjs

FAKE_USB_TRACE=1 WASM_BUILD_ROOT=build/ci-compare \
  node --test --test-name-pattern='^flash programming: Tang Nano (1K|4K|9K)$' \
  tests/sim/program.test.mjs
```

## 計測器の検証

fixture の比較には SHA-256 を使い、生成物ごとの完全一致を確認する。シミュレーションの成否は Node の test runner の pass/fail とテスト出力で確認する。CPU 競合の試行では `taskset` の CPU 指定と、稼働中の CPU hog 2個を確認する。

## 結果

Python 3.14.8 の fixture 生成は最初の Tang Nano 1K の Yosys ABC9 処理で Wasmtime trap により停止した。ログは `wasmtime._trap.Trap`、`Caused by: thrown Wasm exception`。4種類の Python 3.14 fixture は生成されず、ハッシュ比較とそれらを使った4テストは実行できなかった。生成前の Python 3.12 fixture は `build/fixtures-py312/` に保存した。停止後に `build/fixtures/*.fs` と保存済みの同名ファイルを `cmp` し、4件すべて一致することを確認した。

Python 3.12 fixture の SHA-256 は次のとおり。CI で生成された値と比較する。

| Fixture | SHA-256 |
|---|---|
| `tangnano1k.fs` | `999b7e160d98654c150d21c72e53d19e86e21b308e0188457763fb113e889998` |
| `tangnano4k.fs` | `63b030bf66d9dfc88fc14cdc3287df4efa179f7773808fdc6940860fa9ee8017` |
| `tangnano9k.fs` | `191b09be744a28461a55b44da0e91b4c70e00e47cf61b824c8f0040a99f47b83` |
| `tangnano20k.fs` | `7e66b61bab06d9f7f7ce31e88a97a26b467b3aa2d5bc3afc53cf0ffdefb11b7d` |

CPU 競合試験は `taskset -c 0` と `yes >/dev/null` 2個を使って3回実行した。全試行で対象4テストが各1回成功し、計12/12件通過した。

| 試行 | Tang Nano 1K | Tang Nano 4K | Tang Nano 9K | USB 切断 | 全体 |
|---|---:|---:|---:|---:|---:|
| 1 | 8,122.069 ms | 10,166.235 ms | 12,626.179 ms | 368.575 ms | 31,410.498 ms |
| 2 | 8,033.997 ms | 10,264.541 ms | 12,518.921 ms | 407.421 ms | 31,331.785 ms |
| 3 | 8,160.454 ms | 10,595.110 ms | 12,571.312 ms | 381.596 ms | 31,817.946 ms |

3試行の中央値（最小–最大）は、1K 8,122.069 ms（8,033.997–8,160.454）、4K 10,264.541 ms（10,166.235–10,595.110）、9K 12,571.312 ms（12,518.921–12,626.180）、USB 切断 381.596 ms（368.575–407.421）、全体 31,410.498 ms（31,331.785–31,817.946）。

Fake USB trace を有効にした3ボードの flash programming は3/3件成功した。15回の子プロセス実行から、`0x15`、`0x71`、`0x3a`、`0x3c` の IR load と `0x71` の DR update、TAP reset が記録された。Python 3.12 fixture を使ったこのローカル経路では `0x0a` の IR/DR と `0x13` の IR/read は観測されなかった。1K の直接実行結果も終了コード0で、命令数に `0x0a` と `0x13` は含まれない。CI の trace と fixture hash を取得するまでは、CI での実行経路や原因は確定しない。

最初の trace 実装は 9K の子プロセスで `ENOBUFS` になった。DR read を `0x13` のみに絞り、`0x71` の DR update を先頭3件と8,192件ごとに記録する方式に変更した後は、3テストが通過し、ログは 1,748,834 bytes になった。生の測定値は [S2-ci-sim-environment.csv](S2-ci-sim-environment.csv) に記録した。

## 捨てた試行と経緯

Python 3.14 の fixture 生成は Yosys ABC9 の Wasmtime trap で停止したため、部分生成物を fixture 比較に使わなかった。初回の Fake USB trace は出力量が `spawnSync` の 8 MiB 上限を超えて `ENOBUFS` になったため、その実行結果をテスト成否の判定には使わず、trace をサンプリングして再実行した。

## 結論

未確定。仮想 USB の結果であり、実機の動作を示すものではない。

## 未確認の点

CI runner 上の fixture hash と Fake USB trace は、診断用 CI 実行後に比較する。Python 3.14 で生成した fixture の内容も未確認である。

## ログ

生ログはコミットしない。実行コマンドと測定値を CSV に記録する。
