# S0: WASM ビルド実験

## 目的と条件

openFPGALoader v1.2.0 を Emscripten 6.0.13 でビルドし、WebUSB の `--detect` を Node.js の fake USB デバイスで確認する。これは Stage 0 のスパイクであり、書き込み処理や実機は対象外。

Emscripten は `vendor/emsdk` のタグから導出し、同じタグを `build/emsdk-6.0.13` にインストールした。タグは `6.0.13`、gitlink は `35659964bc2762fffec0d257997fb61475f765b7`。ツールチェーンの出力:

```text
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.13 (e13ee988ce3d87a738dd8f3661d02223308c412a)
clang version 24.0.0git (https://github.com/llvm/llvm-project 83ee07799c341b60965f07892f7bb3d175da05be)
```

`em++ --version` の出力は emcc と同じ Emscripten/Clang ビルドで、ビルドログに保存した。ホスト Node.js は v24.21.0、SDK 同梱 Node.js は v24.19.0。`SOURCE_DATE_EPOCH=1792938182` はリポジトリの最新 commit 時刻から設定した。

依存の pin は openFPGALoader v1.2.0、libusb v1.0.30、libftdi `92d657bcb543a9622947d984d4a8e725fb680e8c`、zlib v1.3.2、emsdk 6.0.13。libftdi の `git://developer.intra2net.com/libftdi` は認証も暗号化もされないため、完全性は superproject に記録した commit SHA で確認する。

## ビルド設定

openFPGALoader は以下の縮小設定で構成した。CMake 構成と C++ compile は成功したが、最終 link の wasm-opt で SIGKILL になったため、規定に従って upstream の全機能設定でも再試行した。全機能設定も wasm-opt の処理が長時間続いたため停止した。いずれも成功した成果物ではない。

```text
-DENABLE_VENDORS_ALL=OFF
-DENABLE_GOWIN_SUPPORT=ON
-DENABLE_CABLE_ALL=OFF
-DENABLE_FTDI_BASED_CABLE=ON
```

両 variant の共通 linker 設定:

```text
-lembind -s STRICT=1 -s ASYNCIFY=1 -s INVOKE_RUN=0 -s EXIT_RUNTIME=1 -s MALLOC=emmalloc -s INITIAL_MEMORY=33554432 -s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall,callMain -s EXPORTED_FUNCTIONS=_main,_fflush -s MODULARIZE=1 -s EXPORT_NAME=instantiate -s EXPORT_ES6=1 -s ENVIRONMENT=worker,node -s TEXTDECODER=1 -s DISABLE_EXCEPTION_CATCHING=0
```

6.0.13 は BigInt を既定で有効にする。run4 の link では `-s WASM_BIGINT=1` に非推奨警告が出たため、スクリプトから削除した。後続の run8 ではこの警告は出ていない。

`--threads=on` は C/C++ と最終リンクへ `-pthread` を渡す。`--threads=off` では実コンパイルと最終リンクに `-pthread` を渡さず、libusb v1.0.30 の `events_posix.c` を Emscripten 6.0.13 でコンパイルするため `-matomics` を追加した。upstream の `configure` は Emscripten でも `-pthread` の可否を無条件に probe する。この configure probe だけは upstream を変更せずに除けないため、off variant の実コンパイルには `THREAD_CFLAGS=` を上書きしている。probe を含めて文字列 `-pthread` を一切出さない要件とは両立しない。

link command は各 build directory の `CMakeFiles/openFPGALoader.dir/link.txt` と build log に保存される。縮小設定: `build/run4/threads-off/openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt` と `build/run8/threads-on/openFPGALoader-build/CMakeFiles/openFPGALoader.dir/link.txt`。全機能設定: `build/run4/threads-off/openFPGALoader-full-build/CMakeFiles/openFPGALoader.dir/link.txt` と `build/run8/threads-on/openFPGALoader-full-build/CMakeFiles/openFPGALoader.dir/link.txt`。最終 link を通過した成果物がないため、完成版の link line・サイズ・SHA-256・再現性・detect 時間は未取得。

## 結果

| Variant | ビルド | detect | 備考 |
|---|---|---|---|
| threads=off | 縮小設定の wasm-opt が SIGKILL。全設定でも wasm-opt が約1時間42分動作した時点で停止 | 未実施 | `build/run4/threads-off/build.log` |
| threads=on | 縮小設定の wasm-opt が SIGKILL。全設定でも wasm-opt が約16分動作した時点で停止 | 未実施 | `build/run8/threads-on.log` |

Node テスト、共有 memory の有無、pthread runtime の有無、SHA-256 比較、gzip サイズ、5回ずつの detect 時間は、完成版 artifact がないため未実施。成功として扱わない。

## 失敗・置換した試行

| 試行 | 内容 | 結果 |
|---|---|---|
| `build/retry1`〜`build/retry4` | 初期構成 | zlib feature probe が `lseek`/`read`/`close`/`write` の未宣言で失敗。アプリ用 linker flags を依存 probe に混入させないよう修正。 |
| 同上 | libusb configure | `wasm32-emscripten` を config.sub が認識せず失敗。`ac_cv_host=wasm32-unknown-emscripten` を指定。 |
| 同上 | libusb configure | `clock_gettime() is required on this platform`。`LIBS=' --bind -s ASYNCIFY'` の影響を受ける probe を、sysroot に宣言があることを確認して cache 値で回避。 |
| 同上 | Emscripten link | `legacy setting used in strict mode: USE_ES6_IMPORT_META`。この legacy 設定を削除。 |
| `build/run1/threads-off` | emsdk 6.0.9 | wasm optimization 中に停止。pin を 6.0.13 に直したため superseded。ログは保持。 |
| `build/run2/threads-off` | emsdk 6.0.13 | link/optimization 中、libusb の生成 Makefile が `THREAD_CFLAGS=-pthread` を使うと判明したため停止。後続の run3 で空の override を検証。 |
| `build/run3/threads-off` | emsdk 6.0.13、`THREAD_CFLAGS=` | `events_posix.c:40` から include された Emscripten `emscripten/atomic.h` で `error: '__builtin_wasm_memory_atomic_notify' needs target feature atomics` と `error: '__builtin_wasm_memory_atomic_wait32' needs target feature atomics`。libusb の `configure.ac` は `CFLAGS="-Wall -Werror -pthread"` で `-pthread` を probe し、成功時 `THREAD_CFLAGS=-pthread` を生成する。run4 では compile/link に `-matomics` を使い、`make` と `make install` に `THREAD_CFLAGS=` を渡した。 |
| `build/run4/threads-off` | emsdk 6.0.13、縮小設定 | `em++: error: '/home/ubuntu/repos/flasher/build/emsdk-6.0.13/upstream/bin/wasm-opt --minify-imports-and-exports-and-modules --optimize-level=2 --shrink-level=1 --optimize-stack-ir openFPGALoader.wasm -o openFPGALoader.wasm --mvp-features --enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-call-indirect-overlong --enable-multivalue --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-sign-ext' failed (received SIGKILL (-9))`。全機能設定は同じく `wasm-opt --strip-target-features --post-emscripten -Os ...` の途中で、プロセス経過時間約1時間42分の時点に停止した。 |
| `build/run5/threads-on` | emsdk 6.0.13、最初の試行 | 実行環境の `PATH` に Autoconf の配置先がなく、`./bootstrap.sh: 10: exec: autoreconf: not found`。 |
| `build/run6/threads-on` | emsdk 6.0.13、Autotools の一部環境変数を復元 | `aclocal: error: couldn't open directory '/usr/share/aclocal-1.16': No such file or directory`。`ACLOCAL_AUTOMAKE_DIR` が不足していた。 |
| `build/run7/threads-on` | emsdk 6.0.13、run4 の Autotools 環境変数を復元 | `autom4te: error: /usr/share/autoconf/autoconf/trailer.m4: no such file or directory`。 |
| `build/run8/threads-on` | emsdk 6.0.13、Homebrew Autotools 2.73 / 1.19 / 2.6.2 | 縮小設定の wasm-opt が SIGKILL。全機能設定で C++ compile/link は通過したが、`wasm-opt --strip-target-features --post-emscripten -Os ...` の途中、経過時間約16分で停止した。 |

各 build の生ログは `build/` 以下に保持する。縮小設定の失敗と、停止時点の全機能 build elapsed は `S0-wasm-build.csv` に記録する。SIGKILL の原因は確定できていない。`/sys/fs/cgroup/system.slice/devin-remote.service/memory.events` の `oom_kill` は1だったが、当該 build との時間的な対応は未確認。
