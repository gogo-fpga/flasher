# GOGO-FPGA flasher

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/gogo-fpga/flasher)

Sipeed Tang Nano 1K・4K・9K・20K に、GOWIN 製 FPGA のビットストリーム（`.fs`）を Web ブラウザーから書き込むアプリです。書き込み処理には、upstream の [openFPGALoader](https://github.com/trabucayre/openFPGALoader) を変更せずに Emscripten で WebAssembly にしたものを使います。USB には WebUSB を使うので、ドライバーやネイティブのアプリを入れる必要はありません。

## 対象ボード

対象の 4 ボードは、搭載している FPGA の品番に R が付いているものから選びました。

| ボード | FPGA | 書き込み先 | 読み出し | 全体の消去 |
|---|---|---|---|---|
| Tang Nano 1K | GW1NZ-1 | SRAM、内蔵フラッシュ | 不可（外付けフラッシュを搭載していない） | 不可 |
| Tang Nano 4K | GW1NSR-4C | SRAM、内蔵フラッシュ、外付けフラッシュ（4 MiB） | 外付けフラッシュ | 不可（upstream が未対応） |
| Tang Nano 9K | GW1NR-9C | SRAM、内蔵フラッシュ、外付けフラッシュ（4 MiB） | 外付けフラッシュ | 不可（upstream が未対応） |
| Tang Nano 20K | GW2AR-18C | SRAM、外付けフラッシュ（8 MiB） | 外付けフラッシュ | 外付けフラッシュ |

使えない操作やオプションも、画面の「高度な設定」に理由と一緒に表示します。根拠は [RESEARCH.md](RESEARCH.md#高度な設定と-gowin-の動作) にあります。

## 開発状況

開発中です。実機の Tang Nano では試していません。動作は、仮想の FT2232・GOWIN TAP・NOR フラッシュを使ったテスト（4 ボードの SRAM・フラッシュへの書き込み、検証、読み出し、消去、故障の注入）と、Playwright による画面の E2E で確かめています。仮想デバイスで測った時間は、実機の値ではありません。

## 動作環境

- Chromium 系ブラウザー（Chrome、Edge）の 137 以降。WebUSB と JSPI（JavaScript Promise Integration）を使います。Firefox と Safari は WebUSB に対応していないため使えません。
- 配信するサーバーは、`Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` のヘッダーを付ける必要があります。WASM が pthread と共有メモリーを使うためです。同梱の `serve.py` は、このヘッダーを付けて `127.0.0.1` で配信します。
- Linux では、FT2232（VID `0403`、PID `6010`）にブラウザーからアクセスできるよう、udev の設定が必要な場合があります。

## 使い方

配布用の zip（CI の成果物、または Release）を展開し、次を実行してから Chrome で `http://127.0.0.1:8000` を開きます。

```sh
python3 serve.py --port 8000
```

1. ボードを選び、`.fs` を選びます。画面が `.fs` の IDCODE を確かめ、ボードと合わなければ警告します。
2. 書き込み先（SRAM かフラッシュ）を選びます。必要なら「高度な設定」で、検証、外付けフラッシュ、開始位置、JTAG の周波数、ログの詳しさ、読み出し、消去などを選びます。
3. 「書き込む」を押し、ブラウザーの画面で機器を選びます。

openFPGALoader は、失敗しても終了コード 0 を返す場合があります。画面は、ログに `FAIL` が出たときも失敗と表示します。内蔵フラッシュの消去が終わらない場合は、画面では検出できません。

## ソースからのビルド

```sh
git clone --recurse-submodules --shallow-submodules https://github.com/gogo-fpga/flasher.git
cd flasher
scripts/build-wasm.sh     # Autotools（autoconf、automake、libtool）が必要
scripts/build-web.sh      # dist/ にまとめる
python3 dist/serve.py --port 8000
```

テストの手順と確認コマンドは [AGENTS.md](AGENTS.md#9-確認コマンド) にあります。

## 文書

| 文書 | 内容 |
|---|---|
| [RESEARCH.md](RESEARCH.md) | 調査の要約、Emscripten のビルドオプションの選定、upstream の動作、出典、未確認事項 |
| [docs/experiments/](docs/experiments/README.md) | 実験・測定の記録と生の値 |
| [AGENTS.md](AGENTS.md) | 作業規約（AI エージェントと人間に共通） |

## ライセンス

部品ごとのライセンスと配布の条件は [RESEARCH.md](RESEARCH.md#ライセンス) にまとめています。WASM には LGPL-2.1 の libusb と libftdi を静的にリンクしています。`vendor/` の submodule は、それぞれのライセンスに従います。
