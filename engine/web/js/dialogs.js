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
    if (CR.pickerOpen && CR.pickerOpen()) return;
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
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, quick ? (CR.WIN ? '자른 곳이 원본과 맞으면 다시 인코딩하지 않아서 아주 빨라요' : '다시 인코딩하지 않아서 아주 빨라요') : (CR.WIN ? '이 PC 에서 바로 만들어요' : '맥의 하드웨어 가속으로 빠르게 만들어요')),
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
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, CR.folderName(CR.dirName(r.path)) + ' 폴더에 저장했어요'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => CR.native('reveal', { path: r.path }) }, I('folder'), CR.T('Finder에서 보기')),
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
  if (CR.WIN) {
    const sep = '\\';
    if (p === home + sep + 'Videos') return '동영상';
    if (p === home + sep + 'Desktop') return '바탕 화면';
    if (p === home + sep + 'Downloads') return '다운로드';
    if (p === home + sep + 'Documents') return '문서';
  }
  return CR.baseName(p);
};

// ---------------------------------------------------------------- 자동 자막

CR.openCaptions = function () {
  if (!CR.P) return;
  const L = CR.timing(CR.kept());
  if (!L.list.length) return CR.toast('타임라인에 영상이 없어요. 먼저 영상을 넣어 주세요');
  const st = { lang: 'ko-KR', maxLen: 16, busy: false, lines: null, error: '', denied: false };
  if (CR.WIN) CR.native('speechStatus').then((a) => { st.needModel = !!a.needModel; st.modelMB = a.modelMB; if (!st.busy && dlg.isConnected) draw(); }).catch(() => {});
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
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, CR.WIN ? (st.needModel ? '처음 한 번 받아쓰기 모델(약 ' + (st.modelMB || 490) + 'MB)을 받아요 · 그다음부터는 이 PC 안에서만 받아써요' : '이 PC 안에서 받아써요 (인터넷 필요 없음)') : '맥에 들어 있는 받아쓰기 기능을 사용해요'),
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
if (CR.WIN) CR.SHORTCUTS = CR.SHORTCUTS.filter(([, k]) => k !== '⌘N').map(([a, k]) => [a, CR.T(k)]);

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
        h('span', null, '화면 모드'), h('div', null, h('div', { class: 'seg' }, [['system', CR.T('맥 설정 따르기')], ['light', '라이트'], ['dark', '다크']].map(([k, label]) =>
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
      h('p', { class: 'hint' }, CR.WIN ? '영상 처리는 이 PC 안에서 해요(영상 도구 ffmpeg · 받아쓰기 whisper). 프로젝트는 이 PC 에만 저장되고, 영상 파일은 원래 자리 그대로 써요.' : '영상 처리는 맥에 들어 있는 기능(AVFoundation · Core Image · 받아쓰기)으로 해요. 프로젝트는 이 맥에만 저장되고, 영상 파일은 원래 자리 그대로 써요.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => CR.native('diag').catch(() => window.open('/diag')) }, I('info'), '진단 정보 보기')),
      h('div', { style: { fontFamily: 'var(--brand)', color: 'var(--sub)', marginTop: '8px' } }, 'made by. Nevertheless_D'));
    }
    dlg.appendChild(h('div', { class: 'df' }, h('a', { href: '#', style: { color: 'var(--sub)', fontSize: '12px' }, onclick: (e) => { e.preventDefault(); CR.native('diag').catch(() => window.open('/diag')); } }, '진단 정보 보기'),
      h('span', { class: 'made', style: { fontFamily: 'var(--brand)', fontSize: '12px', color: 'var(--dim)' } }, 'made by. Nevertheless_D')));
  };
  draw();
  close = CR.modal(dlg, { onClose: () => clearTimeout(timer) });
};

// ---------------------------------------------------------------- 사진 + 음악으로 영상 만들기 (1.1)

CR.openAutoMake = function (prev) {
  const S0 = prev && CR.STYLES[prev.style] ? prev.style : 'vlog';
  const st = {
    folder: prev ? prev.folder : '', folderName: prev ? prev.folderName : '', photos: [], scanning: '',
    music: null, ana: null, wave: null, musicLoading: '',
    style: S0, motions: [], trans: [], color: 'none', beat: [],
    bgBlur: true, frame: false, mood: 'normal', order: 'date', length: 'music', aspect: '16:9',
    titleOn: true, title: '', dates: false, error: '', busy: false, titleEdited: !!prev,
    seed: Math.floor(Math.random() * 1e9),
  };
  const applyStyle = (k) => {
    st.style = k;
    let p = CR.STYLES[k];
    if (k === 'auto') p = CR.STYLES[CR.autoStyle(st.ana)];
    st.motions = p.motions.slice(); st.trans = p.trans.slice(); st.color = p.color; st.beat = p.beat.slice();
    if (p.mood) st.mood = p.mood;
    st.custom = false;
  };
  applyStyle(S0);
  if (prev) {
    ['motions', 'trans', 'color', 'beat', 'mood', 'order', 'length'].forEach((k) => { if (prev[k] !== undefined) st[k] = Array.isArray(prev[k]) ? prev[k].slice() : prev[k]; });
    if (CR.P) { st.aspect = CR.P.aspect; st.bgBlur = CR.P.bgBlur; st.frame = CR.P.photoFrame; const t = CR.P.texts.find((x) => x.kind === 'title'); st.titleOn = !!t; st.title = t ? t.text : st.folderName; st.dates = CR.P.texts.some((x) => x.pos === 'br'); }
  }
  let close;
  const dlg = h('div', { class: 'dlg automake', style: { width: '960px' } });

  const loadFolder = async (dir) => {
    st.folder = dir; st.folderName = CR.baseName(dir);
    if (!st.title || !st.titleEdited) st.title = st.folderName;
    st.photos = []; st.scanning = '사진을 찾는 중…'; st.error = ''; draw();
    try {
      const r = await CR.native('scanPhotos', { path: dir, recursive: true });
      const paths = r.paths || [];
      if (!paths.length) { st.scanning = ''; st.error = '이 폴더에는 사진(JPG · PNG · HEIC)이 없어요'; draw(); return; }
      st.scanning = '사진 ' + paths.length + '장을 읽는 중…'; draw();
      const p = await CR.native('probe', { paths });
      st.photos = (p.items || []).filter((x) => !x.error && x.kind === 'image');
      const bad = paths.length - st.photos.length;
      st.scanning = '';
      if (bad) CR.toast('읽을 수 없는 사진 ' + bad + '장은 뺐어요', { bad: true });
      const portrait = st.photos.filter((x) => x.height > x.width).length;
      if (!prev && portrait > st.photos.length * 0.6) st.aspect = '9:16';
    } catch (e) { st.scanning = ''; st.error = e.message; }
    draw();
  };
  const loadMusic = async (path) => {
    st.music = null; st.ana = null; st.wave = null; st.musicLoading = '음악을 읽는 중…'; st.error = ''; draw();
    try {
      const p = await CR.native('probe', { paths: [path] });
      const it = (p.items || [])[0];
      if (!it || it.error || !it.hasAudio) throw new Error((it && it.error) || '소리가 없는 파일이에요');
      st.music = it;
      st.musicLoading = '박자를 찾는 중…'; draw();
      const [ana, wave] = await Promise.all([CR.native('beats', { path }), CR.native('waveform', { path }).catch(() => null)]);
      if (ana.error) throw new Error(ana.error);
      if (it.duration && ana.duration > it.duration) ana.duration = it.duration;
      st.ana = ana; st.wave = wave;
      CR.cache.waves[path] = wave || { peaks: [] };
      if (st.style === 'auto') applyStyle('auto');
    } catch (e) { st.music = null; st.error = e.message; }
    st.musicLoading = '';
    draw();
  };

  const plan = () => (st.photos.length && st.ana ? CR.arrange(st.photos.length, st.ana, { mood: st.mood, length: st.length }, CR.rng(st.seed)) : null);
  const SEC_COLOR = { intro: 'rgba(77,134,255,.22)', verse: 'rgba(160,160,170,.10)', chorus: 'rgba(255,90,31,.24)', calm: 'rgba(79,209,197,.18)', outro: 'rgba(167,139,250,.22)' };

  const drawWave = (cv, A) => {
    const W = cv.parentNode.clientWidth || 420, H = 40;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const dur = st.ana.duration || 1;
    const pk = (st.wave && st.wave.peaks) || [], per = (st.wave && st.wave.perSec) || 50;
    if (A) A.sections.forEach((x) => { g.fillStyle = SEC_COLOR[x.type] || 'transparent'; g.fillRect(x.start / dur * W, 0, (x.end - x.start) / dur * W, H); });
    g.strokeStyle = css.getPropertyValue('--bWave').trim(); g.lineWidth = 1.6; g.beginPath();
    for (let x = 2; x < W - 1; x += 3) {
      const a = Math.floor(x / W * dur * per), b = Math.max(a + 1, Math.floor((x + 3) / W * dur * per));
      let v = 0; for (let k = a; k < b && k < pk.length; k++) v = Math.max(v, pk[k]);
      const y = Math.max(0.6, Math.min(1, Math.pow(v, 0.7)) * 15);
      g.moveTo(x, 20 - y); g.lineTo(x, 20 + y);
    }
    g.stroke();
    if (A) {
      g.fillStyle = css.getPropertyValue('--accent').trim();
      A.bounds.slice(1, -1).forEach((b) => g.fillRect(Math.round(b / dur * W) - 1, 0, 2, H));
      if (A.end < dur - 0.2) { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(A.end / dur * W, 0, W, H); }
    }
  };

  const chips = (list, sel, multi, onchange) => h('div', { class: 'chips2' }, list.map(([k, label]) => {
    const on = multi ? sel.includes(k) : sel === k;
    return h('button', { class: on ? 'on' : '', onclick: () => {
      if (multi) { const i = sel.indexOf(k); if (i >= 0) sel.splice(i, 1); else sel.push(k); } else onchange(k);
      st.custom = true; draw();
    } }, label);
  }));
  const seg = (opts, val, on) => h('div', { class: 'seg wide' }, opts.map(([k, label]) => h('button', { class: k === val ? 'on' : '', onclick: () => { on(k); draw(); } }, label)));
  const check = (val, label, on) => { const cb = h('input', { type: 'checkbox', checked: val }); cb.addEventListener('change', () => { on(cb.checked); draw(); }); return h('label', { class: 'check' }, cb, label); };

  const draw = () => {
    dlg.innerHTML = '';
    const A = plan();
    dlg.appendChild(h('div', { class: 'dh' },
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
        h('div', { class: 'hic', style: { background: 'var(--accentSoft)', color: 'var(--accent)' } }, I('photo')),
        h('div', null, h('h1', null, '사진으로 영상 만들기'), h('p', null, '사진 폴더와 음악을 고르면, 음악 박자에 맞춰 알아서 영상을 만들어요'))),
      h('button', { class: 'close', 'aria-label': '닫기', onclick: () => close() }, I('x'))));
    const body = h('div', { class: 'db', style: { gap: '12px' } });
    dlg.appendChild(body);

    // 1 사진 · 2 음악
    const pics = st.photos.slice(0, 6).map((p) => h('div', { style: { backgroundImage: p.thumb ? 'url(' + p.thumb + ')' : '' } }));
    if (st.photos.length > 6) pics.push(h('div', { class: 'more' }, '+' + (st.photos.length - 6)));
    const cv = h('canvas');
    CR.put(body, h('div', { class: 'cols' },
      h('div', { class: 'card' },
        h('div', { class: 'step' }, h('span', { class: 'no' }, '1'), h('b', null, '사진 폴더'), h('div', { class: 'grow' }),
          h('button', { class: 'btn', style: { height: '28px', fontSize: '12px', maxWidth: '230px' }, disabled: !!st.scanning, onclick: async () => {
            try { const r = await CR.native('chooseFolder', { start: st.folder, purpose: 'photos' }); if (r.path) loadFolder(r.path); } catch (e) { CR.toast(e.message, { bad: true }); }
          } }, I('folder'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, st.folderName || '폴더 고르기…'))),
        st.photos.length ? h('div', { class: 'thumbs' }, pics) : h('div', { class: 'empty' }, st.scanning || '사진이 들어 있는 폴더를 골라 주세요'),
        h('span', { class: 'info' }, st.photos.length ? [h('b', null, st.photos.length + '장'), ' · JPG · PNG · HEIC · 하위 폴더 포함'] : '')),
      h('div', { class: 'card' },
        h('div', { class: 'step' }, h('span', { class: 'no' }, '2'), h('b', null, '배경음악'), h('div', { class: 'grow' }),
          h('button', { class: 'btn', style: { height: '28px', fontSize: '12px', maxWidth: '230px' }, disabled: !!st.musicLoading, onclick: async () => {
            try { const r = await CR.native('open', { kind: 'music' }); if (r.paths && r.paths[0]) loadMusic(r.paths[0]); } catch (e) { CR.toast(e.message, { bad: true }); }
          } }, I('music'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, st.music ? st.music.name : '음악 고르기…'))),
        st.ana ? h('div', { class: 'wavebox' }, cv) : h('div', { class: 'empty' }, st.musicLoading || 'MP3 · WAV · M4A'),
        A ? h('div', { class: 'flow' }, A.sections.map((x) => h('span', { style: { flex: String(Math.max(0.6, x.end - x.start)), background: SEC_COLOR[x.type] } }, CR.SECTION_NAMES[x.type])),
          h('button', { class: 'btn ghost', title: '같은 설정으로 컷 리듬만 새로 뽑아요', style: { height: '22px', padding: '0 8px', fontSize: '11px', flex: 'none' }, onclick: () => { st.seed = Math.floor(Math.random() * 1e9); draw(); } }, I('refresh'), '다른 리듬')) : null,
        h('span', { class: 'info' }, st.ana ? [h('b', null, CR.short(st.ana.duration)), ' · 박자 ', h('b', null, Math.round(st.ana.bpm) + ' BPM'),
          st.ana.guessed ? ' (박자가 뚜렷하지 않아 고르게 나눠요)' : '', A ? [' · ', h('span', { style: { color: 'var(--accent)' } }, '|'), ' 사진이 바뀌는 곳'] : ''] : '')),
    ));
    if (st.ana) requestAnimationFrame(() => drawWave(cv, A));

    // 3 스타일
    CR.put(body, h('div', { class: 'step' }, h('span', { class: 'no' }, '3'), h('b', { style: { fontSize: '14px' } }, '스타일'),
      h('span', { style: { fontSize: '12px', color: 'var(--dim)' } }, '고르면 아래 효과가 알맞게 정해져요. 사진마다 효과를 골고루 섞어 써요')),
    h('div', { class: 'styles' }, Object.keys(CR.STYLES).map((k) => {
      const p = CR.STYLES[k];
      const ph = st.photos[(Object.keys(CR.STYLES).indexOf(k) * 3) % Math.max(1, st.photos.length)];
      const look = k === 'auto' ? 'hue-rotate(40deg) saturate(1.2)' : CR.cssFilter(p.color) || 'none';
      return h('button', { class: 'style' + (st.style === k && !st.custom ? ' on' : st.style === k ? ' on' : ''), onclick: () => { applyStyle(k); draw(); } },
        h('span', { class: 'pic', style: { backgroundImage: ph && ph.thumb ? 'url(' + ph.thumb + ')' : '', filter: look } },
          p.color === 'film' ? h('span', { style: { background: 'radial-gradient(circle farthest-corner, transparent 45%, rgba(0,0,0,.6))' } }) : null),
        h('b', null, p.name), h('small', null, p.desc));
    })));

    // 효과 자세히
    CR.put(body, h('div', { class: 'fxbox' },
      h('div', { style: { display: 'flex', justifyContent: 'space-between' } },
        h('span', { style: { fontSize: '12px', fontWeight: 600, color: 'var(--sub)' } }, '효과 자세히 고르기 ', h('span', { style: { fontWeight: 400, color: 'var(--dim)' } }, '· 여러 개 고르면 사진마다 번갈아 써요')),
        h('span', { style: { fontSize: '11px', color: 'var(--dim)' } }, st.custom ? '직접 고른 효과' : '‘' + CR.STYLES[st.style].name + '’ 기본값')),
      h('div', { class: 'fxrow' }, h('span', null, '움직임'), chips(CR.MOTIONS.filter((x) => x[0] !== 'none'), st.motions, true)),
      h('div', { class: 'fxrow' }, h('span', null, '넘기기'), chips(CR.TRANS, st.trans, true)),
      h('div', { class: 'fxrow' }, h('span', null, '색감'), chips(CR.FILTER_NAMES, st.color, false, (k) => { st.color = k; })),
      h('div', { class: 'fxrow' }, h('span', null, '박자 효과'), chips(CR.BEATFX, st.beat, true)),
      h('div', { style: { display: 'flex', gap: '20px', paddingTop: '2px' } },
        check(st.bgBlur, '세로 사진은 뒤를 흐린 배경으로 채우기', (v) => { st.bgBlur = v; }),
        check(st.frame, '사진 테두리 (흰 액자)', (v) => { st.frame = v; }))));

    // 빠르기 · 순서 · 길이 · 비율
    CR.put(body, h('div', { class: 'opts4' },
      h('div', { class: 'field' }, h('span', { class: 'lab2' }, '분위기 (빠르기)'), seg([['calm', '잔잔하게'], ['normal', '보통'], ['upbeat', '신나게']], st.mood, (v) => { st.mood = v; })),
      h('div', { class: 'field' }, h('span', { class: 'lab2' }, '사진 순서'), seg([['date', '찍은 날짜'], ['name', '파일 이름'], ['random', '무작위']], st.order, (v) => { st.order = v; })),
      h('div', { class: 'field' }, h('span', { class: 'lab2' }, '영상 길이'), seg([['music', '음악 전체'], ['photos', '사진 수에 맞춰']], st.length, (v) => { st.length = v; })),
      h('div', { class: 'field' }, h('span', { class: 'lab2' }, '화면 비율'), seg([['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1']], st.aspect, (v) => { st.aspect = v; }))));

    const tIn = h('input', { class: 'tin', type: 'text', value: st.title, 'aria-label': '제목', style: { height: '30px', flex: 1, minWidth: 0 } });
    tIn.addEventListener('input', () => { st.title = tIn.value; st.titleEdited = true; });
    tIn.addEventListener('keydown', (e) => e.stopPropagation());
    const tcb = h('input', { type: 'checkbox', checked: st.titleOn });
    tcb.addEventListener('change', () => { st.titleOn = tcb.checked; });
    CR.put(body, h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } },
      h('label', { class: 'check', style: { flex: 1 } }, tcb, h('span', { style: { whiteSpace: 'nowrap' } }, '첫 화면 제목'), tIn),
      check(st.dates, '사진 찍은 날짜를 작게 넣기', (v) => { st.dates = v; })));

    if (A) {
      const avg = A.end / st.photos.length;
      void avg;
      CR.put(body, h('div', { class: 'facts' },
        h('div', null, h('small', null, '영상 길이'), h('b', null, CR.short(A.end))),
        h('div', null, h('small', null, '컷 리듬'), h('b', null, CR.round(Math.min(...A.shots.map((x) => x.t1 - x.t0)), 1) + '~' + CR.round(Math.max(...A.shots.map((x) => x.t1 - x.t0)), 1) + '초' +
          (A.shots.some((x) => x.burst) ? ' · 몰아치기 ' + A.shots.filter((x, i) => x.burst && !(A.shots[i - 1] || {}).burst).length + '번' : ''))),
        h('div', null, h('small', null, '효과'), h('b', null, '움직임 ' + st.motions.length + ' · 넘기기 ' + st.trans.length + ' · 박자 ' + st.beat.length)),
        h('div', null, h('small', null, '끝부분'), h('b', null, A.end < st.ana.duration - 0.5 ? '음악 페이드 아웃' : '음악과 함께 끝'))));
      if (A.used < st.photos.length) CR.put(body, h('p', { class: 'hint' }, '사진이 음악 길이에 비해 너무 많아서 ' + st.photos.length + '장 중 ' + A.used + '장을 고르게 골라 써요. ‘영상 길이’를 ‘사진 수에 맞춰’로 바꾸면 모두 써요.'));
    }
    if (st.error) CR.put(body, h('div', { class: 'errbox' }, st.error));

    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, '다 만든 뒤에도 사진 순서 · 길이 · 효과를 마음대로 고칠 수 있어요'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => close() }, '취소'),
        h('button', { class: 'btn primary', disabled: !A || st.busy, onclick: make }, I('sparkle'), prev ? '다시 만들기' : '영상 만들기'))));
  };

  const make = () => {
    if (!st.photos.length || !st.ana) return;
    st.busy = true;
    const res = CR.buildAuto(Object.assign({}, st, { seed: Math.floor(Math.random() * 1e9) }));
    const np = CR.normalize(res.P);
    const info = { n: res.A.used, music: st.music.name, bpm: st.ana.bpm, total: res.A.end, trans: res.trans.filter((x) => x > 0).length, note: res.A.note, end: res.A.end,
      flow: res.A.sections.map((x) => CR.SECTION_NAMES[x.type]).filter((x, i, a) => x !== a[i - 1]).join(' → ') };
    close();
    if (prev && CR.P) {
      CR.edit('사진 영상 다시 만들기', () => {
        const id = CR.P.id;
        Object.keys(CR.P).forEach((k) => { delete CR.P[k]; });
        Object.assign(CR.P, np, { id });
      });
    } else {
      CR.save.now();
      CR.P = np;
      CR.hist = { undo: [], redo: [] };
      CR.S.sel = null; CR.S.t = 0; CR.S.zoomFit = true;
      CR.go('editor');
      CR.saveNow();
    }
    CR.S.autoInfo = info;
    CR.S.zoomFit = true;
    CR.P.media.forEach((m) => CR.loadAssets(m));
    CR.render('all');
  };

  draw();
  close = CR.modal(dlg);
  if (prev) {
    if (prev.folder) loadFolder(prev.folder);
    if (prev.music) loadMusic(prev.music);
  }
};
