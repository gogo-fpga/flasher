#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [--async=jspi|asyncify]\n' "${0##*/}" >&2
  exit 2
}

async_mode=jspi
async_seen=false
for arg in "$@"; do
  case "$arg" in
    --async=jspi|--async=asyncify)
      [[ "$async_seen" == false ]] || usage
      async_mode="${arg#*=}"
      async_seen=true
      ;;
    *) usage ;;
  esac
done

for tool in autoreconf aclocal autoconf automake libtoolize; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required Autotools command not found: %s\n' "$tool" >&2
    exit 1
  fi
  if ! "$tool" --version >/dev/null 2>&1; then
    printf 'Autotools command is unusable: %s (%s --version failed); use a consistent Autotools installation.\n' \
      "$(command -v "$tool")" "$tool" >&2
    exit 1
  fi
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_root="${BUILD_ROOT:-$root/build}"
if [[ "$build_root" != /* ]]; then
  build_root="$root/$build_root"
fi
out="$build_root/$async_mode-pthread"
[[ ! -e "$out" ]] || {
  printf 'Build output already exists: %s\n' "$out" >&2
  exit 1
}
mkdir -p "$out"
exec > >(tee "$out/build.log") 2>&1
set -x

jobs="${JOBS:-$(getconf _NPROCESSORS_ONLN)}"
prefix="$out/prefix"
source_date_epoch="$(git -C "$root" log -1 --format=%ct)"
export SOURCE_DATE_EPOCH="$source_date_epoch"

emsdk_version="$(git -C "$root/vendor/emsdk" describe --tags --exact-match)"
emsdk_root="$root/build/emsdk-$emsdk_version"
if [[ ! -x "$emsdk_root/emsdk" ]]; then
  mkdir -p "$emsdk_root"
  git -C "$root/vendor/emsdk" archive HEAD | tar -x -C "$emsdk_root"
fi
"$emsdk_root/emsdk" install "$emsdk_version"
"$emsdk_root/emsdk" activate "$emsdk_version"
# shellcheck source=/dev/null
source "$emsdk_root/emsdk_env.sh"

pthread_flags=(-pthread)
pthread_string="${pthread_flags[*]}"
c_flags="-Os"
if [[ "$async_mode" == jspi ]]; then
  c_flags="$c_flags -fwasm-exceptions"
else
  c_flags="$c_flags -fexceptions"
fi
if [[ -n "$pthread_string" ]]; then
  c_flags="$c_flags $pthread_string"
fi
libusb_c_flags="$c_flags"
loader_cxx_flags="$c_flags"
link_flags=(
  "${pthread_flags[@]}"
  -lembind
  -s STRICT=1
  -s INVOKE_RUN=0
  -s EXIT_RUNTIME=1
  -s MALLOC=emmalloc
  -s INITIAL_MEMORY=33554432
  "-s EXPORTED_RUNTIME_METHODS=FS,stackAlloc,stringToUTF8OnStack,ccall,callMain"
  "-s EXPORTED_FUNCTIONS=_main,_fflush"
  -s MODULARIZE=1
  -s EXPORT_NAME=instantiate
  -s EXPORT_ES6=1
  "-s ENVIRONMENT=worker,node"
  -s TEXTDECODER=1
)
if [[ "$async_mode" == jspi ]]; then
  link_flags+=(-fwasm-exceptions -s JSPI=1)
else
  link_flags+=(-s ASYNCIFY=1 -s DISABLE_EXCEPTION_CATCHING=0)
fi
link_string="${link_flags[*]}"

mkdir -p "$prefix"
emcmake cmake \
  -S "$root/vendor/zlib" \
  -B "$out/zlib-build" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_C_FLAGS="$c_flags" \
  -DCMAKE_CXX_FLAGS="$c_flags" \
  -DZLIB_BUILD_EXAMPLES=OFF \
  -DZLIB_BUILD_TESTING=OFF \
  -DZLIB_BUILD_SHARED=OFF \
  -DZLIB_BUILD_STATIC=ON
emmake make -C "$out/zlib-build" -j"$jobs"
emmake make -C "$out/zlib-build" install

libusb_source="$out/libusb-source"
libusb_build="$out/libusb-build"
mkdir -p "$libusb_source" "$libusb_build"
git -C "$root/vendor/libusb" archive HEAD | tar -x -C "$libusb_source"
(
  cd "$libusb_source"
  ./bootstrap.sh
)
(
  cd "$libusb_build"
  CFLAGS="$libusb_c_flags" \
  CXXFLAGS="$libusb_c_flags" \
  LDFLAGS="$pthread_string" \
  ac_cv_host=wasm32-unknown-emscripten \
  ac_cv_func_clock_gettime=yes \
    emconfigure "$libusb_source/configure" \
      --host=wasm32-emscripten \
      --prefix="$prefix" \
      --disable-shared \
      --enable-static
)
emmake make -C "$libusb_build" -j"$jobs" THREAD_CFLAGS="$pthread_string"
emmake make -C "$libusb_build" install THREAD_CFLAGS="$pthread_string"

emcmake cmake \
  -S "$root/vendor/libftdi" \
  -B "$out/libftdi-build" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_INSTALL_PREFIX="$prefix" \
  -DCMAKE_INSTALL_LIBDIR=lib \
  -DCMAKE_C_FLAGS="$c_flags" \
  -DCMAKE_CXX_FLAGS="$c_flags" \
  -DLIBUSB_INCLUDE_DIR="$prefix/include/libusb-1.0" \
  -DLIBUSB_LIBRARIES="$prefix/lib/libusb-1.0.a" \
  -DSTATICLIBS=ON \
  -DSHAREDLIBS=OFF \
  -DFTDI_EEPROM=OFF \
  -DEXAMPLES=OFF \
  -DPYTHON_BINDINGS=OFF \
  -DDOCUMENTATION=OFF \
  -DBUILD_TESTS=OFF \
  -DFTDIPP=OFF
emmake make -C "$out/libftdi-build" -j"$jobs"
emmake make -C "$out/libftdi-build" install

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"

build_openfpgaloader() {
  local build_dir="$1"
  local full="$2"
  local -a options
  if [[ "$full" == no ]]; then
    options=(
      -DENABLE_VENDORS_ALL=OFF
      -DENABLE_GOWIN_SUPPORT=ON
      -DENABLE_CABLE_ALL=OFF
      -DENABLE_FTDI_BASED_CABLE=ON
    )
  else
    options=()
  fi
  emcmake cmake \
    -S "$root/vendor/openFPGALoader" \
    -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_C_FLAGS="$c_flags" \
    -DCMAKE_CXX_FLAGS="$loader_cxx_flags" \
    -DCMAKE_EXE_LINKER_FLAGS="$link_string" \
    "-DCMAKE_CXX_LINKER_LAUNCHER=/usr/bin/time;-v;-o;$build_dir/link-time.txt" \
    -DCMAKE_EXECUTABLE_SUFFIX_CXX=.mjs \
    -DCMAKE_PREFIX_PATH="$prefix" \
    "${options[@]}" &&
    emmake cmake --build "$build_dir" --parallel "$jobs"
}

openfpgaloader_build="$out/openFPGALoader-build"
if build_openfpgaloader "$openfpgaloader_build" no; then
  printf 'Reduced openFPGALoader configuration succeeded.\n'
else
  set +x
  resource_failure=false
  if grep -Eiq 'wasm-opt.*(SIGKILL|killed)|received SIGKILL' "$out/build.log"; then
    resource_failure=true
  fi
  set -x
  if [[ "$resource_failure" == true ]]; then
    printf 'Reduced configuration failed during wasm-opt resource use; skipping full-config fallback.\n' >&2
    exit 1
  fi
  printf 'Reduced configuration failed for a non-resource reason; retrying full upstream defaults.\n'
  openfpgaloader_build="$out/openFPGALoader-full-build"
  build_openfpgaloader "$openfpgaloader_build" yes
fi

link_file="$openfpgaloader_build/CMakeFiles/openFPGALoader.dir/link.txt"
if [[ "$async_mode" == jspi ]] && grep -Eq -- '(^|[[:space:]])-s[[:space:]]+ASYNCIFY(=|[[:space:]]|$)' "$link_file"; then
  printf 'Unexpected ASYNCIFY setting in JSPI linker command: %s\n' "$link_file" >&2
  exit 1
fi

cp "$openfpgaloader_build/openFPGALoader.mjs" "$out/openFPGALoader.mjs"
cp "$openfpgaloader_build/openFPGALoader.wasm" "$out/openFPGALoader.wasm"
printf 'elapsed_seconds=%s\n' "$SECONDS"
