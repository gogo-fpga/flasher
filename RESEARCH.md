# GOGO-FPGA flasher 調査記録

## 目的と前提

Sipeed Tang Nano 1K・4K・9K・20K に、GOWIN 製 FPGA のビットストリーム（`.fs`）を Web ブラウザーから書き込むアプリを作ります。対象の 4 ボードは、搭載している FPGA の品番に R が付いているものから選びました。

### 決定済みの方針

- Web 版だけを作ります。CLI は作りません。
- 書き込み処理は自分で移植せず、upstream の openFPGALoader を Emscripten で WASM にして使います。USB には libusb の WebUSB バックエンドを、FTDI の制御には libftdi を使います。
- 配信先は決めていません。CI の成果物と Release の zip（静的ファイル一式）で配ります。GitHub Pages には出しません。
- 実機は手元にないので、仮想の FT2232 と GOWIN TAP で動作を確かめます。実機では試していません。

## 対象ボード

| ボード | FPGA | openFPGALoader のボード名 | IDCODE | 書き込み先 |
|---|---|---|---|---|
| Tang Nano 1K | GW1NZ-1 | `tangnano1k` | `0x0100681B` | SRAM、内蔵フラッシュ |
| Tang Nano 4K | GW1NSR-4C | `tangnano4k` | `0x0100981B` | SRAM、内蔵フラッシュ |
| Tang Nano 9K | GW1NR-9C | `tangnano9k` | `0x0100481B`（`0x0100581B` の個体もある） | SRAM、内蔵フラッシュ |
| Tang Nano 20K | GW2AR-18C | `tangnano20k` | `0x0000081B` | SRAM、外付け SPI フラッシュ |

4 ボードとも、オンボードのデバッガーは FT2232 互換（VID `0x0403`、PID `0x6010`、インターフェース A、MPSSE による JTAG）として見えます。根拠は openFPGALoader v1.2.0 の `src/board.hpp`（`JTAG_BOARD("tangnano9k", "", "ft2232", ...)` など）と `src/part.hpp` です。

ビットストリームの IDCODE と実機の IDCODE の照合は、openFPGALoader の `src/gowin.cpp` が行います（`mismatch between target's idcode and bitstream idcode`）。画面でも事前に警告しますが、最終的な判定は openFPGALoader に任せます。

## 方式の比較

| 方式 | 内容 | 採否 |
|---|---|---|
| Rust で GOWIN の手順を移植（nusb で WebUSB） | 1 つのコアから CLI と Web を作る | 不採用。手順を自分で移植すると、実機で試せない分の不確かさが大きい |
| openFPGALoader を Emscripten でそのまま WASM 化 | upstream のコードを変えずに使う | 採用 |

openFPGALoader を WASM 化した既存の例です。

| 例 | 構成 | 備考 |
|---|---|---|
| [trabucayre/openFPGALoader_webUSB](https://github.com/trabucayre/openFPGALoader_webUSB) | openFPGALoader の作者による。emsdk 3.1.51、ASYNCIFY + pthread、ソースは無変更 | Apache-2.0。https://ofl.trabucayre.com で公開 |
| [YoWASP/openFPGALoader-web](https://github.com/YoWASP/openFPGALoader-web) | pthread を使用 | アーカイブ済み |
| [sylefeb/openFPGALoader-online](https://github.com/sylefeb/openFPGALoader-online) | pthread なし | libusb のフォークが必要（2025 年 3 月時点） |

## 依存関係

すべて `vendor/` に shallow submodule として置き、版の順（semver）で最新を確かめて固定しました（2026-10-25）。

| 依存 | 版 | commit | 取得元 |
|---|---|---|---|
| openFPGALoader | v1.2.0 | `befbab4f` | https://github.com/trabucayre/openFPGALoader |
| libusb | v1.0.30 | `87a55632` | https://github.com/libusb/libusb |
| libftdi | master | `92d657bc` | `git://developer.intra2net.com/libftdi` |
| zlib | v1.3.2 | `216c70c0` | https://github.com/madler/zlib |
| emsdk | 6.0.13 | `35659964` | https://github.com/emscripten-core/emsdk |
| yomiyasu | main | （submodule の固定値） | https://github.com/uist1idrju3i/yomiyasu |

- 当初、タグを文字列の順で並べたため emsdk の最新を 6.0.9 と誤りました。`git ls-remote --tags --sort=-v:refname` で版の順に並べ直し、6.0.13 に直しました。
- libftdi の http の取得元（`http://developer.intra2net.com/git/libftdi`）は dumb http のため shallow clone ができません（`dumb http transport does not support shallow capabilities`）。smart protocol の `git://` を使います。git:// は暗号化されませんが、superproject が固定する commit の SHA で中身を確かめられます。

## Emscripten のビルドオプション

### 出典

- Emscripten 公式文書：Asyncify（JSPI を含む）、Optimizing Code、Pthreads、C++ exceptions、`src/settings.js`（6.0.13）、`ChangeLog.md`
- openFPGALoader の作者による `openFPGALoader_webUSB` の `build.sh`
- libusb v1.0.30 の `configure.ac`、`tests/Makefile.am`、`libusb/os/emscripten_webusb.cpp`
- OpenBlink（openblink-webide）の `Makefile`（mruby/c を `-O3 -flto` と ASYNCIFY でビルド）
- Chrome の JSPI 対応（Chrome 137 から既定で有効）

### 作者の構成（基準）

```sh
-s STRICT=1 -s ENVIRONMENT=worker -s ASYNCIFY=1 -s INVOKE_RUN=0 -s EXIT_RUNTIME=1
-s MALLOC=emmalloc -s INITIAL_MEMORY=33554432
-s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall
-s EXPORTED_FUNCTIONS=_main,_fflush -s MODULARIZE=1 -s EXPORT_NAME=instantiate
-s EXPORT_ES6=1 -s USE_ES6_IMPORT_META=1 -s WASM_BIGINT=1 -s TEXTDECODER=1
-s DISABLE_EXCEPTION_CATCHING=0
# コンパイル: -pthread -fexceptions、リンク: -lembind
```

### 6.0.x の変更で関係するもの（`ChangeLog.md` より）

- 6.0.8：`JSPI` が実験的な扱いでなくなった（#27559）。`WASM_BIGINT` は非推奨になり、既定で有効（#27558）。そのため `-s WASM_BIGINT=1` は外しました。
- 6.0.7：最も古い対応 Safari が 15.0 に上がり、bulk-memory などを前提にできるようになった（#27542）。
- 6.0.6：C++ のリンクには `em++` が必要になった（`DEFAULT_TO_CXX` が既定で無効、#11121）。
- 6.0.12：`emscripten_epoll_listener_add` が追加された（実験的）。libusb は使っていないので関係しません。
- `MODULARIZE` のファクトリー関数は常に Promise を返す。出力の拡張子が `.mjs` なら `EXPORT_ES6` は自動で有効になる（`settings.js`）。

### 検討したオプション

| 分類 | 候補 | 調べた内容 | 結論 |
|---|---|---|---|
| 非同期 | `ASYNCIFY=1` | 全体を書き換えるので、大きさと速度にかなりの負担がある（公式）。`-O2` 以上が必要 | 段階 1 で測定 |
| 非同期 | `JSPI=1` | WASM を書き換えない。Chrome・Edge 137 以降、Node 24 で使える。libusb の `val::await()` はどちらでも動く（`_emval_await__async: 'auto'`） | 段階 1 で測定 |
| 非同期 | `ASYNCIFY_IGNORE_INDIRECT`、`ASYNCIFY_ONLY`、`ASYNCIFY_REMOVE` | 計装の範囲を絞る。openFPGALoader は仮想関数が多く、誤ると壊れる | `ASYNCIFY_ADVISE` で調べ、安全と示せたときだけ |
| 非同期 | `ASYNCIFY_STACK_SIZE` | 既定 4096。OpenBlink は 65536 | ASYNCIFY を採るときに測定 |
| スレッド | `-pthread` | 作者の構成。COOP/COEP ヘッダーと SharedArrayBuffer が必要 | 段階 0・1 で比較 |
| スレッド | なし | upstream の libusb は共有メモリーと pthread の関数を必要とし、リンクまたは実行で失敗（段階 0） | 不採用 |
| スレッド | `PROXY_TO_PTHREAD` | main を別スレッドで動かす。libusb のテストが使う | Worker で動かすので必要性を測定 |
| 最適化 | `-O2`、`-O3`、`-Os`、`-Oz` | 速度と大きさの兼ね合い | 段階 1 で測定 |
| 最適化 | `-flto` | 依存を含む全体か、本体だけか。OpenBlink は全体 | 段階 1 で測定 |
| 例外 | `-fexceptions`（JS 方式） | 作者の構成。JSPI とは組み合わせられない（段階 0） | ASYNCIFY でだけ使う |
| 例外 | `-fwasm-exceptions` | wasm ネイティブの例外。6.0.13 の既定は旧方式（`WASM_LEGACY_EXCEPTIONS=1`）。`=0` で標準方式 | JSPI では必須。旧方式と標準方式を段階 1 で比較 |
| メモリー | `INITIAL_MEMORY` 固定、`ALLOW_MEMORY_GROWTH`、`MAXIMUM_MEMORY` | `.fs` は最大で数 MB | 段階 1 で測定 |
| メモリー | `MALLOC=emmalloc`、`dlmalloc`、`mimalloc` | 作者は emmalloc。mimalloc はスレッド向け | 段階 1 で測定 |
| JS | `--closure 1` | JS の縮小。`pre-js` との相性を確かめる | 段階 1 で測定 |
| JS | `ENVIRONMENT=worker,node` | Worker で動かし、Node でテストする。OpenBlink の PR #68 でも、Worker で動かすために `worker` を足した | 採用 |
| 起動 | `EVAL_CTORS` | 静的コンストラクターの事前評価。`=2` は main の引数を無視する前提なので使わない | `=1` を測定 |
| そのほか | `TEXTDECODER=2`、`DYNAMIC_EXECUTION=0`、`INCOMING_MODULE_JS_API`、`FILESYSTEM`（MEMFS が必要）、SIMD | — | 段階 1 で確認 |

### 段階 0 で分かったこと

- libusb v1.0.30 の `configure` は、`-pthread` が使えれば必ず `THREAD_CFLAGS=-pthread` を付けます。pthread なしで作るときは、`make` のときに `THREAD_CFLAGS=` で上書きします。
- 上書きすると、6.0.13 では `events_posix.c` のコンパイルが `'__builtin_wasm_memory_atomic_notify' needs target feature atomics` で止まります。`-pthread` を付けずに `-matomics` を付けて回避しました。
- JSPI と JS 方式の C++ 例外（`-fexceptions` と `DISABLE_EXCEPTION_CATCHING=0`）を組み合わせると、起動時に `SuspendError: trying to suspend without WebAssembly.promising` で止まりました。JS 方式の例外は、JS の中継関数 `invoke_*` を使います。6.0.13 の `tools/link.py` は、`ASYNCIFY_IGNORE_INDIRECT` が無効のとき `invoke_*` を非同期の import に加えるため、中継関数がすべて `WebAssembly.Suspending` で包まれます。そのため、`__wasm_call_ctors` から呼ばれる静的コンストラクターで失敗します。JSPI 版では `-fwasm-exceptions` を使います。
- JSPI 版（pthread なし、JS 方式の例外）のリンクは 1 分 29 秒、最大 RSS は 266 MB でした。WASM は 2,999,631 バイトです。
- `-fwasm-exceptions` に切り替えると `SuspendError` はなくなり、リンクは 48 秒、最大 RSS は 210 MB になりました。その先の USB 検出で `Atomics.waitAsync` が `not a shared typed array` で失敗しました。libusb v1.0.30 の `libusb/os/events_posix.c`（43〜53 行）は、メインスレッドで動くとき WASM のメモリーを `Atomics.waitAsync` で待つため、共有メモリーが必要です。ブラウザーで共有メモリーを使うには COOP/COEP ヘッダーが要るので、libusb にパッチを当てない限り、pthread を使わなくてもヘッダーは必要です。比較の軸は「共有メモリーのみ（`-sSHARED_MEMORY`）」と「pthread」に改めました。
- 共有メモリーだけを有効にして pthread を使わない構成（`-sSHARED_MEMORY=1`）は、libusb の `core.o` が pthread の関数（`pthread_mutex_lock` など）を参照するため、リンクできませんでした。Emscripten のスタブを足すと、`emscripten_futex_wake` が二重に定義されました。libc に手を入れる必要があるので、この構成は候補から外し、pthread を使う構成だけを比べます。
- JSPI・pthread・`-fwasm-exceptions` の構成はビルドでき、仮想 USB の検出テスト（4 ボード × `-b` の有無 × 5 回、デバイスなし 1 回）にすべて通りました。全体のビルドは 1 分 30 秒、最大 RSS は 243 MB です。WASM は 2,281,255 バイト（gzip で 635,229 バイト）、`.mjs` は 99,393 バイトです。検出 1 回の時間は、読み込みを含めて 84〜125 ms でした。
- ASYNCIFY の最後の最適化（wasm-opt）は、メモリー 7 GB・2 コアの VM で終わりませんでした（SIGKILL、または 1 時間 40 分以上かかって中断）。pthread 版では最大 RSS が 7.4 GB に達してから SIGKILL で止まりました。GitHub の runner（16 GB）で測り直します。詳細は [段階 0 の記録](docs/experiments/S0-wasm-build.md) にあります。

## 選び方

1. 安定性で絞る：仮想デバイスのテスト（4 ボード × SRAM／フラッシュ、故障の注入）にすべて通り、5 回以上繰り返しても結果が変わらない組み合わせだけを残す。
2. 残った組み合わせから、書き込みにかかる時間（実時間と CPU 時間）が最も短いものを選ぶ。大きさと起動時間は参考にする。

## ライセンス

| 部品 | ライセンス | 配布で必要なこと |
|---|---|---|
| openFPGALoader | Apache-2.0 | LICENSE と NOTICE の同梱 |
| libusb | LGPL-2.1-or-later | 静的リンクなので、ソースと再リンクの手段を提供する |
| libftdi | LGPL-2.1（ライブラリ部分） | 同上 |
| zlib | zlib | 表示の保持 |
| Emscripten のランタイム | MIT / University of Illinois/NCSA | 表示の同梱 |

## 未確認事項

- 実機（4 ボード）での書き込み。
- JSPI 版の、Chrome・Edge の実機の WebUSB での動作。
