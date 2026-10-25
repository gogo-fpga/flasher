# S0: WASM ビルド実験

## 目的と条件

openFPGALoader v1.2.0 を Emscripten 6.0.13 でビルドし、Node.js 24 の fake WebUSB から実際の WASM を起動して `--detect` を確認する。書き込み処理と実機動作は対象外。Rust、CLI、GitHub Pages はこの Stage 0 の対象外。

依存 pin:

| 依存 | pin |
|---|---|
| openFPGALoader | v1.2.0 |
| libusb | v1.0.30 |
| libftdi | `92d657bcb543a9622947d984d4a8e725fb680e8c` |
| zlib | v1.3.2 |
| emsdk | 6.0.13 (`35659964bc2762fffec0d257997fb61475f765b7`) |
| yomiyasu | default branch HEAD |

libftdi は `git://developer.intra2net.com/libftdi` から取得した。このプロトコルは認証も暗号化もされないため、完全性は superproject に記録した commit SHA で確認する。`vendor/` 内のソースは変更していない。

実際に使った toolchain:

```text
emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.13 (e13ee988ce3d87a738dd8f3661d02223308c412a)
em++ (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.13 (e13ee988ce3d87a738dd8f3661d02223308c412a)
clang version 24.0.0git (https://github.com/llvm/llvm-project 83ee07799c341b60965f07892f7bb3d175da05be)
Node.js v24.21.0 (host); v24.19.0 (emsdk)
Homebrew autoconf 2.73; automake 1.19; libtool 2.6.2
```

`SOURCE_DATE_EPOCH=1792950293` は build script が superproject の最新 commit 時刻から設定した。

## ビルド設定

ビルドは直列に実行。スクリプトの async mode は `--async=jspi|asyncify`、既定値は JSPI。成果物の配置は `build/<async>-pthread/`。libusb、libftdi、zlib、openFPGALoader のコンパイルと link に `-pthread` を使用する。ブラウザー実行時は shared memory を使うため COOP/COEP が必要。

openFPGALoader の縮小設定を使った:

```text
-DENABLE_VENDORS_ALL=OFF
-DENABLE_GOWIN_SUPPORT=ON
-DENABLE_CABLE_ALL=OFF
-DENABLE_FTDI_BASED_CABLE=ON
```

すべて `-Os`。JSPI は zlib、libusb、libftdi、openFPGALoader の全 compile と link に `-fwasm-exceptions` を使い、`-s JSPI=1` を設定する。JS-based C++ EH (`-fexceptions` と `-s DISABLE_EXCEPTION_CATCHING=0`) は使わない。Asyncify は author baseline の JS EH (`-fexceptions`, `-s ASYNCIFY=1`, `-s DISABLE_EXCEPTION_CATCHING=0`)。Emscripten 6.0.13 では BigInt が既定のため、非推奨警告が出た `-s WASM_BIGINT=1` は除去した。

共通 linker flags:

```text
-pthread -lembind -s STRICT=1 -s INVOKE_RUN=0 -s EXIT_RUNTIME=1 -s MALLOC=emmalloc -s INITIAL_MEMORY=33554432 -s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall,callMain -s EXPORTED_FUNCTIONS=_main,_fflush -s MODULARIZE=1 -s EXPORT_NAME=instantiate -s EXPORT_ES6=1 -s ENVIRONMENT=worker,node -s TEXTDECODER=1
```

JSPI では共通 flags に `-fwasm-exceptions -s JSPI=1` を加え、`ASYNCIFY` 設定を含めない。Asyncify では `-s ASYNCIFY=1 -s DISABLE_EXCEPTION_CATCHING=0` を加える。

libusb の生成 `.pc` には `Libs.private: --bind -s ASYNCIFY` がある。通常の `pkg-config --libs` は `Libs.private` を出力しないが、`pkg-config --static --libs` は出力する。実際の JSPI link line に `ASYNCIFY` はなく、build script もそれを検査する。

## 結果

| Variant | ビルド | fake WebUSB detect | 成果物 |
|---|---|---|---|
| `jspi-pthread` | pass。全体 1:29.78、最大 RSS 242,816 KiB。C++ link 37.24 秒、最大 RSS 211,368 KiB | pass。9 tests、4 boards × plain / `-b` 各5回、no-device 1回。JSPI の `callMain()` が Promise を返すことも確認 | `build/jspi-pthread/` |
| `asyncify-pthread` | fail。縮小構成の最終 link 中に `wasm-opt` が SIGKILL。link 21:29.15、最大 RSS 7,446,564 KiB。build 全体 22:38.62 | artifact がないため未実施 | `build/asyncify-pthread/` に失敗ログと中間物を保持 |

Asyncify の link 時には16 GiBの swap を有効にしていた。build 終了後の `swapon --show` は 736.2 MiB 使用を示した。cgroup `memory.events` の `oom_kill` は以前の観測値1から終了後に3となったが、この link との対応は独立には確認できていない。reduced config が resource failure で停止したため、指示どおり full config fallback は実行していない。

JSPI の成果物:

| Artifact | raw bytes | gzip bytes | SHA-256 |
|---|---:|---:|---|
| `openFPGALoader.mjs` | 99,393 | 27,345 | `9005540841199936d9f983124e7a890e3661bd21f250b11e580346e8e7c0df27` |
| `openFPGALoader.wasm` | 2,281,255 | 635,229 | `26112f8c1ccf49910624d4a212e9f3f7b64138a2c1fe26af6d7005e5a6e09344` |

再現性確認として `build/repro/jspi-pthread/` に2回目の clean build を行った。`.mjs` は同一 SHA-256。WASM は一致せず、2回目は 2,281,303 bytes、gzip 635,267 bytes、SHA-256 `86fc91b7db4da5551e7d175e30634a4c4cf3ae01472475de1f506f481d7dbe74`。`strings` の差分には `build/jspi-pthread/libusb-source/...` と `build/repro/jspi-pthread/libusb-source/...` の絶対ソースパスのみが現れた。したがって異なる build root を含む clean build 間の WASM は byte-for-byte reproducible ではない。

`grep -c invoke_ build/jspi-pthread/openFPGALoader.mjs` は1。該当文字列は Asyncify helper 内の `importPattern` 正規表現 `/^(invoke_.*|__asyncjs__.*)$/` であり、実際の `invoke_*` 関数ではない。

detect の生時間 (ms) は隣接 CSV と `build/jspi-pthread-tests-final.log` に記録した。各 board の plain と `-b` 指定で5回ずつ測定し、module load / instantiate / `callMain` を含む。Tang Nano 9K の fake は `0x1100481b` を送る。openFPGALoader v1.2.0 の `jtag.cpp` は未知の version nibble を落として既知の `0x0100481b` として検出するため、テストは表示 IDCODE に `0x0100481b` を期待する。

## 最終 linker command lines

以下は `link.txt` の全内容。各 command の実行時間と最大 RSS は隣接する `link-time.txt` にある。

### JSPI / pthread

```text
/usr/bin/time -v -o /home/ubuntu/repos/flasher/build/jspi-pthread/openFPGALoader-build/link-time.txt /home/ubuntu/repos/flasher/build/emsdk-6.0.13/upstream/emscripten/em++ -O3 -Os -fwasm-exceptions -pthread -Os -DNDEBUG -pthread -lembind -s STRICT=1 -s INVOKE_RUN=0 -s EXIT_RUNTIME=1 -s MALLOC=emmalloc -s INITIAL_MEMORY=33554432 -s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall,callMain -s EXPORTED_FUNCTIONS=_main,_fflush -s MODULARIZE=1 -s EXPORT_NAME=instantiate -s EXPORT_ES6=1 -s ENVIRONMENT=worker,node -s TEXTDECODER=1 -fwasm-exceptions -s JSPI=1 CMakeFiles/openFPGALoader.dir/src/common.cpp.o CMakeFiles/openFPGALoader.dir/src/configBitstreamParser.cpp.o CMakeFiles/openFPGALoader.dir/src/device.cpp.o CMakeFiles/openFPGALoader.dir/src/display.cpp.o CMakeFiles/openFPGALoader.dir/src/main.cpp.o CMakeFiles/openFPGALoader.dir/src/progressBar.cpp.o CMakeFiles/openFPGALoader.dir/src/rawParser.cpp.o CMakeFiles/openFPGALoader.dir/src/bpiFlash.cpp.o CMakeFiles/openFPGALoader.dir/src/spiFlash.cpp.o CMakeFiles/openFPGALoader.dir/src/flashInterface.cpp.o CMakeFiles/openFPGALoader.dir/src/jtag.cpp.o CMakeFiles/openFPGALoader.dir/src/ch552_jtag.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdiJtagBitbang.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdiJtagMPSSE.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdipp_mpsse.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdispi.cpp.o CMakeFiles/openFPGALoader.dir/src/gowin.cpp.o CMakeFiles/openFPGALoader.dir/src/fsparser.cpp.o CMakeFiles/openFPGALoader.dir/src/libusb_ll.cpp.o -o openFPGALoader.mjs -L/home/ubuntu/repos/flasher/build/jspi-pthread/prefix/lib -lusb-1.0 -lftdi1 -lusb-1.0 -lz -lftdi1 -lz
```

### Asyncify / pthread (failed during wasm-opt)

```text
/usr/bin/time -v -o /home/ubuntu/repos/flasher/build/asyncify-pthread/openFPGALoader-build/link-time.txt /home/ubuntu/repos/flasher/build/emsdk-6.0.13/upstream/emscripten/em++ -O3 -Os -fexceptions -pthread -Os -DNDEBUG -pthread -lembind -s STRICT=1 -s INVOKE_RUN=0 -s EXIT_RUNTIME=1 -s MALLOC=emmalloc -s INITIAL_MEMORY=33554432 -s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall,callMain -s EXPORTED_FUNCTIONS=_main,_fflush -s MODULARIZE=1 -s EXPORT_NAME=instantiate -s EXPORT_ES6=1 -s ENVIRONMENT=worker,node -s TEXTDECODER=1 -s ASYNCIFY=1 -s DISABLE_EXCEPTION_CATCHING=0 CMakeFiles/openFPGALoader.dir/src/common.cpp.o CMakeFiles/openFPGALoader.dir/src/configBitstreamParser.cpp.o CMakeFiles/openFPGALoader.dir/src/device.cpp.o CMakeFiles/openFPGALoader.dir/src/display.cpp.o CMakeFiles/openFPGALoader.dir/src/main.cpp.o CMakeFiles/openFPGALoader.dir/src/progressBar.cpp.o CMakeFiles/openFPGALoader.dir/src/rawParser.cpp.o CMakeFiles/openFPGALoader.dir/src/bpiFlash.cpp.o CMakeFiles/openFPGALoader.dir/src/spiFlash.cpp.o CMakeFiles/openFPGALoader.dir/src/flashInterface.cpp.o CMakeFiles/openFPGALoader.dir/src/jtag.cpp.o CMakeFiles/openFPGALoader.dir/src/ch552_jtag.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdiJtagBitbang.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdiJtagMPSSE.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdipp_mpsse.cpp.o CMakeFiles/openFPGALoader.dir/src/ftdispi.cpp.o CMakeFiles/openFPGALoader.dir/src/gowin.cpp.o CMakeFiles/openFPGALoader.dir/src/fsparser.cpp.o CMakeFiles/openFPGALoader.dir/src/libusb_ll.cpp.o -o openFPGALoader.mjs -L/home/ubuntu/repos/flasher/build/asyncify-pthread/prefix/lib -lusb-1.0 -lftdi1 -lusb-1.0 -lz -lftdi1 -lz
```

## 失敗・置換した試行

ログ、失敗した中間物、負の対照 artifact は `build/` 内に保持する。

| 試行 | 結果 |
|---|---|
| `build/retry1`〜`build/retry4` | zlib feature probe が `lseek` / `read` / `close` / `write` の未宣言で失敗。依存 configure probe に app linker flags が混入しないよう修正。 |
| 同上 | libusb `config.sub` が `wasm32-emscripten` を認識せず失敗。`ac_cv_host=wasm32-unknown-emscripten` を指定。 |
| 同上 | libusb が `clock_gettime() is required on this platform` で停止。sysroot に宣言があることを確認し `ac_cv_func_clock_gettime=yes` を渡した。 |
| 同上 | `legacy setting used in strict mode: USE_ES6_IMPORT_META`。該当 legacy setting を削除。 |
| `build/run1/threads-off` | emsdk 6.0.9 を使用した superseded attempt。emsdk pin を 6.0.13 に訂正して再実行。 |
| `build/run2/threads-off` | libusb の生成 Makefile が `THREAD_CFLAGS=-pthread` を実際の build に追加すると判明。未修正版のまま続けず停止。 |
| `build/run3/threads-off` | `THREAD_CFLAGS=` で `-pthread` を抑えたところ、`events_posix.c:40` 経由で `emscripten/atomic.h` が `__builtin_wasm_memory_atomic_notify` と `__builtin_wasm_memory_atomic_wait32` について `needs target feature atomics` と失敗。run4 では `-matomics` を追加した。 |
| `build/run4/threads-off` | reduced config の `wasm-opt --minify-imports-and-exports-and-modules --optimize-level=2 --shrink-level=1 --optimize-stack-ir ...` が `failed (received SIGKILL (-9))`。全機能 fallback は `wasm-opt --strip-target-features --post-emscripten -Os ...` が経過時間 1:42:19 で動作中に停止。 |
| `build/run5/threads-on` | `./bootstrap.sh: 10: exec: autoreconf: not found`。 |
| `build/run6/threads-on` | `aclocal: error: couldn't open directory '/usr/share/aclocal-1.16': No such file or directory`。 |
| `build/run7/threads-on` | `autom4te: error: /usr/share/autoconf/autoconf/trailer.m4: no such file or directory`。 |
| `build/run8/threads-on` | reduced config の `wasm-opt --minify-imports-and-exports-and-modules --optimize-level=2 --shrink-level=1 --optimize-stack-ir ...` が SIGKILL。全機能 fallback は `wasm-opt --strip-target-features --post-emscripten -Os ...` が経過時間 00:16:20 で動作中に停止。 |
| `build/run9/jspi-threads-off-bootstrap-failure/` | `/home/ubuntu/.local/bin/aclocal` が `Can't locate Automake/Config.pm in @INC` で起動できず。build script に Autotools preflight を追加し、後続 build は Homebrew Autotools 2.73 / 1.19 / 2.6.2 を PATH の先頭に置いて実行。 |
| `build/negative-jspi-js-ehexceptions/jspi-threads-off/` | JSPI + JS-based C++ EH は `SuspendError: trying to suspend without WebAssembly.promising`。stack は `invoke_iii` から `initRuntime` へ至る。JSPI の `invoke_*` import wrapping と ctor 実行の相互作用が仮説だったが、native Wasm EH に変更後この SuspendError は再現しなかった。 |
| `build/jspi-import-test/jspi-threads-off/` | `JSPI_IMPORTS=__asyncjs__em_libusb_wait_async` を追加しても上記 SuspendError は解消しなかった。native EH build にはこの設定を残していない。 |
| `build/jspi-threads-off/` | native Wasm EH の non-shared build は USB detect 中に `TypeError: [object Int32Array] is not a shared typed array.`。stack は `Atomics.waitAsync` → `__asyncjs__em_libusb_wait_async` → WASM。libusb `events_posix.c` の main thread wait が shared memory を使うことを確認。 |
| `build/negative-jspi-shm-pthread-link-failure/` | shm / no-pthread の最初の link は libusb の `pthread_mutex_lock`, `pthread_mutex_unlock`, `pthread_mutex_init`, `pthread_mutex_destroy`, `pthread_getspecific` が undefined で失敗。 |
| `build/negative-jspi-shm-pthread-self-link-failure/` | Emscripten pthread stub を追加した診断 link は `pthread_self` undefined で失敗。 |
| `build/jspi-shm/` | 追加 stub の link は `duplicate symbol: emscripten_futex_wake`。定義元は `library_pthread_stub.o` と `libc-mt.a(emscripten_futex_wake.o)`。CMake `link.txt` に `-pthread` がない一方、最終 link は `-lc-mt` を選択した。cause of -lc-mt selection not established. libc stub / libusb patch は採用せず、shm-without-pthread variant を廃止。 |
| `build/asyncify-pthread/` | 今回の Asyncify / pthread reduced build は `wasm-opt` が `failed (received SIGKILL (-9))`。`/usr/bin/time -v` は link 21:29.15、最大 RSS 7,446,564 KiB、終了コード1を記録。build 全体は 22:38.62、最大 RSS 7,446,564 KiB、終了コード1。artifact は生成されず。 |
| テストの初回出力捕捉 | Emscripten `print` callback には C++ 出力が届かず、9 test の出力 assertion が失敗。`process.stdout.write` を test process 内で置き換えると Node test runner protocol が壊れ `Unable to deserialize cloned data`。最終テストでは独立 Node subprocess を使い、実 artifact の stdout / stderr を捕捉。 |
| `node --test tests/sim/` | Node 24 は directory form を解決できず `Cannot find module .../tests/sim`。以後 `node --test tests/sim/*.test.mjs` を使用。 |
| `-s WASM_BIGINT=1` | emsdk 6.0.13 が deprecated warning を出したため削除。BigInt はこの版で既定。 |

## 検証とログ

- JSPI 測定ログ: `build/jspi-pthread-tests-final.log`
- JSPI build と C++ link の時間/RSS: `build/jspi-pthread-build-time.txt`, `build/jspi-pthread/openFPGALoader-build/link-time.txt`
- Asyncify build と C++ link の時間/RSS: `build/asyncify-pthread-build-time.txt`, `build/asyncify-pthread/openFPGALoader-build/link-time.txt`
- clean rebuild: `build/repro/jspi-pthread/`, `build/jspi-pthread-repro-build-time.txt`
- 全試行の build log と中間出力: `build/run1`〜`build/run9`, `build/negative-*`, `build/jspi-*`, `build/asyncify-pthread/`
