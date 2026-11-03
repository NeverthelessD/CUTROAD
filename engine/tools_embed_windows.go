//go:build windows

package main

import _ "embed"

// whisper-cli.exe: whisper.cpp (MIT) 를 MinGW 로 정적 빌드한 받아쓰기 프로그램 (scripts/build-whisper-win.sh).
// 따로 설치할 것(Visual C++ 런타임 등)이 없도록 exe 하나로 만들었어요.
//
//go:embed assets/whisper-cli.exe
var whisperExe []byte
