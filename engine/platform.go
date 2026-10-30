package main

// CUTROAD 는 맥(Apple Silicon) 전용이에요. update.go 의 Windows 경로는 쓰이지 않아요.
import "runtime"

var isWindows = runtime.GOOS == "windows"
