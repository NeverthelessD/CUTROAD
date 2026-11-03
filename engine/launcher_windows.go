//go:build windows

package main

// Windows 실행기 — CUTROAD.exe를 더블클릭하면 여기서 시작해요.
//  1) 이미 켜져 있으면 창만 다시 열기 (다른 버전이 켜져 있으면 끄고 새로 시작)
//  2) 자기 자신을 %LOCALAPPDATA%\CUTROAD\bin\cutroad-engine.exe 로 복사해서 엔진으로 실행
//     (그래서 사용자가 둔 CUTROAD.exe는 실행 중이 아니라 업데이트 때 바로 바꿀 수 있어요)
//  3) Edge·Chrome의 "앱 창"(주소창 없는 창)으로 화면을 열기

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func launcherMode() bool {
	return !(len(os.Args) > 1 && os.Args[1] == "--engine")
}

const appTitle = "CUTROAD"

func runLauncher() {
	exe, err := os.Executable()
	if err == nil {
		if p, e := filepath.EvalSymlinks(exe); e == nil {
			exe = p
		}
	}
	low := strings.ToLower(exe)
	if strings.Contains(low, `\appdata\local\temp\`) && (strings.Contains(low, ".zip") || strings.Contains(low, `\temp1_`) || strings.Contains(low, `\rar$`)) {
		messageBox(appTitle, "압축 파일 안에서 바로 실행했어요.\n\n압축 파일을 마우스 오른쪽 버튼으로 눌러 [모두 압축 풀기]를 한 뒤,\n풀린 폴더 안의 CUTROAD.exe를 실행해 주세요.")
		return
	}
	home, _ := os.UserHomeDir()
	support := env("SUPPORT")
	if support == "" {
		support = filepath.Join(os.Getenv("LOCALAPPDATA"), "CUTROAD")
		if os.Getenv("LOCALAPPDATA") == "" {
			support = filepath.Join(home, "AppData", "Local", "CUTROAD")
		}
	}
	bin := filepath.Join(support, "bin")
	os.MkdirAll(bin, 0o755)

	restart := env("RESTART") != ""
	prefPort, token := "", ""

	// 1) 이미 실행 중이면 창만 다시 열기
	if !restart {
		p, t := readTrim(filepath.Join(support, "port")), readTrim(filepath.Join(support, "token"))
		if p != "" && t != "" {
			if b, ok := pingEngine(p, t); ok {
				if b == build {
					openUI(p, t)
					return
				}
				postQuit(p, t)
				waitGone(p, t, 8*time.Second)
			}
		}
	} else {
		// 업데이트 후 다시 시작: 같은 포트·토큰을 써서 열려 있던 창이 그대로 이어지게 해요
		prefPort, token = env("PORT"), env("TOKEN")
		if prefPort != "" {
			waitGone(prefPort, token, 10*time.Second)
		}
	}

	// 2) 엔진 준비 (버전이 바뀌었을 때만 복사)
	engine := filepath.Join(bin, "cutroad-engine.exe")
	stamp := filepath.Join(bin, "build")
	if !fileExists(engine) || readTrim(stamp) != build {
		var cerr error
		for i := 0; i < 40; i++ { // 이전 엔진이 막 꺼지는 중이면 잠깐 기다려요
			if cerr = copyFile(exe, engine); cerr == nil {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if cerr != nil && !fileExists(engine) {
			messageBox(appTitle, "😢 CUTROAD를 준비하지 못했어요.\n\n컴퓨터를 다시 시작한 뒤 실행해 보세요.\n("+cerr.Error()+")")
			return
		}
		if cerr == nil {
			os.WriteFile(stamp, []byte(build), 0o644)
		}
	}

	// 3) 엔진 켜기
	if token == "" {
		token = randID(16)
	}
	os.Remove(filepath.Join(support, "port"))
	cmd := exec.Command(engine, "--engine")
	cmd.Env = append(os.Environ(),
		"CUTROAD_TOKEN="+token, "CUTROAD_SUPPORT="+support, "CUTROAD_APP="+exe, "CUTROAD_PORT="+prefPort, "CUTROAD_PORT_WAIT=1", "CUTROAD_VIA=windows")
	if f, err := os.Create(filepath.Join(support, "engine.out")); err == nil {
		cmd.Stdout, cmd.Stderr = f, f
		defer f.Close()
	}
	detach(cmd)
	if err := cmd.Start(); err != nil {
		messageBox(appTitle, "😢 CUTROAD를 시작하지 못했어요.\n\n백신 프로그램이 막았을 수 있어요. 백신에서 CUTROAD를 허용한 뒤 다시 실행해 주세요.\n("+err.Error()+")")
		return
	}
	cmd.Process.Release()

	port := ""
	for i := 0; i < 100; i++ {
		if port = readTrim(filepath.Join(support, "port")); port != "" {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}
	if port == "" {
		messageBox(appTitle, "😢 CUTROAD를 시작하지 못했어요. 다시 실행해 보세요.\n\n계속 안 되면 백신 프로그램에서 CUTROAD를 허용하거나 컴퓨터를 다시 시작해 주세요.")
		return
	}
	if restart && port == prefPort {
		return // 열려 있던 창이 스스로 새로고침해요
	}
	openUI(port, token)
}

func readTrim(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func pingEngine(port, token string) (string, bool) {
	req, _ := http.NewRequest("GET", "http://127.0.0.1:"+port+"/api/ping", nil)
	req.Header.Set("x-token", token)
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var j struct {
		OK    bool   `json:"ok"`
		Build string `json:"build"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&j) != nil || !j.OK {
		return "", false
	}
	return j.Build, true
}

func postQuit(port, token string) {
	req, _ := http.NewRequest("POST", "http://127.0.0.1:"+port+"/api/quit", strings.NewReader("{}"))
	req.Header.Set("x-token", token)
	if resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req); err == nil {
		resp.Body.Close()
	}
}

func waitGone(port, token string, max time.Duration) {
	end := time.Now().Add(max)
	for time.Now().Before(end) {
		if _, ok := pingEngine(port, token); !ok {
			time.Sleep(400 * time.Millisecond) // 엔진 파일이 풀릴 때까지 조금 더
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// openUI opens the app window: Edge/Chrome/Brave "app" mode (no address bar), else the default browser.
func openUI(port, token string) {
	if env("NO_UI") != "" { // 시험용 (Wine)
		return
	}
	url := fmt.Sprintf("http://127.0.0.1:%s/?t=%s", port, token)
	pf, pf86, local := os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")
	cands := []string{
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(local, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `BraveSoftware\Brave-Browser\Application\brave.exe`),
		filepath.Join(local, `BraveSoftware\Brave-Browser\Application\brave.exe`),
	}
	for _, b := range cands {
		if b == "" || !fileExists(b) {
			continue
		}
		cmd := exec.Command(b, "--app="+url, "--window-size=1480,920")
		if cmd.Start() == nil {
			cmd.Process.Release()
			return
		}
	}
	if err := shellExecute(url); err != nil {
		messageBox(appTitle, "브라우저를 열지 못했어요. 아래 주소를 브라우저 주소창에 붙여넣어 주세요.\n\n"+url)
	}
}
