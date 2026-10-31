#!/bin/bash
# CUTROAD 실제 맥 시험 (맥 빌드 서버에서 dist/CUTROAD.app 을 /Applications 에 깔고 여러 상황을 시험해요)
# 결과: $OUT/results.txt (PASS/FAIL 한 줄씩), 스크린샷, 내보낸 결과의 장면 그림, 기록 파일
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/ci-out}"
mkdir -p "$OUT"
APPDIR="/Applications/CUTROAD.app"
BIN="$APPDIR/Contents/MacOS/CUTROAD"
SUP="$HOME/Library/Application Support/CUTROAD"
RES="$OUT/results.txt"
: > "$RES"

pass() { echo "PASS  $*" | tee -a "$RES"; }
fail() { echo "FAIL  $*" | tee -a "$RES"; }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

app_pid() { pgrep -x CUTROAD | head -1; }
engines() { pgrep -x cutroad-engine | tr '\n' ' '; }
tok() { cat "$SUP/token" 2>/dev/null; }
port() { cat "$SUP/port" 2>/dev/null; }
ping_ok() { curl -fs -m 2 -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/ping" >/dev/null 2>&1; }
wait_ready() { for _ in $(seq 1 60); do [ -s "$SUP/port" ] && ping_ok && return 0; sleep 0.5; done; return 1; }
wait_gone() { for _ in $(seq 1 30); do [ -z "$(app_pid)" ] && [ -z "$(engines)" ] && return 0; sleep 0.5; done; return 1; }
snap() { echo "--- $1"; ps -axo pid,ppid,stat,comm | grep -E "CUTROAD|cutroad-engine" | grep -v grep; } >> "$OUT/procs.txt"
launch() { open "$APPDIR"; wait_ready; }
dur_of() { "$BIN" --test-probe "$1" 2>/dev/null | python3 -c "import json,sys; print(round(json.load(sys.stdin).get('duration',0),2))" 2>/dev/null; }
near() { python3 -c "import sys; sys.exit(0 if abs(float('$1' or 0)-float('$2'))<=float('$3') else 1)"; }

echo "▶ 준비: 앱 설치 · 시험용 영상"
rm -rf "$APPDIR"; ditto "$ROOT/dist/CUTROAD.app" "$APPDIR"
M="$HOME/CUTROAD-test"; rm -rf "$M"; mkdir -p "$M/out"
"$BIN" --test-sample "$M/바다.mov" 6 640 360 > "$OUT/sample.log" 2>&1
"$BIN" --test-sample "$M/세로.mp4" 4 360 640 >> "$OUT/sample.log" 2>&1
"$BIN" --test-tone "$M/산책.wav" 10 >> "$OUT/sample.log" 2>&1
check "M0 시험 영상 만들기" test -s "$M/바다.mov" -a -s "$M/세로.mp4" -a -s "$M/산책.wav"

echo "▶ M. 파일 정보 · 파형 · 썸네일 (맥 내장 AVFoundation)"
"$BIN" --test-probe "$M/바다.mov" > "$OUT/probe-1.json"; P1=$?
"$BIN" --test-probe "$M/세로.mp4" > "$OUT/probe-2.json"; P2=$?
"$BIN" --test-probe "$M/산책.wav" > "$OUT/probe-3.json"; P3=$?
cat "$OUT"/probe-*.json
check "M1 MOV · MP4 · WAV 정보 읽기" test "$P1$P2$P3" = "000"
check "M2 세로 영상 크기를 세로로 읽음" grep -q '"height":640' "$OUT/probe-2.json"
"$BIN" --test-waveform "$M/바다.mov" > "$OUT/wave.json"; W=$?; cat "$OUT/wave.json"
check "M3 파형 만들기" test "$W" = "0"
"$BIN" --test-thumbs "$M/바다.mov" > "$OUT/thumbs.json"; T=$?; cat "$OUT/thumbs.json"
check "M4 썸네일 만들기" test "$T" = "0"
printf 'not a video' > "$M/가짜.mov"
"$BIN" --test-probe "$M/가짜.mov" > "$OUT/probe-bad.json"; B=$?
check "M5 망가진 파일은 '읽을 수 없어요'" test "$B" != "0"

echo "▶ X. 내보내기 (화면에서 하는 것과 같은 길)"
SPEC="$M/spec.json"
python3 - "$M" > "$SPEC" <<'PY'
import json, sys
m = sys.argv[1]
print(json.dumps({
  "clips": [
    {"path": m + "/바다.mov", "in": 0, "out": 6, "speed": 1, "volume": 1, "fadeIn": 0.5, "fadeOut": 0, "blur": 0, "rotate": 0, "trans": {"type": "dissolve", "dur": 1.0}},
    {"path": m + "/세로.mp4", "in": 0, "out": 4, "speed": 2, "volume": 0.8, "fadeIn": 0, "fadeOut": 0.5, "blur": 6, "rotate": 0, "trans": None}],
  "audio": [{"path": m + "/산책.wav", "start": 0.5, "in": 0, "out": 10, "volume": 0.5, "fadeIn": 1, "fadeOut": 1}],
  "texts": [{"text": "여름 여행", "start": 0, "end": 2.5, "pos": "center", "size": "l", "box": False},
            {"text": "오늘은 바다 보러 왔어요", "start": 2.5, "end": 5.5, "pos": "bottom", "size": "m", "box": True}],
  "aspect": "16:9", "fit": "fit",
  "out": {"preset": "hd", "dir": m + "/out", "name": "여름 여행"}}, ensure_ascii=False))
PY
"$BIN" --test-export "$SPEC" > "$OUT/export-hd.json" 2>&1; E1=$?; cat "$OUT/export-hd.json"
check "X1 1080p MP4 내보내기" test "$E1" = "0" -a -s "$M/out/여름 여행.mp4"
D=$(dur_of "$M/out/여름 여행.mp4")
check "X2 길이가 맞음 (6 + 4÷2 − 트랜지션 1 = 7초, 결과 ${D:-?}초)" near "$D" 7 0.2
"$BIN" --test-probe "$M/out/여름 여행.mp4" > "$OUT/probe-out.json"; cat "$OUT/probe-out.json"
check "X3 1920×1080 · 소리 있음" bash -c "grep -q '\"width\":1920' '$OUT/probe-out.json' && grep -q '\"hasAudio\":true' '$OUT/probe-out.json'"
"$BIN" --test-frame "$M/out/여름 여행.mp4" 1.2 "$OUT/frame-title.png"
"$BIN" --test-frame "$M/out/여름 여행.mp4" 5.5 "$OUT/frame-dissolve.png"
"$BIN" --test-frame "$M/out/여름 여행.mp4" 6.4 "$OUT/frame-blur.png"
check "X4 결과 장면 그림 (글자 · 트랜지션 · 블러)" test -s "$OUT/frame-title.png" -a -s "$OUT/frame-dissolve.png"
"$BIN" --test-export "$SPEC" > /dev/null 2>&1
check "X5 같은 이름이면 '(2)'를 붙여 따로 저장" test -s "$M/out/여름 여행 (2).mp4"

python3 - "$SPEC" vertical "세로" > "$M/spec-v.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["out"]["preset"] = sys.argv[2]; s["out"]["name"] = sys.argv[3]; print(json.dumps(s, ensure_ascii=False))
PY
"$BIN" --test-export "$M/spec-v.json" > "$OUT/export-v.json" 2>&1; E2=$?
"$BIN" --test-probe "$M/out/세로.mp4" > "$OUT/probe-v.json"
check "X6 세로 영상(1080×1920) 내보내기" bash -c "test $E2 = 0 && grep -q '\"height\":1920' '$OUT/probe-v.json'"
"$BIN" --test-frame "$M/out/세로.mp4" 1.2 "$OUT/frame-vertical.png"

python3 - "$SPEC" > "$M/spec-gif.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["out"].update({"preset": "gif", "name": "움짤", "range": [0.5, 2.5]}); print(json.dumps(s, ensure_ascii=False))
PY
"$BIN" --test-export "$M/spec-gif.json" > "$OUT/export-gif.json" 2>&1; E3=$?; cat "$OUT/export-gif.json"
echo "GIF 끝 코드: $E3"; ls -la "$M/out/" | grep -i gif
GOK=$(python3 - "$M/out" <<'PY'
import os, sys, unicodedata
d = sys.argv[1]
for f in os.listdir(d):
    if unicodedata.normalize("NFC", f) == "움짤.gif":
        print("ok" if open(os.path.join(d, f), "rb").read(6) in (b"GIF89a", b"GIF87a") else "bad")
PY
)
check "X7 움짤(GIF) 만들기 (끝 코드 $E3, 파일 ${GOK:-없음})" test "$E3" = "0" -a "$GOK" = "ok"
cp "$M"/out/*.gif "$OUT/" 2>/dev/null

python3 - "$M" > "$M/spec-quick.json" <<'PY'
import json, sys
m = sys.argv[1]
print(json.dumps({"clips": [{"path": m + "/바다.mov", "in": 0, "out": 2}, {"path": m + "/바다.mov", "in": 3, "out": 6}],
  "audio": [], "texts": [], "aspect": "16:9", "fit": "fit", "out": {"preset": "quick", "dir": m + "/out", "name": "컷 편집"}}, ensure_ascii=False))
PY
"$BIN" --test-export "$M/spec-quick.json" > "$OUT/export-quick.json" 2>&1; E4=$?; cat "$OUT/export-quick.json"
DQ=$(dur_of "$M/out/컷 편집.mp4")
check "X8 컷 편집만: 원래 화질 그대로 저장 (5초, 결과 ${DQ:-?}초)" bash -c "test $E4 = 0 && python3 -c 'import sys; sys.exit(0 if abs(float(\"${DQ:-0}\")-5)<0.2 else 1)'"
check "X9 컷 편집만: 다시 인코딩하지 않음" grep -q '원본 그대로' "$OUT/export-quick.json"
ls -la "$M/out" > "$OUT/out-files.txt"

echo "▶ S. 사진 + 음악 (1.1)"
PH="$M/사진들"; rm -rf "$PH"; mkdir -p "$PH/여름"
"$BIN" --test-photos "$PH" 7 > /dev/null 2>&1
"$BIN" --test-photos "$PH/여름" 3 > /dev/null 2>&1
"$BIN" --test-scan "$PH" > "$OUT/scan.json"; cat "$OUT/scan.json"
check "S1 폴더의 사진 읽기 (하위 폴더 포함 10장 · 미리보기 · 세로 사진)" python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d['count']==10 and d['ok']==10 and d['portrait']>=3 else 1)" "$OUT/scan.json"
"$BIN" --test-clicks "$M/박자120.wav" 120 40 > /dev/null 2>&1
"$BIN" --test-beats "$M/박자120.wav" > "$OUT/beats120.json"; cat "$OUT/beats120.json"
check "S2 박자 찾기: 120 BPM 시험 음악" python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if abs(d['bpm']-120)<=2 and d['beats']>=70 else 1)" "$OUT/beats120.json"
"$BIN" --test-clicks "$M/박자92.wav" 92 40 > /dev/null 2>&1
"$BIN" --test-beats "$M/박자92.wav" > "$OUT/beats92.json"; cat "$OUT/beats92.json"
check "S3 박자 찾기: 92 BPM 시험 음악" python3 -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if abs(d['bpm']-92)<=2 else 1)" "$OUT/beats92.json"
python3 - "$M" "$PH" > "$M/spec-photo.json" <<'PY'
import json, os, sys
m, ph = sys.argv[1], sys.argv[2]
files = sorted([os.path.join(ph, f) for f in os.listdir(ph) if f.lower().endswith((".jpg", ".png"))])[:7] + sorted([os.path.join(ph, "여름", f) for f in os.listdir(os.path.join(ph, "여름"))])[:3]
T = ["dissolve", "fadeblack", "flash", "wipe", "slide", "circle", "zoom", "spin", "blur", "blinds"]
F = ["warm", "cool", "vivid", "mono", "vintage", "film", "faded", "none", "warm", "film"]
Mo = ["zoomIn", "zoomOut", "panL", "panR", "up", "down", "tilt", "none", "zoomIn", "panL"]
clips = []
for i, f in enumerate(files):
    port = i % 3 == 2
    clips.append({"path": f, "kind": "image", "w": 600 if port else 1200, "h": 900 if port else 800, "in": 0, "out": 2.5,
                  "motion": Mo[i], "filter": F[i], "fadeIn": 0.5 if i == 0 else 0, "fadeOut": 0.8 if i == 9 else 0,
                  "trans": {"type": T[i], "dur": 0.5} if i < 9 else None})
beats = [round(0.25 + k * 0.5, 3) for k in range(42)]
print(json.dumps({"clips": clips, "audio": [{"path": m + "/박자120.wav", "start": 0, "in": 0, "out": 20.5, "volume": 0.8, "fadeIn": 0, "fadeOut": 1.5}],
  "texts": [{"text": "여름 휴가 2026", "start": 0, "end": 2.2, "pos": "center", "size": "l", "box": False},
            {"text": "2026. 8. 3.", "start": 2.2, "end": 4.5, "pos": "br", "size": "s", "box": False}],
  "aspect": "16:9", "fit": "fit", "bgBlur": True, "photoFrame": True,
  "beatFx": {"pulse": True, "flash": True, "shake": True, "beats": beats, "flashes": beats[::4], "climax": [[8, 14]]},
  "out": {"preset": "hd", "dir": m + "/out", "name": "사진 영상"}}, ensure_ascii=False))
PY
"$BIN" --test-base > "$OUT/base.json" 2>&1; cat "$OUT/base.json"
"$BIN" --test-export "$M/spec-photo.json" > "$OUT/export-photo.json" 2>&1; E5=$?; cat "$OUT/export-photo.json"
DP=$(dur_of "$M/out/사진 영상.mp4")
check "S4 사진 10장 + 효과(움직임 · 색감 · 넘기기 10가지 · 박자 효과 · 액자 · 흐린 배경)로 MP4 (20.5초, 결과 ${DP:-?}초)" bash -c "test $E5 = 0 && python3 -c 'import sys; sys.exit(0 if abs(float(\"${DP:-0}\")-20.5)<0.2 else 1)'"
for T in 0.3 1.2 2.25 4.25 6.25 8.25 10.25 12.25 14.25 16.25 18.25 19.9; do
  "$BIN" --test-frame "$M/out/사진 영상.mp4" "$T" "$OUT/photo-$T.png" 2>/dev/null
done
check "S5 결과 장면 그림 12장" bash -c "ls '$OUT'/photo-*.png | wc -l | grep -q 12"
python3 - "$M/spec-photo.json" > "$M/spec-photo-q.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["out"].update({"preset": "quick", "name": "사진 컷"})
for c in s["clips"]: c.update({"motion": "none", "filter": "none", "trans": None})
s["audio"] = []; s["texts"] = []; s.pop("beatFx", None)
print(json.dumps(s, ensure_ascii=False))
PY
"$BIN" --test-export "$M/spec-photo-q.json" > "$OUT/export-photo-q.json" 2>&1; E6=$?; cat "$OUT/export-photo-q.json"
check "S6 컷 편집만 저장에 사진이 섞여도 MP4로 (다시 인코딩)" bash -c "test $E6 = 0 && grep -q '다시 인코딩' '$OUT/export-photo-q.json'"
python3 - "$M/spec-photo.json" > "$M/spec-photo-g.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1])); s["out"].update({"preset": "gif", "name": "사진 움짤", "range": [1.5, 4.5]}); print(json.dumps(s, ensure_ascii=False))
PY
"$BIN" --test-export "$M/spec-photo-g.json" > "$OUT/export-photo-g.json" 2>&1; E7=$?
check "S7 사진 영상 움짤" test "$E7" = "0"
cp "$M"/out/사진*.gif "$OUT/" 2>/dev/null

echo "▶ A. 켜기 · 화면"
mkdir -p "$SUP/projects"
python3 - "$M" "$SUP/projects/smoketest01.json" <<'PY'
import json, sys, time
m, out = sys.argv[1], sys.argv[2]
def media(i, name, kind, dur, w=None, h=None):
    d = {"id": i, "path": m + "/" + name, "name": name, "kind": kind, "duration": dur, "hasAudio": True}
    if w: d.update({"width": w, "height": h, "fps": 30})
    return d
p = {"v": 1, "id": "smoketest01", "name": "시험 프로젝트", "mode": "full", "aspect": "16:9", "fit": "fit",
  "media": [media("m1", "바다.mov", "video", 6, 640, 360), media("m2", "세로.mp4", "video", 4, 360, 640), media("m3", "산책.wav", "audio", 10)],
  "clips": [{"id": "c1", "mediaId": "m1", "in": 0, "out": 6, "speed": 1, "volume": 1, "fadeIn": 0.5, "fadeOut": 0, "blur": 0, "rotate": 0, "trans": {"type": "dissolve", "dur": 1}},
            {"id": "c2", "mediaId": "m2", "in": 0, "out": 4, "speed": 1, "volume": 1, "fadeIn": 0, "fadeOut": 0, "blur": 0, "rotate": 0, "trans": None}],
  "audio": [{"id": "a1", "mediaId": "m3", "start": 0, "in": 0, "out": 10, "volume": 0.6, "fadeIn": 1, "fadeOut": 1.5}],
  "texts": [{"id": "t1", "kind": "title", "text": "여름 여행", "start": 0, "end": 2.5, "pos": "center", "size": "l", "box": False}],
  "updatedAt": int(time.time() * 1000)}
json.dump(p, open(out, "w"), ensure_ascii=False)
PY
printf '{"appearance":"dark","autoSave":true,"autoUpdate":false,"exportPreset":"hd","openOnStart":"smoketest01","ui":{}}' > "$SUP/settings.json"
launch; check "A1 앱을 열면 엔진이 준비됨" ping_ok
check "A2 엔진이 Dock 앱 방식으로 켜짐(shell=native)" bash -c "curl -fs -H 'x-token: $(tok)' http://127.0.0.1:$(port)/api/ping | grep -q '\"shell\":\"native\"'"
check "A3 주소가 47931" test "$(port)" = "47931"
N=$(curl -fs -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/projects" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['projects']))" 2>/dev/null)
check "A4 프로젝트 목록 읽기 (${N:-?}개)" test "${N:-0}" -ge 1
sleep 9
screencapture -x "$OUT/shot-editor-dark.png"
check "A5 화면이 앱 창(WKWebView)에서 열림" grep -q "CUTROADShell" "$SUP/requests.log"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Range: bytes=0-99" "http://127.0.0.1:$(port)/api/media?p=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$M/바다.mov")&t=$(tok)")
check "A6 미리보기용 영상을 나눠서 보냄 (HTTP $CODE)" test "$CODE" = "206"
APID=$(app_pid); snap "A 실행 중"
SUPPID=$(ps -axo pid=,ppid=,comm= | awk -v a="$APID" '$2==a && /cutroad-engine/ {print $1}' | head -1)
CHILD=$(ps -axo pid=,ppid=,comm= | awk -v s="$SUPPID" '$2==s && /cutroad-engine/ {print $1}' | head -1)
check "A7 엔진이 CUTROAD 앱의 자식 (앱 $APID → 지킴이 ${SUPPID:-없음} → 엔진 ${CHILD:-없음})" test -n "$SUPPID" -a -n "$CHILD"

echo "▶ B. Dock 아이콘 다시 누르기(reopen)"
osascript -e 'tell application "CUTROAD" to reopen' >/dev/null 2>&1; sleep 1
check "B1 다시 열기 뒤에도 앱·엔진 그대로" test "$(app_pid)" = "$APID"

echo "▶ C. 엔진이 고장으로 꺼지면 지킴이가 다시 켬"
kill -SEGV "$CHILD" 2>/dev/null; sleep 4
check "C1 엔진 다시 켜짐" ping_ok
check "C2 앱은 그대로" test "$(app_pid)" = "$APID"

echo "▶ D. 앱 종료(⌘Q) → 엔진까지 모두 꺼짐"
osascript -e 'tell application "CUTROAD" to quit' >/dev/null 2>&1
check "D1 앱·엔진 모두 꺼짐" wait_gone
snap "D 종료 뒤"

echo "▶ L. 라이트 모드 · 처음 화면"
printf '{"appearance":"light","autoSave":true,"autoUpdate":false,"exportPreset":"hd","ui":{}}' > "$SUP/settings.json"
launch; sleep 7
screencapture -x "$OUT/shot-home-light.png"
check "L1 라이트 모드로 다시 켜짐" ping_ok

echo "▶ E. 화면의 '종료'(= /api/quit) → 앱도 꺼짐"
curl -fs -X POST -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/quit" >/dev/null
check "E1 앱·엔진 모두 꺼짐" wait_gone

echo "▶ F. 앱이 강제로 꺼지면 엔진도 스스로 꺼짐"
launch; kill -9 "$(app_pid)"; sleep 1
check "F1 남은 엔진 없음" bash -c 'for i in $(seq 1 20); do [ -z "$(pgrep -x cutroad-engine)" ] && exit 0; sleep 0.5; done; exit 1'

echo "▶ G. 업데이트 뒤 다시 열기 (/api/update/restart)"
launch; OLD=$(app_pid)
curl -fs -X POST -H "x-token: $(tok)" "http://127.0.0.1:$(port)/api/update/restart" >/dev/null
sleep 3
check "G1 새로 열린 앱이 엔진을 켬" wait_ready
NEW=$(app_pid)
check "G2 앱이 새로 열림 ($OLD → ${NEW:-없음})" test -n "$NEW" -a "$NEW" != "$OLD"
osascript -e 'tell application "CUTROAD" to quit' >/dev/null 2>&1; wait_gone

echo "▶ H. 앱 파일을 직접 실행한 경우 → 정식 방법으로 다시 열림"
CUTROAD_RESTART=1 "$BIN" >/dev/null 2>&1 &
sleep 4
check "H1 다시 열린 앱이 엔진을 켬" wait_ready
check "H2 앱 하나만 떠 있음 ($(pgrep -x CUTROAD | wc -l | tr -d ' ')개)" test "$(pgrep -x CUTROAD | wc -l | tr -d ' ')" = "1"
osascript -e 'tell application "CUTROAD" to quit' >/dev/null 2>&1
check "H3 끝나면 모두 꺼짐" wait_gone

echo "▶ 기록 모으기"
for f in launcher.log requests.log engine.log engine.prev.log engine.out engine.prev.out settings.json; do
  [ -f "$SUP/$f" ] && cp "$SUP/$f" "$OUT/$f"
done
sw_vers > "$OUT/macos.txt"
du -sh "$APPDIR" > "$OUT/app-size.txt"
echo
echo "== 결과 =="; cat "$RES"
! grep -q '^FAIL' "$RES"
