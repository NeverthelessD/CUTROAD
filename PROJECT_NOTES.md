> **이 파일을 읽은 Claude는 작업이 끝날 때마다 이 파일을 업데이트할 것.**
> (구조가 바뀌면 「구조」, 새로 정한 것은 「결정 사항」, 한 일·남은 일은 「진행 사항」에 적고 커밋·푸시까지 할 것)

# CUTROAD — 프로젝트 노트

가볍고 간단한 영상 편집기. macOS (Apple Silicon). made by. Nevertheless_D
사용자는 개발자가 아니에요. 한국어로 쉽게 설명하고, 터미널 사용을 요구하지 말 것. 결과물은 더블클릭으로 쓸 수 있게.

---

## 진행 사항

작업이 중간에 끊기면 아래 체크리스트에서 **처음으로 체크 안 된 항목부터** 이어서 하면 돼요.

- [x] 0. 기능 정하기 · 디자인 시안 (2026-10-31, 사용자 "이걸로 확정")
- [x] 1. 저장소 뼈대 (이 파일, CLAUDE.md, VERSION, .gitignore, 아이콘)
- [x] 2. 엔진(Go): 화면 · 설정 · 프로젝트 저장 · 미리보기용 파일 보내기 · 자동 업데이트 · 진단 (MSROAD 에서 가져옴)
- [x] 3. 앱 껍데기(Swift): Dock 앱 · 지킴이 · 메뉴 · 끌어다 놓기 · 파일 정보 · 썸네일 · 파형 · 내보내기 · 자동 자막
- [x] 4. 화면(웹): 처음 화면 · 전체 편집 · 컷 편집만 · 내보내기 · 자동 자막 · 설정 (리눅스 Chromium 에서 확인)
- [x] 5. 맥 빌드 서버에서 빌드 · 시험 통과 (build=ok · smoke=ok, 34/34)
- [x] 6. 사용 가이드 이미지 · 내려받기 zip · v1.0.0 출시 (2026-10-31)
- [ ] 7. 사용자 맥에서 확인 (자동 자막 권한 창 · 실제 영상)

## 구조

```
app/Info.plist            앱 정보 (음성 인식 사용 이유 · 영상/소리 파일 열기)
app/AppIcon.svg · .png    아이콘 원본 (빌드할 때 icns 로 바꿔요)
app/shell/main.swift      Dock 앱 · 엔진 켜고 끄기 · 메뉴 · 창 · 끌어다 놓기 · 화면과 주고받기(Bridge)
app/shell/Media.swift     파일 정보(probe) · 썸네일 · 파형 (cache/wave 에 저장)
app/shell/Render.swift    프로젝트 → AVMutableComposition + 직접 만든 Compositor(방향 · 회전 · 맞춤 · 블러 · 페이드 · 트랜지션 · 글자)
app/shell/Export.swift    MP4(H.264+AAC, AVAssetWriter) · GIF(ImageIO) · 컷 편집만(Passthrough, 안 되면 다시 인코딩) · 작업 목록(Jobs)
app/shell/Captions.swift  자동 자막: 영상 소리만 m4a 로 → SFSpeechRecognizer → 줄 나누기
app/shell/TestTools.swift 시험용 명령 (--test-sample · --test-export · --test-frame …)
engine/                   Go 엔진: main.go(경로 · 설정 · 프로젝트 · /api/media) · projects.go · update.go · supervise.go · diag.go
engine/web/               화면: index.html · css/app.css · js/{util,model,player,timeline,panels,dialogs,main}.js · fonts/
scripts/                  build-mac.sh · ci-mac.sh · smoke-mac.sh · release.sh · publish-download.sh · feed.py · guide.py
docs/                     guide.html → CUTROAD_사용가이드.png
```

## 결정 사항

- **디자인(확정)**: 그래파이트 작업실 느낌(다크 기본, 라이트도), 강조색 주황 `#FF5A1F`(라이트 `#E5480E`) = 재생 위치.
  트랙 색: 영상 파랑 `#4D86FF` · 영상 소리 청록 `#4FD1C5` · 배경음악 초록 `#6BD38A` · 자막/텍스트 보라 `#A78BFA`.
  글꼴: 로고 Archivo(넓게 118%, 800), 본문 IBM Plex Sans KR(400/600/700), 타임코드 JetBrains Mono — 모두 OFL, 앱 안에 넣음.
  아이콘: 두 클립을 주황 재생 위치 막대가 가르는 모양. ROAD(길) 그림은 쓰지 않음(사용자 요청).
  화면 배치: 위 도구 · 왼쪽 미디어 · 가운데 미리보기 · 오른쪽 속성 · 아래 타임라인(자막 · 영상 · 영상 소리 · 배경음악) · 맨 아래 상태 줄(made by).
- **기능**: 컷편집, 페이드 인/아웃(영상+소리), 볼륨, 블러, 트랜지션(디졸브 · 검은 화면 · 와이프 · 밀어내기), 실행 취소,
  텍스트 · 자막, 배경음악, 속도(0.5~2배), 화면 비율(16:9 · 9:16 · 1:1) · 맞춤 · 회전, 내보내기 프리셋, 오디오 파형, 자동 자막,
  무음 구간 찾기/자르기, **컷 편집만** 모드(사용자 추가 요청).
- **가져오기**: MOV · MP4 · MP3 · WAV · M4A (사용자 요청). **내보내기**: MP4(H.264, 어디서나 재생) + **움짤 GIF**(사용자 요청).
  프리셋: 고화질 1080p · 4K · 용량 작게 720p · 세로 9:16 · 움짤 GIF · 원본 그대로. 컷 편집만 = 원래 화질 그대로(다시 인코딩 없음).
- 영상 처리는 웹이 아니라 맥 내장 기능(Swift)으로. ffmpeg 같은 큰 엔진은 넣지 않음(가볍게).
- 미리보기는 웹(<video> 두 개 A/B + Web Audio)으로 흉내 내고, 결과는 Render.swift 가 같은 계산으로 만듦.
- 볼륨은 0~100% (AVAudioMix 가 100% 넘게는 못 함).
- 트랜지션은 겹치는 방식(iMovie 처럼): 길이 = min(설정, 앞 클립/2, 뒤 클립/2), 그만큼 전체가 짧아짐.
- 엔진 주소 47931 (MSROAD 47917 과 겹치지 않게).

## 작업 기록
- 2026-10-31 v1.0.0 출시. 맥 빌드 서버 시험 34개 통과: 파일 정보 · 파형 · 썸네일, 1080p/세로/GIF/컷 편집(원본 그대로) 내보내기,
  결과 길이(트랜지션 겹침 계산) · 글자 · 디졸브 · 블러 장면 그림 확인, Dock 앱 켜기/끄기/고장 재시작/업데이트 뒤 다시 열기.
  앱 크기 13MB. 알게 된 것: 맥 ImageIO 는 GIF 머리를 'GIF87a'로 적음(정상), 맥 파일 이름은 한글이 NFD 라 시험에서 NFC 로 비교.
- 2026-10-31 디자인 확정 → v1.0.0 제작 시작. 리눅스 Chromium(@sparticuz/chromium)으로 화면 시험: 처음 화면 · 가져오기 · 자르기 ·
  트랜지션 · 글자 · 무음 구간 · 내보내기 창 · 자동 자막 창 · 컷 편집만 · 설정 · 라이트/다크 · 재생(영상 두 개 번갈아).
