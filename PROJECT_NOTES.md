> **이 파일을 읽은 Claude는 작업이 끝날 때마다 이 파일을 업데이트할 것.**
> (구조가 바뀌면 「구조」, 새로 정한 것은 「결정 사항」, 한 일·남은 일은 「진행 사항」에 적고 커밋·푸시까지 할 것)

# CUTROAD — 프로젝트 노트

가볍고 간단한 영상 편집기. macOS (Apple Silicon) · Windows 10/11 (1.3.0~). made by. Nevertheless_D
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
- [x] 8. 1.1 시안 확정: 사진 + 음악으로 영상 만들기 (스타일 7 · 효과 모음) — 2026-10-31
- [x] 9. 1.1.0 맥 시험 통과(41/41) · 출시 (2026-10-31)
- [x] 10. Windows 판 (1.3.0): 엔진이 영상 처리(Go + ffmpeg · whisper) · 화면 안 파일 고르기 · Wine 시험 (2026-11-03)
- [ ] 11. 사용자 Windows PC 에서 확인 (PC 보호 창 · 영상 도구 받기 · 실제 내보내기 속도 · 자동 자막)

## 구조

```
app/Info.plist            앱 정보 (음성 인식 사용 이유 · 영상/소리 파일 열기)
app/AppIcon.svg · .png    아이콘 원본 (빌드할 때 icns 로 바꿔요)
app/shell/main.swift      Dock 앱 · 엔진 켜고 끄기 · 메뉴 · 창 · 끌어다 놓기 · 화면과 주고받기(Bridge)
app/shell/Media.swift     파일 정보(probe) · 썸네일 · 파형 (cache/wave 에 저장)
app/shell/Render.swift    프로젝트 → AVMutableComposition + 직접 만든 Compositor(방향 · 회전 · 맞춤 · 블러 · 페이드 · 트랜지션 · 글자)
app/shell/Export.swift    MP4(H.264+AAC, AVAssetWriter) · GIF(ImageIO) · 컷 편집만(Passthrough, 안 되면 다시 인코딩) · 작업 목록(Jobs)
app/shell/Captions.swift  자동 자막: 영상 소리만 m4a 로 → SFSpeechRecognizer → 줄 나누기
app/shell/Photos.swift   사진 폴더 읽기 · 사진 정보/미리보기 JPG(cache/img) · 음악 박자 찾기(Accelerate FFT, cache/beats)
app/shell/TestTools.swift 시험용 명령 (--test-sample · --test-export · --test-frame …)
engine/                   Go 엔진: main.go(경로 · 설정 · 프로젝트 · /api/media) · projects.go · update.go · supervise.go · diag.go
engine/web/               화면: index.html · css/app.css · js/{util,model,player,timeline,panels,dialogs,main}.js · fonts/
scripts/                  build-mac.sh · ci-mac.sh · smoke-mac.sh · release.sh · publish-download.sh · feed.py · guide.py
docs/                     guide.html → CUTROAD_사용가이드.png · guide-win.html → CUTROAD_Windows_사용가이드.png (scripts/guide.py)

Windows 판 (1.3.0~, 엔진이 영상 처리 — CR.native → POST /api/native)
engine/launcher_windows.go  CUTROAD.exe 실행기: 엔진 복사(%LOCALAPPDATA%\CUTROAD\bin) · 켜기 · Edge/Chrome 앱 창
engine/platform.go          isWindows · uiOS(CUTROAD_FAKE_OS) · engineNative(CUTROAD_NATIVE=engine)
engine/nat.go               /api/native 나누기 · 작업(Job) · 화면 안 파일 고르기 /api/fs/* · 끌어다 놓기 /api/drop
engine/tools.go             ffmpeg 8.0.1(고정 · sha256, 처음 켤 때) · whisper-cli(exe 안) · 받아쓰기 모델 ggml-small(처음 쓸 때)
engine/media.go             probe(ffprobe) · 썸네일(키프레임) · 파형 · 미리보기 사본(HEVC · PCM → 720p H.264)
engine/photos.go            사진 폴더 · 정보(EXIF 방향 · 날짜) · 미리보기 JPG, HEIC 는 ffmpeg
engine/beats.go             박자 찾기 (Photos.swift Beats 와 같은 계산)
engine/plan.go              spec → 클립 · 시간 계산 · 박자 효과 · 움직임 (Render.swift Plan 과 같음)
engine/render.go            장면 그리기 · 넘기기 · MP4(libx264) · GIF(palette) · 컷 편집만(키프레임이면 복사) · 소리 필터
engine/imgops.go · text.go  그림 연산(이동 · 흐림 · 색 행렬 · 섞기) · 글자(IBM Plex Sans KR Bold, assets/)
engine/captions.go          자동 자막: 영상 소리 → 16kHz WAV → whisper-cli -ml 1 -sow → 줄 묶기(Captions.swift 와 같은 규칙)
engine/web/js/win.js        Windows 화면: 고르기 창 · 끌어다 놓기 · 영상 도구 준비 막대 · 단축키 Ctrl 표시(CR.T)
scripts/build-win.sh        CUTROAD.exe(go-winres 아이콘) → releases/CUTROAD-win-<v>.zip · latest-win.json · download/CUTROAD-Windows.zip
scripts/build-whisper-win.sh whisper.cpp → engine/assets/whisper-cli.exe (MinGW 정적, 시스템 DLL 만 씀)
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
- 2026-11-07 v1.3.1 — 사용자 제보(맥): 배경음악을 넣었더니 영상 끝 뒤에 놓여 음영 처리 · 재생 안 됨 · 재생 막대가 그쪽으로 못 감 · 끌어 옮길 수도 없음.
  원인: 「배경음악」은 앞 음악 끝에 이어 붙이는데, 앞 음악이 영상 끝 근처에서 끝나면 새 음악이 영상 끝 뒤(안 들리는 곳)에 놓임.
  타임라인 너비도 영상 길이까지만이라 삐져나간 음악이 화면 밖으로 잘려 잡을 수 없었음.
  · 새 음악: 영상이 5초(짧은 영상은 절반)도 안 남으면 처음(0초)부터 (CR.addBGM).
  · 타임라인 너비/화면 맞춤 = 영상 끝과 배경음악 끝 중 긴 쪽 → 삐져나간 음악도 보이고 잡을 수 있음.
  · 음악 시작은 영상 끝 1초 전까지만(끌기 · 시작 위치 입력 둘 다). 음영 부분에 「앞으로 끌어 옮기세요」 안내.
  · 리눅스 Chromium 시험: 2:21 영상 + 2:20 음악 + 새 음악 → 0초에 놓임, 영상 뒤 음악 보임 · 오른쪽 끌기 막힘(140.5초).
- 2026-11-03 v1.3.0 — 사용자 요청: 영상 편집 프로그램 Windows 용. 사용자 결정: 영상 도구(ffmpeg)는 처음 켤 때 자동으로 받기,
  자동 자막은 처음 쓸 때 정확한 모델(약 490MB) 받기. 맥 판은 그대로(엔진만 같이 씀, 맥에는 글꼴 · whisper 를 넣지 않음).
  · 맥의 Swift 영상 처리를 Go 로 옮김: 장면마다 같은 순서(움직임 → 흐린 배경 → 블러 → 색감 → 필름 → 페이드 → 넘기기 10 → 박자 효과 → 글자),
    영상은 ffmpeg 가 클립별로 잘라 RGBA 로 보내고, 결과는 ffmpeg libx264(bt709, 비트레이트 = 맥과 같은 식) · GIF 는 palettegen/paletteuse.
  · 소리: ffmpeg 필터(atrim · atempo · volume 식으로 페이드/넘기기 크로스페이드 · adelay · amix normalize=0 · apad).
  · 컷 편집만: 모든 컷이 키프레임에서 시작하고 형식이 같으면 concat 복사('원본 그대로'), 아니면 원래 크기로 다시 만듦.
  · whisper.cpp 공식 Windows 판은 VC++ 런타임이 필요해서 MinGW 정적 빌드로 exe 안에 넣음(3.9MB). v1.9.4~ 는 공식 zip 이 없음.
  · Edge/Chrome 은 HEVC · PCM 을 못 열 수 있어서 /api/media 가 미리보기 사본(720p H.264)을 만들어 줌.
  · Edge 앱 창에서 Ctrl+N · Ctrl+Shift+N 은 브라우저가 가져가서 새 프로젝트 단축키는 Windows 에서 안 보여 줌.
  · 시험: 리눅스(실제 ffmpeg · whisper) 내보내기 5종(효과 · 사진 세로 · GIF · 컷 편집 복사/다시 만들기) 장면 그림 확인,
    자동 자막(한국어 espeak · 영어 jfk), 화면(고르기 창 · 내보내기 · 자막 · 단축키 · 사진 만들기). Wine 에서 실제 CUTROAD.exe:
    ffmpeg 설치 · probe(HEVC · HEIC · 한글 경로) · 썸네일 · 파형 · 박자 · 미리보기 사본 · 내보내기 · 자동 자막(모델 → whisper) 통과.
  · 속도(이 서버 2코어): 1080p 12초 단순 = 13.7초, 효과 많은 10초 = 40초. 보통 PC(8코어)는 이보다 빨라요.
- 2026-11-02 v1.2.1 — 사용자 제보: Spotlight 에 CUTROAD 가 둘(응용 프로그램 + 백업 폴더). 이전 버전 보관본(되돌리기용)을
  Support/backup → Support/backup.noindex 로 옮기고(.noindex = Spotlight 가 찾지 않음), 옮길 때 · 업데이트 · 되돌리기 뒤
  lsregister -u 로 '다음으로 열기' 목록에서도 빼요. 엔진이 켜질 때 예전 backup 폴더를 알아서 옮겨요(migrateBackup).
- 2026-11-02 같은 고침을 다른 ROAD 앱에도 적용 · 맥 시험(A1b) 통과 · 출시: MSROAD 1.3.4, SROAD 1.1.1, YTROAD 1.2.1, MPBROAD 1.1.2, ValoROAD 1.0.4,
  MFROAD 1.0.4, FINDEROAD 1.0.2, LIBROAD 1.2.1. CVTROAD 는 개발 중단 · 앱 삭제 상태라 건드리지 않음. road-mac-app 스킬에 규칙 추가 제안.
- 2026-11-02 v1.2.0 — 사용자 요청: 자동 편집이 너무 똑같다 → 사람이 만든 것처럼.
  · CR.sections: 마디별 소리 크기 변화(앞뒤 4마디 평균 차 > 0.12, 4~16마디)로 구간을 나누고 도입/전개/절정/쉬어 가기/마무리로 분류.
  · CR.arrange: 구간마다 컷 길이 묶음(CR.PATTERNS, 예: 절정 [2,2,4,2,2,4] · [1,1,2,2,2,4]) → 자연스러운 컷 →
    구간별로 원래 컷 수 비율대로 사진 수를 나눠 합치기/나누기(절정은 늘 더 빠르게). 사진이 너무 많으면 고르게 골라 씀(used).
  · CR.planEffects: 같은 구간 안은 대부분 바로 컷, 구간이 바뀌는 곳만 넘기기(절정으로 = 번쩍 · 확대 · 빙글 짧게,
    쉬어 가기/마무리로 = 디졸브 · 흐리게 · 검은 화면 길게, 전개 = 밀어내기 · 와이프 · 원형), 움직임은 방향을 번갈아,
    세로 사진은 위아래 · 확대, 몰아치기 컷은 멈춤/툭 확대, 첫 컷 확대 · 마지막 컷 축소, 구간별 움직임 크기(motionAmt).
  · 박자 효과: 펄스는 절정 구간에서만(pulseIn), 번쩍은 절정 첫 박 + 두 마디마다, 흔들림은 절정에서.
  · 화면: 만들기 창에 음악 흐름 띠 + '다른 리듬'(씨앗만 바꿈), 타임라인 박자 줄에 구간 이름, 속성에 '움직임 크기', 구간 표시.
  · 클립에 role {sec, burst} 저장 → '효과 다시 섞기'도 같은 흐름 규칙으로.
- 2026-10-31 v1.1.1 — 사용자 제보: 사진 영상을 타임라인에서 재생하면 노래가 계속 끊김(내보내기는 정상).
  원인: 사진만 있는 구간은 화면 시계(rAF, 한 번에 최대 0.25초)로 시간을 셌는데, 화면이 잠깐 멈추면 시계가 늦어지고
  배경음악과 0.3초 넘게 어긋날 때마다 음악을 되감아서(seek) 소리가 끊겼어요. 고침: 기준 시계 = 영상이 있으면 영상,
  사진만 있으면 재생 중인 배경음악(Player.bgmClock). 음악은 영상이 기준일 때만 0.5초 넘게 어긋나면 맞춰요.
  리눅스 Chromium 시험(0.9초마다 0.35초 멈춤, 8초): 되감기 5번 → 0번, 화면-음악 차이 중앙값 0.001초.
- 2026-10-31 v1.1.0 사진 + 음악으로 영상 만들기 (사용자 요청, 시안 확정 후):
  · 사진: 폴더(하위 포함, 2000장까지) → probe 로 크기(방향 반영) · 찍은 날짜(EXIF) · 1600px 미리보기 JPG · 200px 작은 그림.
    사진 클립 = media.kind 'image', 클립 길이 = out − in. 내보낼 때는 64→320×180 검은 '바탕 영상'(cache/base-v2.mov)을 트랙에 깔고
    Compositor 가 사진 파일을 직접 그려요 (Builder.baseAsset 을 붙잡아 둬야 함: 놓치면 insertTimeRange -12780).
  · 박자: 스펙트럼 변화량 → 자기상관(120 BPM 쪽 가중치) → 90 BPM 아래로 잡히면 두 배 확인 → 박자 위치 · 강박 · 박자별 크기 · 절정.
    배경음악 항목(a.beats)에 음악 기준 시각으로 저장, CR.timelineBeats() 가 타임라인 시각으로 바꿔요(음악을 옮겨도 맞게).
  · 자동 배치 CR.arrange: 분위기별 기본 박자 수(잔잔 8 · 보통 4 · 신나게 2) × 소리 크기(크면 ½, 작으면 ×2) → 박자 칸에 반올림.
    넘기기는 박자 경계 가운데에 오도록 클립 길이 = 칸 + 앞뒤 넘기기/2.
  · 효과(미리보기 CSS = 내보내기 Core Image 같은 값): 움직임 8(CR.motion/Effects.motion), 색감 8(CSS filter 행렬 그대로),
    넘기기 10(dissolve fadeblack flash wipe slide circle zoom spin blur blinds), 박자 효과 3(펄스 · 번쩍 · 흔들림),
    흐린 배경(bgBlur) · 흰 액자(photoFrame) · 오른쪽 아래 글자(pos 'br').
  · 미리보기 구조: stage > fx(박자) > slot(넘기기) > look(블러 · 색감 · 페이드) > [bgfill, video/img, vign].
  · 화면: 만들기 창(CR.openAutoMake), 만든 뒤 안내 줄(효과 다시 섞기 · 다시 만들기), 타임라인 '박자' 줄 · 끝 끌면 박자에 붙음,
    속성: 사진 보이는 시간(2·4·8박) · 움직임 · 색감 · '모든 클립에', 프로젝트: 흐린 배경 · 액자 · 박자 효과.
- 2026-10-31 v1.0.0 출시. 맥 빌드 서버 시험 34개 통과: 파일 정보 · 파형 · 썸네일, 1080p/세로/GIF/컷 편집(원본 그대로) 내보내기,
  결과 길이(트랜지션 겹침 계산) · 글자 · 디졸브 · 블러 장면 그림 확인, Dock 앱 켜기/끄기/고장 재시작/업데이트 뒤 다시 열기.
  앱 크기 13MB. 알게 된 것: 맥 ImageIO 는 GIF 머리를 'GIF87a'로 적음(정상), 맥 파일 이름은 한글이 NFD 라 시험에서 NFC 로 비교.
- 2026-10-31 디자인 확정 → v1.0.0 제작 시작. 리눅스 Chromium(@sparticuz/chromium)으로 화면 시험: 처음 화면 · 가져오기 · 자르기 ·
  트랜지션 · 글자 · 무음 구간 · 내보내기 창 · 자동 자막 창 · 컷 편집만 · 설정 · 라이트/다크 · 재생(영상 두 개 번갈아).
