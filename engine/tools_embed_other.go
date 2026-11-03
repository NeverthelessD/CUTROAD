//go:build !windows

package main

// 맥은 맥 내장 받아쓰기를 써요. 리눅스 시험은 CUTROAD_WHISPER 로 whisper-cli 경로를 알려 줘요.
var whisperExe []byte
