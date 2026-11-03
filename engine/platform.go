package main

// 맥 · Windows 차이
//   isWindows     : 실제로 Windows 에서 도는지 (실행기 · 업데이트 · 탐색기)
//   uiOS()        : 화면 문구를 어느 OS 에 맞출지 (시험용 CUTROAD_FAKE_OS=windows)
//   engineNative(): 영상 처리를 엔진(Go + ffmpeg)이 하는지. 맥은 앱 껍데기(Swift · AVFoundation)가 하고,
//                   Windows 는 엔진이 해요 (2.0.0~). 리눅스 시험에서는 CUTROAD_NATIVE=engine 으로 켜요.
import "runtime"

var isWindows = runtime.GOOS == "windows"

func uiOS() string {
	if f := env("FAKE_OS"); f != "" {
		return f
	}
	return runtime.GOOS
}

func engineNative() bool { return isWindows || env("NATIVE") == "engine" }
