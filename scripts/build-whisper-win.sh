#!/bin/bash
# 받아쓰기 도구(whisper-cli.exe) 만들기 — Windows 판 CUTROAD.exe 안에 들어가요 (engine/assets/whisper-cli.exe)
#   whisper.cpp (MIT, https://github.com/ggml-org/whisper.cpp) 를 MinGW 로 '정적' 빌드해서
#   Visual C++ 런타임 같은 따로 설치할 것이 없는 exe 하나로 만들어요. (AVX2 가 있는 CPU: 2013년 이후 대부분)
#   2026-11-03: whisper.cpp 482279b8 (v1.9.5 이후) 로 만들었어요.
#
#   scripts/build-whisper-win.sh [whisper.cpp 폴더]
# 필요: cmake, mingw-w64 (x86_64-w64-mingw32-g++-posix)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-/tmp/whisper.cpp}"
[ -d "$SRC" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
TC="$(mktemp)"
cat > "$TC" <<'TCF'
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc-posix)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++-posix)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)
set(CMAKE_FIND_ROOT_PATH /usr/x86_64-w64-mingw32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
TCF
# MinGW 헤더에 없는 Windows 11 전용 이름을 채워 줘요 (CPU 절전 힌트, 없어도 동작은 같아요)
python3 - "$SRC/ggml/src/ggml-cpu/ggml-cpu.c" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "        #if _WIN32_WINNT >= 0x0602\n        THREAD_POWER_THROTTLING_STATE t;"
new = """        #if _WIN32_WINNT >= 0x0602
        #ifndef THREAD_POWER_THROTTLING_CURRENT_VERSION
        typedef struct { ULONG Version; ULONG ControlMask; ULONG StateMask; } THREAD_POWER_THROTTLING_STATE;
        #define THREAD_POWER_THROTTLING_CURRENT_VERSION 1
        #define THREAD_POWER_THROTTLING_EXECUTION_SPEED 0x1
        #endif
        THREAD_POWER_THROTTLING_STATE t;"""
if old in s:
    open(p, "w").write(s.replace(old, new))
PY
cmake -S "$SRC" -B "$SRC/build-win" -DCMAKE_TOOLCHAIN_FILE="$TC" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF "-DCMAKE_EXE_LINKER_FLAGS=-static -static-libgcc -static-libstdc++"
cmake --build "$SRC/build-win" --target whisper-cli -j"$(nproc)"
x86_64-w64-mingw32-strip -o "$ROOT/engine/assets/whisper-cli.exe" "$SRC/build-win/bin/whisper-cli.exe"
objdump -p "$ROOT/engine/assets/whisper-cli.exe" | grep "DLL Name"
echo "✔ engine/assets/whisper-cli.exe"
