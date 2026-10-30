// CUTROAD — 시작 · 단축키 · 끌어다 놓기 · 메뉴 · 업데이트 알림
// made by. Nevertheless_D
'use strict';

CR.applyTheme = function () {
  const a = (CR.S.settings && CR.S.settings.appearance) || 'system';
  const dark = a === 'dark' || (a === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (CR.S.view !== 'home' && CR.P) CR.render('timeline');
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => CR.applyTheme());

// 앱 껍데기가 부르는 곳
window.cutroadDropped = function (paths, skipped) {
  document.getElementById('dropcover').classList.remove('on');
  if (skipped) CR.toast('지원하지 않는 파일 ' + skipped + '개는 건너뛰었어요 (MOV · MP4 · MP3 · WAV · M4A)', { bad: true });
  if (!paths || !paths.length) return;
  if (CR.modalOpen()) return;
  if (CR.S.view === 'home' || !CR.P) CR.startNew(paths);
  else CR.importPaths(paths);
};
window.cutroadDragHover = function (on) {
  document.getElementById('dropcover').classList.toggle('on', !!on && !CR.modalOpen());
};
window.cutroadMenu = function (id) {
  if (CR.modalOpen() && id !== 'settings') return;
  switch (id) {
    case 'new': CR.save.now(); CR.startNew(); break;
    case 'home': if (CR.S.view !== 'home') CR.goHome(); break;
    case 'import': if (CR.S.view === 'home') CR.startNew(); CR.pickImport(); break;
    case 'export': if (CR.P) CR.openExport(); break;
    case 'settings': CR.openSettings(); break;
    case 'shortcuts': CR.openSettings('keys'); break;
    case 'mode-full': if (CR.P) CR.setMode('full'); break;
    case 'mode-quick': if (CR.P) CR.setMode('quick'); break;
  }
};

// 단축키
addEventListener('keydown', (e) => {
  if (CR.modalOpen()) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const cmd = e.metaKey || e.ctrlKey;
  const k = e.key;
  const native = CR.hasNative; // 앱 안에서는 메뉴가 처리하는 단축키(⌘N · ⌘O · ⌘I · ⌘E · ⌘, · ⌘1 · ⌘2)는 메뉴에 맡겨요
  const stop = () => { e.preventDefault(); e.stopPropagation(); };
  if (CR.S.view === 'home') {
    if (!native && cmd && k === 'n') { stop(); CR.startNew(); }
    return;
  }
  if (!CR.P) return;
  const fstep = 1 / ((CR.P && CR.kept()[0] && CR.media(CR.kept()[0].mediaId) && CR.media(CR.kept()[0].mediaId).fps) || 30);
  if (cmd && (k === 'z' || k === 'Z')) { stop(); if (e.shiftKey) CR.redo(); else CR.undo(); return; }
  if (cmd && k === 'y') { stop(); CR.redo(); return; }
  if (cmd && (k === 'b' || k === 'B')) { stop(); CR.split(); return; }
  if (cmd && k === 's') { stop(); CR.save.now(); CR.toast('저장했어요'); return; }
  if (cmd && (k === '=' || k === '+' || k === '-')) {
    stop();
    if (CR.quick()) return;
    const fit = CR.S.fitPps || CR.S.pps;
    const z = CR.clamp(CR.ppsToZoom(CR.S.pps, fit) + (k === '-' ? -12 : 12), 0, 100);
    CR.S.zoomFit = z <= 0.01;
    CR.S.pps = CR.zoomToPps(z, fit);
    CR.renderTimeline(CR.V.tl);
    return;
  }
  if (!native && cmd) {
    if (k === 'e') { stop(); CR.openExport(); return; }
    if (k === 'i') { stop(); CR.pickImport(); return; }
    if (k === 'o') { stop(); CR.goHome(); return; }
    if (k === ',') { stop(); CR.openSettings(); return; }
    if (k === '1') { stop(); CR.setMode('full'); return; }
    if (k === '2') { stop(); CR.setMode('quick'); return; }
  }
  if (cmd || e.altKey) return;
  switch (k) {
    case ' ': stop(); CR.Player.toggle(); break;
    case 'k': case 'K': stop(); CR.Player.pause(); break;
    case 'l': case 'L': stop(); CR.Player.play(); break;
    case 'j': case 'J': stop(); CR.Player.pause(); CR.Player.seek(CR.S.t - 5); break;
    case 'ArrowLeft': stop(); CR.Player.pause(); CR.Player.seek(CR.S.t - (e.shiftKey ? 1 : fstep)); break;
    case 'ArrowRight': stop(); CR.Player.pause(); CR.Player.seek(CR.S.t + (e.shiftKey ? 1 : fstep)); break;
    case 'Home': stop(); CR.Player.seek(0); break;
    case 'End': stop(); CR.Player.seek(CR.total()); break;
    case 'Backspace': case 'Delete': stop(); CR.deleteSel(); break;
    case 'Escape': CR.select(null); break;
  }
});

// 창 크기가 바뀌면 타임라인 다시 그리기
addEventListener('resize', CR.debounce(() => { if (CR.S.view !== 'home' && CR.P) CR.render('timeline'); }, 150));

// 업데이트 알림: 앱이 새 버전을 알아서 받아 두면 '다시 시작'을 권해요
CR.pollUpdate = async function () {
  try {
    const p = await CR.api('/api/poll?vis=1');
    const u = p.update || {};
    CR.S.updateText = u.status === 'ready' ? '새 버전 ' + u.installed + ' 준비됨' : u.status === 'uptodate' ? '최신 버전이에요' : '';
    if (u.status === 'ready' && !CR.S.updateToast) {
      CR.S.updateToast = true;
      CR.toast('새 버전 ' + u.installed + '이 준비됐어요', { action: () => { CR.save.now(); CR.api('/api/update/restart', {}); }, actionLabel: '다시 시작', ms: 15000 });
    }
  } catch (e) { /* 엔진이 잠깐 바쁠 수 있어요 */ }
};

// 브라우저에서 화면만 시험할 때 쓰는 가짜 앱 기능 (CUTROAD 앱 안에서는 쓰이지 않아요)
if (!CR.hasNative) {
  const fakePeaks = (seed, n) => { const a = []; let s = seed; for (let i = 0; i < n; i++) { s = (s * 9301 + 49297) % 233280; const q = (i % 400) > 300 ? 0.005 : 0.15 + 0.6 * (s / 233280); a.push(q); } return a; };
  CR.mock = {
    probe: async (m) => ({ items: m.paths.map((p, i) => {
      const name = p.split('/').pop(); const ext = name.split('.').pop().toLowerCase();
      const dur = (window.CR_MOCK_DUR && window.CR_MOCK_DUR[name]) || 12 + (name.length % 7) * 4;
      if (!['mov', 'mp4', 'mp3', 'wav', 'm4a'].includes(ext)) return { path: p, name, error: '지원하지 않는 파일이에요' };
      const video = ext === 'mov' || ext === 'mp4';
      return { path: p, name, kind: video ? 'video' : 'audio', duration: dur, width: video ? 1920 : undefined, height: video ? 1080 : undefined, fps: 30, hasAudio: true, size: dur * 2e6 };
    }) }),
    thumbs: async () => ({ frames: [], interval: 0 }),
    waveform: async (m) => ({ perSec: 50, peaks: fakePeaks(m.path.length, 3000) }),
    open: async () => ({ paths: (prompt('가져올 파일 경로 (쉼표로 구분)', '/tmp/바다.mov') || '').split(',').map((s) => s.trim()).filter(Boolean) }),
    chooseFolder: async () => ({ path: '' }),
    title: async () => ({ ok: true }),
    speechStatus: async () => ({ status: 'authorized' }),
    export: async () => ({ id: 'x' }),
    captions: async () => ({ id: 'c' }),
    job: async (m) => (m.id === 'c' ? { state: 'done', progress: 1, result: { lines: [{ text: '오늘은 바다 보러 왔어요', start: 0.8, end: 2.6 }, { text: '바람이 엄청 불어요', start: 3.1, end: 4.9 }] } }
      : { state: 'done', progress: 1, result: { path: '/tmp/여름 여행.mp4', name: '여름 여행.mp4', size: 120e6, seconds: 25 } }),
    cancelJob: async () => ({}),
    reveal: async () => ({}), openFile: async () => ({}),
  };
}

(async function boot() {
  try { CR.S.settings = await CR.api('/api/settings'); } catch (e) { CR.S.settings = {}; }
  CR.applyTheme();
  const open = CR.S.settings.openOnStart;
  if (open) {
    CR.api('/api/settings', { takeOpenOnStart: true }).catch(() => {});
    try { await CR.openProject(open); } catch (e) { CR.go('home'); }
  } else {
    CR.go('home');
  }
  CR.pollUpdate();
  setInterval(CR.pollUpdate, 60000);
  try { const c = await CR.api('/api/crash'); if (c.report) console.warn(c.report); } catch (e) { /* */ }
})();
