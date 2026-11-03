//go:build !darwin

package main

import _ "embed"

// 내보낸 영상의 글자 · 자막 글꼴: IBM Plex Sans KR Bold (OFL, assets/LICENSE-IBMPlexSansKR.txt).
// Windows 화면 미리보기도 같은 글꼴(web/fonts)이라 미리보기와 결과가 같아 보여요.
//
//go:embed assets/IBMPlexSansKR-Bold.ttf
var textFontTTF []byte
