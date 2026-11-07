// CUTROAD — 용량 줄이기 (영상 컴프레서) · 내보내기 용량 계획 · 소리 고르게(오디오 컴프레서) 값
// made by. Nevertheless_D
//
// 용량 계획(CR.sizePlan)은 여기서만 계산하고, 맥(Compress.swift · Export.swift)과 Windows(compress.go · render.go)는
// 받은 크기 · 비트레이트대로 만들기만 해요. 그래서 예상 크기와 실제 결과가 두 곳에서 같아요.
'use strict';

CR.SIZE = {
  kakaoMB: 280, // 카톡 동영상 한도(300MB)보다 조금 작게
  steps: [2160, 1440, 1080, 720, 540, 480, 360],
};

/** 압축 모드: 용량 줄이기 창은 앞의 셋, 내보내기는 ‘보통’ 포함 넷 */
CR.SIZE_MODES = [
  { id: 'kakao', title: '카톡 보내기용', desc: '카톡으로 보낼 수 있는 크기(300MB 안)로 · 1080p 까지' },
  { id: 'size', title: '크기 직접 정하기', desc: '정한 크기(MB) 안에 들어오게 · 필요하면 해상도도 낮춰요' },
  { id: 'light', title: '화질 위주로 조금만', desc: '해상도 그대로, 눈으로는 거의 차이 없게' },
];

/**
 * 용량 계획. o = { mode: 'normal'|'kakao'|'size'|'light', dur, W, H (나올 영상 크기, 방향 반영), fps, srcBytes(원본 파일 크기, 있으면), targetMB, hevc }
 * → { W, H, vbps, abps, est(예상 바이트), target(목표 바이트, 없으면 0), skip('' 또는 건너뛰는 이유) }
 */
CR.sizePlan = function (o) {
  const dur = Math.max(0.5, o.dur || 1);
  const fps = CR.clamp(o.fps || 30, 10, 60);
  const k = o.hevc ? 0.6 : 1; // HEVC 는 같은 화질에 약 60% 크기
  const ev = (v) => Math.max(2, Math.round(v / 2) * 2);
  const W0 = o.W || 1920, H0 = o.H || 1080, s0 = Math.min(W0, H0);
  const at = (short) => (short >= s0 ? [W0, H0] : [ev(W0 * short / s0), ev(H0 * short / s0)]);
  const px = (w, h) => w * h * fps;
  let W = W0, H = H0, vbps, abps = 192e3, target = 0, skip = '';
  if (o.mode === 'kakao' || o.mode === 'size') {
    target = (o.mode === 'kakao' ? CR.SIZE.kakaoMB : Math.max(1, o.targetMB || 50)) * 1e6;
    const short0 = o.mode === 'kakao' ? Math.min(s0, 1080) : s0;
    abps = 128e3;
    let budget = target * 8 * 0.94 / dur - abps;
    if (budget < 400e3) { abps = 96e3; budget = target * 8 * 0.94 / dur - abps; }
    if (budget < 150e3) { abps = 64e3; budget = target * 8 * 0.94 / dur - abps; }
    const cap = o.mode === 'kakao' ? 0.07 : 0.1;
    const steps = [short0].concat(CR.SIZE.steps.filter((s) => s < short0));
    for (const sh of steps) {
      [W, H] = at(sh);
      vbps = Math.min(budget, px(W, H) * cap * k);
      if (vbps >= px(W, H) * 0.035 * k || sh <= 360) break;
    }
    vbps = Math.max(100e3, vbps);
    if (o.srcBytes && o.srcBytes <= target * 0.97 && s0 <= short0) skip = '이미 목표 크기보다 작아요';
  } else if (o.mode === 'light') {
    abps = 160e3;
    const cap = px(W, H) * 0.1 * k;
    vbps = o.srcBytes ? Math.min(Math.max(0, o.srcBytes * 8 / dur - 192e3) * (o.hevc ? 0.45 : 0.6), cap) : cap;
    vbps = Math.max(300e3, vbps);
  } else {
    vbps = Math.min(60e6, Math.max(2e6, px(W, H) * 0.2)); // 보통 = 예전과 같은 값 (Export.swift · render.go)
  }
  vbps = Math.round(vbps);
  const est = (vbps + abps) * dur / 8 * 1.02;
  if (!skip && o.srcBytes && est >= o.srcBytes * 0.92) skip = '이미 충분히 작아요';
  return { W, H, vbps, abps, est, target, skip };
};

// ---------------------------------------------------------------- 소리 고르게 (오디오 컴프레서)
// 미리보기(Web Audio) · 맥(Export.swift Dynamics) · Windows(ffmpeg acompressor) 가 같은 값을 써요
CR.AUDIO_COMP = {
  light: { threshold: -18, ratio: 2, attack: 0.02, release: 0.25, makeup: 3 },
  normal: { threshold: -24, ratio: 3, attack: 0.01, release: 0.2, makeup: 6 },
  strong: { threshold: -30, ratio: 5, attack: 0.005, release: 0.15, makeup: 9 },
};
CR.AUDIO_COMP_NAMES = [['', '끔'], ['light', '약하게'], ['normal', '보통'], ['strong', '강하게']];

// ---------------------------------------------------------------- 용량 줄이기 창

CR.openCompress = function (paths) {
  const st = { files: [], mode: (CR.S.settings.ui && CR.S.settings.ui.compressMode) || 'kakao', targetMB: 50, hevc: false, busy: false, cur: -1, job: '', stop: false, done: false };
  if (!CR.SIZE_MODES.find((m) => m.id === st.mode)) st.mode = 'kakao';
  let close;
  const dlg = h('div', { class: 'dlg', style: { width: '760px' } });

  const planFor = (f) => CR.sizePlan({ mode: st.mode, dur: f.duration, W: f.width, H: f.height, fps: f.fps, srcBytes: f.size, targetMB: st.targetMB, hevc: st.hevc });

  const add = async (list) => {
    list = (list || []).filter((p) => /\.(mov|mp4)$/i.test(p) && !st.files.find((f) => f.path === p));
    if (!list.length) return;
    let items = [];
    try { items = (await CR.native('probe', { paths: list })).items || []; } catch (e) { CR.toast(e.message, { bad: true }); return; }
    items.forEach((it) => {
      if (it.error || it.kind !== 'video') { CR.toast((it.name || '파일') + ': ' + (it.error || '영상 파일이 아니에요'), { bad: true }); return; }
      st.files.push({ path: it.path, name: it.name, duration: it.duration || 0, width: it.width || 1920, height: it.height || 1080, fps: it.fps || 30, size: it.size || 0, state: 'wait' });
    });
    st.done = false;
    draw();
  };
  const pick = async () => {
    try { const r = await CR.native('open', { kind: 'movie' }); if (r && r.paths) add(r.paths); } catch (e) { CR.toast(e.message, { bad: true }); }
  };

  const row = (f, i) => {
    const P = planFor(f);
    let right;
    if (f.state === 'done') right = h('span', { class: 'cz ok' }, CR.icon('check'), CR.bytes(f.size) + ' → ' + CR.bytes(f.result.size) + ' (' + Math.max(0, Math.round((1 - f.result.size / f.size) * 100)) + '% 줄었어요)');
    else if (f.state === 'skip') right = h('span', { class: 'cz dim' }, f.note);
    else if (f.state === 'error') right = h('span', { class: 'cz bad' }, f.note);
    else if (f.state === 'run') { f.barEl = h('div'); f.msgEl = h('span', null, '준비 중…'); right = h('div', { class: 'czprog' }, f.msgEl, h('div', { class: 'bar' }, f.barEl)); }
    else right = h('span', { class: 'cz' }, P.skip ? h('span', { class: 'dim' }, CR.bytes(f.size) + ' · ' + P.skip) : [CR.bytes(f.size) + ' → ', h('b', null, '약 ' + CR.bytes(P.est)),
      P.W !== f.width ? h('small', null, ' · ' + Math.min(P.W, P.H) + 'p') : null]);
    return h('div', { class: 'czrow' + (f.state === 'run' ? ' on' : '') },
      h('div', { class: 'cn' }, h('b', null, f.name), h('small', null, CR.human(f.duration) + ' · ' + f.width + '×' + f.height)),
      right,
      st.busy || st.done ? null : h('button', { class: 'close', 'aria-label': '빼기', title: '목록에서 빼기', onclick: () => { st.files.splice(i, 1); draw(); } }, CR.icon('x')));
  };

  const draw = () => {
    dlg.innerHTML = '';
    dlg.appendChild(dlgHead('용량 줄이기', '영상 파일을 작게 만들어요. 원본은 그대로 두고 옆에 ‘(작게)’ 파일로 저장해요', () => close(),
      h('div', { class: 'hic', style: { background: 'color-mix(in srgb, var(--accent) 14%, transparent)', color: 'var(--accent)' } }, CR.icon('shrink'))));
    const body = h('div', { class: 'db' });
    dlg.appendChild(body);
    const lock = st.busy;
    body.appendChild(h('div', { class: 'presets three' }, CR.SIZE_MODES.map((m) =>
      h('button', { class: 'preset' + (st.mode === m.id ? ' on' : ''), disabled: lock, onclick: () => { st.mode = m.id; st.done = false; resetStates(); draw(); } },
        h('span', { class: 't' }, h('b', null, m.title)), h('small', null, m.desc)))));
    const opts = h('div', { class: 'czopts' });
    if (st.mode === 'size') {
      const inp = h('input', { type: 'text', value: String(st.targetMB), 'aria-label': '목표 크기', disabled: lock });
      inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (isFinite(v) && v > 0) { st.targetMB = Math.round(v); resetStates(); } draw(); });
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
      opts.appendChild(h('label', { class: 'num' }, '파일 하나당', h('span', { style: { display: 'flex', gap: '3px', alignItems: 'center' } }, inp, h('em', null, 'MB 이하'))));
      [25, 50, 100].forEach((v) => opts.appendChild(h('button', { class: 'btn' + (st.targetMB === v ? ' on' : ''), disabled: lock, style: { height: '28px' }, onclick: () => { st.targetMB = v; resetStates(); draw(); } }, v + 'MB')));
    }
    if (!CR.WIN) {
      const cb = h('input', { type: 'checkbox', checked: st.hevc, disabled: lock });
      cb.addEventListener('change', () => { st.hevc = cb.checked; resetStates(); draw(); });
      opts.appendChild(h('label', { class: 'check', title: '같은 화질로 더 작게 만들어요. 아주 오래된 기기나 일부 사이트에서는 안 열릴 수 있어요' }, cb, '더 작게 (HEVC)'));
    }
    if (opts.childNodes.length) body.appendChild(opts);

    const list = h('div', { class: 'czlist' });
    if (!st.files.length) list.appendChild(h('div', { class: 'czempty' }, CR.icon('film'), h('b', null, '줄일 영상을 여기에 끌어다 놓거나'), h('button', { class: 'btn primary', onclick: pick }, '영상 고르기…'), h('small', null, 'MOV · MP4 · 여러 개를 한 번에 골라도 돼요')));
    st.files.forEach((f, i) => list.appendChild(row(f, i)));
    body.appendChild(list);
    if (st.files.length && !lock && !st.done) body.appendChild(h('div', null, h('button', { class: 'btn', style: { height: '28px' }, onclick: pick }, CR.icon('plus'), '영상 더 넣기')));
    if (st.error) body.appendChild(h('div', { class: 'errbox' }, st.error));

    let note = '';
    if (st.done) {
      const ok = st.files.filter((f) => f.state === 'done');
      const a = ok.reduce((s, f) => s + f.size, 0), b = ok.reduce((s, f) => s + f.result.size, 0);
      note = ok.length ? ok.length + '개 · 모두 ' + CR.bytes(a) + ' → ' + CR.bytes(b) + (a ? ' (' + Math.round((1 - b / a) * 100) + '% 줄었어요)' : '') : '줄인 파일이 없어요';
    } else if (st.files.length) {
      const todo = st.files.filter((f) => !planFor(f).skip);
      const a = todo.reduce((s, f) => s + f.size, 0), b = todo.reduce((s, f) => s + planFor(f).est, 0);
      note = todo.length ? todo.length + '개 · 모두 ' + CR.bytes(a) + ' → 약 ' + CR.bytes(b) : '줄일 파일이 없어요';
    }
    const firstDone = st.files.find((f) => f.state === 'done');
    dlg.appendChild(h('div', { class: 'df' }, h('span', { class: 'note' }, note),
      h('div', { class: 'actions' },
        lock ? h('button', { class: 'btn', onclick: () => { st.stop = true; if (st.job) CR.native('cancelJob', { id: st.job }); } }, '멈추기')
          : h('button', { class: 'btn', onclick: () => close() }, '닫기'),
        st.done && firstDone ? h('button', { class: 'btn', onclick: () => CR.native('reveal', { path: firstDone.result.path }) }, I('folder'), CR.T('Finder에서 보기')) : null,
        st.done ? h('button', { class: 'btn primary', onclick: () => { st.files = []; st.done = false; draw(); } }, '새로 줄이기')
          : lock ? null : h('button', { class: 'btn primary', disabled: !st.files.some((f) => !planFor(f).skip), onclick: run }, CR.icon('shrink'), '줄이기'))));
  };
  const resetStates = () => st.files.forEach((f) => { if (f.state !== 'run') { f.state = 'wait'; f.note = ''; f.result = null; } });

  const once = async (f, P, replace) => {
    const r = await CR.native('compress', { path: f.path, dir: CR.dirName(f.path), name: f.name.replace(/\.[^.]+$/, '') + ' (작게)', replace: replace || '',
      width: P.W, height: P.H, vbps: P.vbps, abps: P.abps, codec: st.hevc ? 'hevc' : 'h264' });
    st.job = r.id;
    return CR.watchJob(r.id, (p) => {
      if (f.barEl) f.barEl.style.width = Math.round(p.progress * 100) + '%';
      if (f.msgEl) f.msgEl.textContent = (replace ? '목표에 맞춰 한 번 더 · ' : '') + Math.round(p.progress * 100) + '%';
    });
  };
  const run = async () => {
    st.busy = true; st.stop = false; st.error = '';
    CR.api('/api/settings', { ui: Object.assign({}, CR.S.settings.ui || {}, { compressMode: st.mode }) }).then((s) => { CR.S.settings = s; }).catch(() => {});
    for (let i = 0; i < st.files.length && !st.stop; i++) {
      const f = st.files[i];
      if (f.state === 'done') continue;
      const P = planFor(f);
      if (P.skip) { f.state = 'skip'; f.note = P.skip + ' · 그대로 두었어요'; draw(); continue; }
      f.state = 'run'; st.cur = i; draw();
      try {
        let s = await once(f, P);
        // 목표 크기를 넘었으면 비트레이트를 낮춰 한 번 더 (같은 파일에 덮어써요)
        if (s.state === 'done' && P.target && s.result.size > P.target && !st.stop) {
          const k = P.target / s.result.size * 0.93;
          const P2 = Object.assign({}, P, { vbps: Math.max(80e3, Math.round(P.vbps * k)) });
          const s2 = await once(f, P2, s.result.path);
          if (s2.state === 'done') s = s2;
        }
        if (s.state === 'done') { f.state = 'done'; f.result = s.result; }
        else { f.state = 'error'; f.note = s.state === 'cancelled' ? '멈췄어요' : (s.error || '줄이지 못했어요'); }
      } catch (e) { f.state = 'error'; f.note = e.message; }
      draw();
    }
    st.busy = false; st.job = ''; st.cur = -1;
    st.done = st.files.some((f) => f.state === 'done' || f.state === 'error' || f.state === 'skip') && !st.files.some((f) => f.state === 'wait' || f.state === 'run');
    if (st.stop) st.files.forEach((f) => { if (f.state === 'run') { f.state = 'error'; f.note = '멈췄어요'; } });
    draw();
  };

  CR.onModalDrop = (list) => { if (!st.busy && !st.done) add(list); };
  draw();
  close = CR.modal(dlg, { canClose: () => !st.busy, onClose: () => { CR.onModalDrop = null; } });
  if (paths && paths.length) add(paths);
};
