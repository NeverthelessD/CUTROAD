// CUTROAD — 창들: 내보내기 · 자동 자막 · 설정 · 묻기
// made by. Nevertheless_D
'use strict';

CR.modal = function (dlg, opt) {
  opt = opt || {};
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  CR.Player.pause();
  const wrap = h('div', { class: 'modal' }, dlg);
  const close = () => {
    if (opt.canClose && !opt.canClose()) return;
    wrap.remove();
    removeEventListener('keydown', key, true);
    opt.onClose && opt.onClose();
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  addEventListener('keydown', key, true);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  return close;
};
CR.modalOpen = () => !!document.querySelector('.modal');

function dlgHead(title, sub, onclose, iconEl) {
  return h('div', { class: 'dh' },
    h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', minWidth: 0 } }, iconEl || null,
      h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null)),
    h('button', { class: 'close', 'aria-label': '닫기', onclick: onclose }, I('x')));
}

CR.ask = function (title, value, ok) {
  let close;
  const inp = h('input', { class: 'tin', type: 'text', value: value || '' });
  const done = () => { close(); ok(inp.value); };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(); if (e.key === 'Escape') close(); });
  const dlg = h('div', { class: 'dlg', style: { width: '420px' } }, dlgHead(title, null, () => close()),
    h('div', { class: 'db' }, inp),
    h('div', { class: 'df' }, h('span'), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, '취소'), h('button', { class: 'btn primary', onclick: done }, '확인'))));
  close = CR.modal(dlg);
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
};

CR.confirm = function (title, text, okLabel, ok) {
  let close;
  const dlg = h('div', { class: 'dlg', style: { width: '440px' } }, dlgHead(title, null, () => close()),
    h('div', { class: 'db' }, h('p', { class: 'hint', style: { margin: 0, fontSize: '13px' } }, text)),
    h('div', { class: 'df' }, h('span'), h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => close() }, '취소'),
      h('button', { class: 'btn primary', onclick: () => { close(); ok(); } }, okLabel || '확인'))));
  close = CR.modal(dlg);
};

/** 앱이 하는 오래 걸리는 일(내보내기 · 받아쓰기)을 기다리며 진행률을 보여 줘요 */
CR.watchJob = function (id, onProgress) {
  return new Promise((resolve) => {
    const poll = async () => {
      let s;
      try { s = await CR.native('job', { id }); } catch (e) { s = { state: 'error', error: e.message }; }
      if (s.state === 'running') { onProgress && onProgress(s); setTimeout(poll, 300); } else resolve(s);
    };
    poll();
  });
};

// ---------------------------------------------------------------- 내보내기

CR.PRESETS = [
  { id: 'hd', title: '고화질', tag: '1080p', desc: '대부분의 경우 이걸 고르면 돼요' },
  { id: '4k', title: '4K', tag: '2160p', desc: '원본이 4K일 때 가장 선명하게' },
  { id: 'small', title: '용량 작게', tag: '720p', desc: '메신저로 보내기 좋은 크기' },
  { id: 'vertical', title: '세로 영상', tag: '9:16', desc: '쇼츠 · 릴스 · 틱톡용' },
  { id: 'gif', title: '움짤', tag: 'GIF', desc: '고른 구간을 움직이는 그림으로' },
  { id: 'original', title: '원본 그대로', tag: '원본', desc: '원본 해상도 · 화질 유지' },
];

CR.outSize = function (preset) {
  let asp = CR.P.aspect;
  let short = { '4k': 2160, small: 720, gif: asp === '1:1' ? 360 : 270 }[preset] || 1080;
  if (preset === 'vertical') asp = '9:16';
  if (preset === 'original' || preset === 'quick') {
    const c = CR.kept()[0], m = c && CR.media(c.mediaId);
    short = m && m.width ? Math.min(m.width, m.height) : 1080;
    if (preset === 'quick' && m && m.width) return [m.width, m.height];
  }
  const ev = (v) => Math.round(v / 2) * 2;
  if (asp === '9:16') return [ev(short), ev(short * 16 / 9)];
  if (asp === '1:1') return [ev(short), ev(short)];
  return [ev(short * 16 / 9), ev(short)];
};

CR.openExport = function (forced) {
  if (!CR.P) return;
  const quick = forced === 'quick' || CR.quick();
  const L = CR.timing(CR.kept());
  if (!L.list.length) return CR.toast('타임라인에 영상이 없어요. 먼저 영상을 넣어 주세요');
  const miss = CR.kept().map((c) => CR.media(c.mediaId)).filter((m) => !m || m.missing);
  if (miss.length) return CR.toast('원본 파일을 찾을 수 없는 클립이 있어요: ' + (miss[0] ? miss[0].name : ''), { bad: true });
  const st = {
    preset: quick ? 'quick' : (CR.S.settings.exportPreset || 'hd'),
    name: CR.P.name,
    dir: CR.S.settings.exportDir || '',
    captions: 'burn',
    busy: false,
  };
  const selC = CR.S.sel && CR.S.sel.type === 'clip' && CR.findSel(CR.S.sel);
  let ga = 0;
  if (selC) { const i = L.list.indexOf(selC); if (i >= 0) ga = L.starts[i]; }
  st.range = [CR.round(ga, 1), CR.round(Math.min(L.total, ga + 8), 1)];
  const hasCaps = CR.P.texts.some((x) => x.kind === 'caption');
  let close;
  const dlg = h('div', { class: 'dlg' });
  const draw = () => {
    dlg.innerHTML = '';
    const sub = CR.P.name + ' · ' + CR.human(L.total) + ' · 클립 ' + L.list.length + '개' + (CR.P.texts.length ? ' · 글자 ' + CR.P.texts.length + '개' : '');
    dlg.appendChild(dlgHead(quick ? '저장하기' : '내보내기', sub, () => close()));
    const body = h('div', { class: 'db' });
    dlg.appendChild(body);
    if (st.result) return drawDone(body);
    if (!quick) {
      CR.put(body, h('span', { class: 'lab2' }, '프리셋'), h('div', { class: 'presets' }, CR.PRESETS.map((p) =>
        h('button', { class: 'preset' + (st.preset === p.id ? ' on' : ''), disabled: st.busy, onclick: () => { st.preset = p.id; draw(); } },
          h('span', { class: 't' }, h('b', null, p.title), h('span', null, p.tag)), h('small', null, p.desc)))));
    } else {
      body.appendChild(h('div', { class: 'facts' }, h('div', null, h('small', null, '저장 방식'), h('b', null, '원래 화질 그대로 · MP4')),
        h('div', null, h('small', null, '남는 길이'), h('b', null, CR.short(L.total)))));
      const fx = CR.P.audio.length || CR.P.texts.length || CR.kept().some((c) => c.speed !== 1 || c.blur || c.rotate || c.fadeIn || c.fadeOut || c.trans);
      if (fx) body.appendChild(h('p', { class: 'hint', style: { margin: 0 } }, '효과 · 글자 · 배경음악은 빼고 자른 그대로 저장돼요. 모두 넣으려면 ‘전체 편집’에서 내보내기를 쓰세요.'));
    }
    const nameIn = h('input', { class: 'tin', type: 'text', value: st.name, disabled: st.busy });
    nameIn.addEventListener('input', () => { st.name = nameIn.value; });
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    const ext = st.preset === 'gif' ? '.gif' : '.mp4';
    body.appendChild(h('div', { class: 'g2', style: { gridTemplateColumns: '1fr 240px' } },
      h('label', { class: 'field' }, h('span', { class: 'lab2' }, '파일 이름 (' + ext + ')'), nameIn),
      h('div', { class: 'field' }, h('span', { class: 'lab2' }, '저장 위치'),
        h('button', { class: 'pick', disabled: st.busy, title: st.dir, onclick: async () => {
          try {
            const r = await CR.native('chooseFolder', { start: st.dir });
            if (r.path) { st.dir = r.path; CR.api('/api/settings', { exportDir: r.path }).then((s) => { CR.S.settings = s; }); draw(); }
          } catch (e) { CR.toast(e.message, { bad: true }); }
        } }, I('folder'), h('span', null, CR.folderName(st.dir)), I('down')))));
    if (!quick && st.preset === 'gif') {
      body.appendChild(h('div', { class: 'field' }, h('span', { class: 'lab2' }, '움짤로 만들 구간 (최대 30초)'), h('div', { class: 'field' }, h('div', { class: 'row' },
        numBox2('시작', st.range[0], (v) => { st.range[0] = CR.clamp(v, 0, L.total - 0.2); if (st.range[1] <= st.range[0]) st.range[1] = Math.min(L.total, st.range[0] + 3); draw(); }),
        numBox2('끝', st.range[1], (v) => { st.range[1] = CR.clamp(v, st.range[0] + 0.2, Math.min(L.total, st.range[0] + 30)); draw(); }),
        h('button', { class: 'btn', onclick: () => { st.range = [CR.round(CR.S.t, 1), CR.round(Math.min(L.total, CR.S.t + 6), 1)]; draw(); } }, '재생 위치부터')))));
    }
    if (!quick && st.preset !== 'gif' && hasCaps) {
      body.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } }, h('span', { class: 'lab2' }, '자막'),
        h('div', { class: 'seg' }, [['burn', '영상에 입히기'], ['srt', '자막 파일(.srt) 따로'], ['none', '넣지 않기']].map(([k, label]) =>
          h('button', { class: st.captions === k ? 'on' : '', onclick: () => { st.captions = k; draw(); } }, label)))));
    }
    const [W, H] = CR.outSize(st.preset);
    const dur = st.preset === 'gif' ? st.range[1] - st.range[0] : L.total;
    const fps = 30;
    const bytes = st.preset === 'gif' ? W * H * dur * 12 * 0.12 : st.preset === 'quick'
      ? CR.kept().reduce((s, c) => { const m = CR.media(c.mediaId); return s + (m && m.size && m.duration ? m.size * (c.out - c.in) / m.duration : 0); }, 0)
      : (Math.min(60e6, Math.max(2e6, W * H * fps * 0.2)) + 192e3) * dur / 8;
    const secs = st.preset === 'quick' ? Math.max(2, dur * 0.03) : st.preset === 'gif' ? dur * 1.2 : dur * (W * H > 4e6 ? 0.9 : 0.35);
    body.appendChild(h('div', { class: 'facts' },
      h('div', null, h('small', null, '해상도'), h('b', null, W + '×' + H)),
      h('div', null, h('small', null, '형식'), h('b', null, st.preset === 'gif' ? 'GIF' : st.preset === 'quick' ? 'MP4 · 원본' : 'MP4 · H.264')),
      h('div', null, h('small', null, '예상 크기'), h('b', null, bytes ? '약 ' + CR.bytes(bytes) : '—')),
      h('div', null, h('small', null, '예상 시간'), h('b', null, '약 ' + CR.human(Math.max(2, secs))))));
    if (st.error) body.appendChild(h('div', { class: 'errbox' }, st.error));
    if (st.busy) {
      st.barEl = h('div');
      st.pctEl = h('b', null, '0%');
      st.msgEl = h('span', null, '준비 중…');
      body.appendChild(h('div', { class: 'prog' }, h('div', { class: 'pl' }, st.msgEl, st.pctEl), h('div', { class: 'bar', role: 'progressbar', 'aria-label': '내보내기 진행률' }, st.barEl)));
    }
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, quick ? '다시 인코딩하지 않아서 아주 빨라요' : '맥의 하드웨어 가속으로 빠르게 만들어요'),
      h('div', { class: 'actions' },
        st.busy ? h('button', { class: 'btn', onclick: () => { if (st.job) CR.native('cancelJob', { id: st.job }); } }, '취소')
          : h('button', { class: 'btn', onclick: () => close() }, '닫기'),
        st.busy ? null : h('button', { class: 'btn primary', onclick: start }, I('export'), quick ? '저장하기' : '내보내기'))));
  };
  const numBox2 = (label, value, onset) => {
    const inp = h('input', { type: 'text', value: String(value), 'aria-label': label });
    inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v)) onset(v); });
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
    return h('label', { class: 'num' }, label, h('span', { style: { display: 'flex', gap: '3px', alignItems: 'center' } }, inp, h('em', null, '초')));
  };
  const drawDone = (body) => {
    const r = st.result;
    CR.put(body, h('div', { class: 'donebox' }, h('div', { class: 'ok' }, I('check')),
      h('div', { class: 'tx' }, h('b', null, r.name), h('small', null, CR.bytes(r.size) + ' · ' + CR.human(r.seconds) + ' 걸렸어요' + (r.note === '다시 인코딩' ? ' · 원본 형식이 MP4에 맞지 않아 다시 만들었어요' : '') + (st.srt ? ' · 자막 파일도 저장했어요' : '')))));
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, CR.folderName(r.path.replace(/\/[^/]*$/, '')) + ' 폴더에 저장했어요'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => CR.native('reveal', { path: r.path }) }, I('folder'), 'Finder에서 보기'),
        h('button', { class: 'btn', onclick: () => CR.native('openFile', { path: r.path }) }, I('play'), '열기'),
        h('button', { class: 'btn primary', onclick: () => close() }, '닫기'))));
  };
  const start = async () => {
    st.error = '';
    if (!st.name.trim()) st.name = CR.P.name || 'CUTROAD';
    const spec = CR.spec({ plain: quick, captions: st.captions });
    spec.out = { preset: st.preset, dir: st.dir, name: st.name.trim(), range: st.range };
    if (st.preset !== 'quick') CR.api('/api/settings', { exportPreset: st.preset }).then((s) => { CR.S.settings = s; }).catch(() => {});
    st.busy = true;
    draw();
    try {
      const r = await CR.native('export', { spec });
      st.job = r.id;
      const s = await CR.watchJob(r.id, (p) => {
        if (st.barEl) st.barEl.style.width = Math.round(p.progress * 100) + '%';
        if (st.pctEl) st.pctEl.textContent = Math.round(p.progress * 100) + '%';
        if (st.msgEl && p.message) st.msgEl.textContent = p.message + '…';
      });
      st.busy = false;
      if (s.state === 'done') {
        st.result = s.result;
        if (st.captions === 'srt' && hasCaps && st.preset !== 'gif') {
          try {
            await CR.api('/api/write-text', { path: s.result.path.replace(/\.[^./]+$/, '.srt'), content: CR.srt() });
            st.srt = true;
          } catch (e) { CR.toast('자막 파일은 저장하지 못했어요: ' + e.message, { bad: true }); }
        }
      } else st.error = s.state === 'cancelled' ? '취소했어요.' : (s.error || '내보내지 못했어요');
    } catch (e) {
      st.busy = false;
      st.error = e.message;
    }
    draw();
  };
  draw();
  close = CR.modal(dlg, { canClose: () => !st.busy });
};

CR.folderName = function (p) {
  if (!p) return '동영상 폴더';
  const home = CR.S.settings.home || '';
  if (p === home + '/Movies') return '동영상';
  if (p === home + '/Desktop') return '데스크탑';
  if (p === home + '/Downloads') return '다운로드';
  if (p === home + '/Documents') return '문서';
  return p.split('/').filter(Boolean).pop() || p;
};

// ---------------------------------------------------------------- 자동 자막

CR.openCaptions = function () {
  if (!CR.P) return;
  const L = CR.timing(CR.kept());
  if (!L.list.length) return CR.toast('타임라인에 영상이 없어요. 먼저 영상을 넣어 주세요');
  const st = { lang: 'ko-KR', maxLen: 16, busy: false, lines: null, error: '', denied: false };
  let close;
  const dlg = h('div', { class: 'dlg' });
  const draw = () => {
    dlg.innerHTML = '';
    dlg.appendChild(dlgHead('자동 자막 만들기', '말소리를 받아써서 자막 트랙에 넣어요', () => close(),
      h('div', { class: 'hic', style: { background: 'var(--tFill)', color: 'var(--tLine)' } }, I('mic'))));
    const body = h('div', { class: 'db' });
    dlg.appendChild(body);
    const sel = (opts, val, on) => {
      const s = h('select', { class: 'pick', disabled: st.busy }, opts.map(([v, label]) => h('option', { value: v }, label)));
      s.value = String(val);
      s.addEventListener('change', () => on(s.value));
      return s;
    };
    body.appendChild(h('div', { class: 'g3' },
      h('label', { class: 'field' }, h('span', { class: 'lab2' }, '언어'), sel([['ko-KR', '한국어'], ['en-US', '영어'], ['ja-JP', '일본어']], st.lang, (v) => { st.lang = v; })),
      h('div', { class: 'field' }, h('span', { class: 'lab2' }, '받아쓸 소리'), h('div', { class: 'pick' }, h('span', null, '영상 소리'))),
      h('label', { class: 'field' }, h('span', { class: 'lab2' }, '한 줄 길이'), sel([[16, '짧게 (16자)'], [24, '보통 (24자)'], [32, '길게 (32자)']], st.maxLen, (v) => { st.maxLen = +v; }))));
    if (st.denied) {
      body.appendChild(h('div', { class: 'errbox' }, '음성 인식이 허용되지 않았어요. 시스템 설정 → 개인정보 보호 및 보안 → 음성 인식에서 CUTROAD를 켜 주세요. ',
        h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => CR.native('openSpeechSettings') }, '시스템 설정 열기')));
    } else if (st.error) body.appendChild(h('div', { class: 'errbox' }, st.error));
    if (st.busy) {
      st.barEl = h('div', { style: { background: 'var(--tLine)' } });
      st.pctEl = h('b', null, '0%');
      st.msgEl = h('span', null, '준비 중…');
      body.appendChild(h('div', { class: 'prog', style: { padding: '12px 14px', borderRadius: '10px', background: 'var(--field)' } },
        h('div', { class: 'pl' }, st.msgEl, st.pctEl), h('div', { class: 'bar', style: { background: 'var(--line)' } }, st.barEl)));
    }
    if (st.lines) {
      body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('span', { class: 'lab2' }, '받아쓴 문장 ', h('span', { style: { fontWeight: 400, color: 'var(--dim)' } }, '· 고칠 부분은 바로 눌러서 수정하세요')),
        h('span', { style: { fontSize: '12px', color: 'var(--dim)' } }, st.lines.length + '개')));
      if (!st.lines.length) body.appendChild(h('div', { class: 'hint' }, '받아쓴 말이 없어요. 영상 소리에 말소리가 있는지 확인해 주세요.'));
      else body.appendChild(h('div', { class: 'lines' }, st.lines.map((l, i) => {
        const inp = h('input', { type: 'text', value: l.text, 'aria-label': '자막 문장' });
        inp.addEventListener('input', () => { l.text = inp.value; });
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('focus', () => CR.Player.seek(l.start + 0.01));
        return h('div', { class: 'ln' }, h('span', null, CR.shortD(l.start) + ' → ' + CR.shortD(l.end)), inp,
          h('button', { 'aria-label': '이 줄 빼기', onclick: () => { st.lines.splice(i, 1); draw(); } }, I('x')));
      })));
    }
    const existing = CR.P.texts.filter((x) => x.kind === 'caption').length;
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, '맥에 들어 있는 받아쓰기 기능을 사용해요'),
      h('div', { class: 'actions' },
        st.busy ? h('button', { class: 'btn', onclick: () => { if (st.job) CR.native('cancelJob', { id: st.job }); } }, '취소') : null,
        !st.busy && st.lines ? h('button', { class: 'btn', onclick: run }, '다시 받아쓰기') : null,
        !st.busy && !st.lines ? h('button', { class: 'btn primary', onclick: run }, I('mic'), '받아쓰기 시작') : null,
        !st.busy && st.lines && st.lines.length ? h('button', { class: 'btn primary', onclick: () => {
          const put = (replace) => {
            CR.edit('자동 자막 넣기', () => {
              if (replace) CR.P.texts = CR.P.texts.filter((x) => x.kind !== 'caption');
              st.lines.forEach((l) => { if (l.text.trim()) CR.P.texts.push({ id: 't' + CR.uid(), kind: 'caption', text: l.text.trim(), start: l.start, end: l.end, pos: 'bottom', size: 'm', box: true }); });
            });
            close();
            CR.toast('자막 ' + st.lines.length + '줄을 넣었어요', { action: CR.undo });
          };
          if (existing) CR.confirm('이미 자막이 ' + existing + '개 있어요', '기존 자막을 지우고 새 자막으로 바꿀까요?', '바꾸기', () => put(true));
          else put(false);
        } }, '타임라인에 넣기') : null)));
  };
  const run = async () => {
    st.error = ''; st.denied = false; st.lines = null;
    try {
      const a = await CR.native('speechStatus');
      if (a.status !== 'authorized') { st.denied = true; draw(); return; }
    } catch (e) { st.error = e.message; draw(); return; }
    const spec = CR.spec();
    spec.lang = st.lang; spec.maxLen = st.maxLen;
    st.busy = true;
    draw();
    try {
      const r = await CR.native('captions', { spec });
      st.job = r.id;
      const s = await CR.watchJob(r.id, (p) => {
        if (st.barEl) st.barEl.style.width = Math.round(p.progress * 100) + '%';
        if (st.pctEl) st.pctEl.textContent = Math.round(p.progress * 100) + '%';
        if (st.msgEl && p.message) st.msgEl.textContent = p.message + '…';
      });
      st.busy = false;
      if (s.state === 'done') st.lines = (s.result.lines || []).map((l) => ({ text: l.text, start: l.start, end: l.end }));
      else st.error = s.state === 'cancelled' ? '취소했어요.' : (s.error || '받아쓰지 못했어요');
    } catch (e) { st.busy = false; st.error = e.message; }
    draw();
  };
  draw();
  close = CR.modal(dlg, { canClose: () => !st.busy });
};

// ---------------------------------------------------------------- 설정

CR.SHORTCUTS = [
  ['재생 · 멈춤', 'Space'], ['재생 위치에서 자르기', '⌘B'], ['선택한 것 지우기', '⌫'], ['되돌리기 · 다시 하기', '⌘Z · ⇧⌘Z'],
  ['한 장면 앞 · 뒤로', '← →'], ['1초 앞 · 뒤로', '⇧← ⇧→'], ['처음 · 끝으로', 'Home · End'], ['5초 뒤로 · 멈춤 · 재생', 'J · K · L'],
  ['타임라인 확대 · 축소', '⌘+ · ⌘−'], ['전체 편집 · 컷 편집만', '⌘1 · ⌘2'],
  ['가져오기', '⌘I'], ['내보내기', '⌘E'], ['새 프로젝트', '⌘N'], ['처음 화면', '⌘O'], ['저장', '⌘S'], ['설정', '⌘,'],
];

CR.openSettings = function (tab) {
  const st = { tab: tab || 'general' };
  let close;
  const dlg = h('div', { class: 'dlg settings', style: { width: '720px' } });
  let timer = 0;
  const draw = async () => {
    const S = CR.S.settings;
    dlg.innerHTML = '';
    dlg.appendChild(dlgHead('설정', null, () => close()));
    dlg.appendChild(h('div', { class: 'stabs' }, [['general', '일반', 'gear'], ['keys', '단축키', 'keys'], ['update', '업데이트', 'refresh'], ['about', '정보', 'info']].map(([k, label, ic]) =>
      h('button', { class: st.tab === k ? 'on' : '', onclick: () => { st.tab = k; draw(); } }, I(ic), label))));
    const body = h('div', { class: 'db', style: { padding: '22px 40px 24px', minHeight: '330px' } });
    dlg.appendChild(body);
    const setS = async (k, v) => { CR.S.settings = await CR.api('/api/settings', { [k]: v }); CR.applyTheme(); draw(); CR.status && CR.status(); };
    if (st.tab === 'general') {
      const preset = h('select', { class: 'pick', style: { width: '240px' } }, CR.PRESETS.map((p) => h('option', { value: p.id }, p.title + ' · ' + p.tag)));
      preset.value = S.exportPreset || 'hd';
      preset.addEventListener('change', () => setS('exportPreset', preset.value));
      const auto = h('input', { type: 'checkbox', checked: S.autoSave !== false });
      auto.addEventListener('change', () => setS('autoSave', auto.checked));
      body.appendChild(h('div', { class: 'form' },
        h('span', null, '화면 모드'), h('div', null, h('div', { class: 'seg' }, [['system', '맥 설정 따르기'], ['light', '라이트'], ['dark', '다크']].map(([k, label]) =>
          h('button', { class: (S.appearance || 'system') === k ? 'on' : '', onclick: () => setS('appearance', k) }, label)))),
        h('span', null, '기본 내보내기'), h('div', null, preset),
        h('span', null, '내보낼 폴더'), h('div', null, h('button', { class: 'pick', style: { width: '240px' }, onclick: async () => {
          try { const r = await CR.native('chooseFolder', { start: S.exportDir }); if (r.path) setS('exportDir', r.path); } catch (e) { CR.toast(e.message, { bad: true }); }
        } }, I('folder'), h('span', null, CR.folderName(S.exportDir)), I('down'))),
        h('span', null, '자동 저장'), h('label', { class: 'check' }, auto, '편집하면 바로 저장하기')));
    } else if (st.tab === 'keys') {
      body.appendChild(h('div', { class: 'keys2' }, CR.SHORTCUTS.map(([a, b]) => [h('span', null, a), h('span', { class: 'k' }, b)])));
    } else if (st.tab === 'update') {
      let u = {};
      try { u = (await CR.api('/api/poll')).update || {}; } catch (e) { /* */ }
      const status = {
        idle: '새 버전이 나오면 앱이 알아서 받아요', checking: '확인하는 중…', uptodate: '최신 버전이에요',
        available: '새 버전 ' + (u.latest && u.latest.version || '') + '이 있어요', downloading: '새 버전을 받는 중… ' + Math.round((u.progress || 0) * 100) + '%',
        installing: '설치하는 중…', ready: '새 버전 ' + (u.installed || '') + '이 준비됐어요. 다시 시작하면 바뀌어요', error: u.error || '확인하지 못했어요',
      }[u.status] || '';
      const auto = h('input', { type: 'checkbox', checked: S.autoUpdate !== false });
      auto.addEventListener('change', () => setS('autoUpdate', auto.checked));
      CR.put(body, h('div', { class: 'vcard' }, CR.logoSVG(48),
        h('div', { class: 'tx' }, h('span', { style: { fontWeight: 600, fontSize: '14px' } }, 'CUTROAD ', h('span', { class: 'mono', style: { color: 'var(--sub)', fontWeight: 500 } }, S.build || '')),
          h('span', { class: u.status === 'error' ? '' : 'okline', style: u.status === 'error' ? { color: 'var(--bad)', fontSize: '12px' } : {} }, u.status === 'uptodate' ? I('check') : null, status)),
        u.status === 'ready' ? h('button', { class: 'btn primary', onclick: () => CR.api('/api/update/restart', {}).catch((e) => CR.toast(e.message, { bad: true })) }, '다시 시작')
          : u.status === 'available' ? h('button', { class: 'btn primary', onclick: async () => { await CR.api('/api/update/install', {}); draw(); } }, '새 버전 받기')
          : h('button', { class: 'btn', onclick: async () => { await CR.api('/api/update/check', {}).catch(() => {}); draw(); } }, '업데이트 확인')),
      h('label', { class: 'check' }, auto, '새 버전이 나오면 앱이 알아서 받기'),
      u.canRollback ? h('div', null, h('button', { class: 'btn ghost', onclick: () => CR.confirm('이전 버전(' + u.backupVersion + ')으로 되돌릴까요?', '되돌린 뒤에는 자동 업데이트가 꺼져요.', '되돌리기', async () => {
        try { await CR.api('/api/update/rollback', {}); draw(); } catch (e) { CR.toast(e.message, { bad: true }); }
      }) }, I('restore'), '이전 버전 ' + u.backupVersion + '(으)로 되돌리기')) : null);
      if (u.status === 'downloading' || u.status === 'installing' || u.status === 'checking') { clearTimeout(timer); timer = setTimeout(() => { if (dlg.isConnected && st.tab === 'update') draw(); }, 800); }
    } else {
      CR.put(body, h('div', { style: { display: 'flex', gap: '18px', alignItems: 'center' } }, CR.logoSVG(72),
        h('div', null, h('div', { class: 'word', style: { fontSize: '26px' } }, 'CUT', h('b', null, 'ROAD')),
          h('div', { style: { color: 'var(--sub)', marginTop: '4px' } }, '가볍게 자르고, 붙이고, 바로 내보내는 영상 편집기'),
          h('div', { class: 'mono', style: { color: 'var(--dim)', fontSize: '12px', marginTop: '6px' } }, '버전 ' + (S.build || '') + ' · ' + (S.platform || '')))),
      h('p', { class: 'hint' }, '영상 처리는 맥에 들어 있는 기능(AVFoundation · Core Image · 받아쓰기)으로 해요. 프로젝트는 이 맥에만 저장되고, 영상 파일은 원래 자리 그대로 써요.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => CR.native('diag').catch(() => window.open('/diag')) }, I('info'), '진단 정보 보기')),
      h('div', { style: { fontFamily: 'var(--brand)', color: 'var(--sub)', marginTop: '8px' } }, 'made by. Nevertheless_D'));
    }
    dlg.appendChild(h('div', { class: 'df' }, h('a', { href: '#', style: { color: 'var(--sub)', fontSize: '12px' }, onclick: (e) => { e.preventDefault(); CR.native('diag').catch(() => window.open('/diag')); } }, '진단 정보 보기'),
      h('span', { class: 'made', style: { fontFamily: 'var(--brand)', fontSize: '12px', color: 'var(--dim)' } }, 'made by. Nevertheless_D')));
  };
  draw();
  close = CR.modal(dlg, { onClose: () => clearTimeout(timer) });
};
