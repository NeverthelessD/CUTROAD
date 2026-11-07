// CUTROAD — 화면 구성: 처음 화면 · 위쪽 도구 · 미디어 · 미리보기 · 속성(오른쪽) · 아래 상태 줄
// made by. Nevertheless_D
'use strict';

CR.V = {}; // 지금 화면의 칸들

CR.go = function (view) {
  CR.Player.pause();
  CR.S.view = view;
  const app = document.getElementById('app');
  app.innerHTML = '';
  CR.V = {};
  CR.TL = { el: null, scroll: null, inner: null, ph: null };
  CR.Q.ph = null;
  if (view === 'home') {
    CR.Player.reset();
    CR.setTitle('');
    const v = h('div', { class: 'view' });
    app.appendChild(v);
    CR.V.home = v;
    CR.renderHome();
    return;
  }
  const quick = CR.quick();
  const v = h('div', { class: 'view' + (quick ? ' quick' : '') });
  CR.V.toolbar = h('div', { class: 'toolbar' });
  CR.V.preview = CR.buildPreview();
  CR.V.status = h('div', { class: 'statusbar' });
  if (quick) {
    CR.V.qbottom = h('div', { class: 'qbottom' });
    CR.put(v, CR.V.toolbar, CR.V.preview, CR.V.qbottom, CR.V.status);
  } else {
    CR.V.media = h('div', { class: 'media' });
    CR.V.inspector = h('div', { class: 'inspector' });
    CR.V.tl = h('div', { class: 'tl' });
    CR.V.banner = h('div');
    CR.put(v, CR.V.toolbar, h('div', { class: 'middle' }, CR.V.media, CR.V.preview, CR.V.inspector), CR.V.banner, CR.V.tl, CR.V.status);
  }
  app.appendChild(v);
  CR.render('all');
};

CR.setTitle = function (name) {
  if (CR.hasNative) CR.native('title', { title: name }).catch(() => {});
  document.title = name ? name + ' — CUTROAD' : 'CUTROAD';
};

CR.render = function (part) {
  if (CR.S.view === 'home') return;
  if (!CR.P) return;
  part = part || 'all';
  const quick = CR.quick();
  if (part === 'all') {
    CR.renderToolbar();
    CR.sizeStage();
    CR.setTitle(CR.P.name);
  }
  if (!quick && (part === 'all' || part === 'media' || part === 'select')) CR.renderMedia();
  if (!quick && (part === 'all' || part === 'select')) CR.renderInspector();
  if (!quick && part === 'all') CR.renderBanner();
  if (quick && (part === 'all' || part === 'select' || part === 'timeline' || part === 'media')) CR.renderQuick();
  if (!quick && (part === 'all' || part === 'select' || part === 'timeline' || part === 'media')) CR.renderTimeline(CR.V.tl);
  CR.status();
  CR.Player.apply();
  CR.onTime();
};

CR.onTime = function () {
  if (CR.V.tc) {
    const L = CR.layout();
    CR.V.tc.textContent = '';
    CR.V.tc.append(CR.tc(CR.S.t), ' ', h('span', null, '/ ' + CR.tc(CR.total())));
    if (L.quick && L.kept !== L.total) CR.V.tc.appendChild(h('span', null, ' → 남는 길이 ' + CR.short(L.kept)));
  }
  CR.onTimeTimeline();
};

CR.onPlayState = function () {
  if (CR.V.playBtn) {
    CR.V.playBtn.innerHTML = '';
    CR.V.playBtn.appendChild(I(CR.Player.playing ? 'pause' : 'play'));
    CR.V.playBtn.setAttribute('aria-label', CR.Player.playing ? '멈춤' : '재생');
  }
};

// ---------------------------------------------------------------- 위쪽 도구

CR.modeSwitch = function () {
  const q = CR.quick();
  return h('div', { class: 'seg', role: 'group', 'aria-label': '편집 방식' },
    h('button', { class: q ? '' : 'on', onclick: () => CR.setMode('full') }, '전체 편집'),
    h('button', { class: q ? 'on' : '', onclick: () => CR.setMode('quick') }, I('scissors'), '컷 편집만'));
};

CR.setMode = function (mode) {
  if (!CR.P || CR.P.mode === mode) return;
  CR.P.mode = mode;
  CR.S.sel = null;
  CR.S.silences = null;
  CR.S.t = CR.clamp(CR.S.t, 0, CR.total());
  CR.save();
  CR.go('editor');
  if (mode === 'quick') {
    const fx = CR.P.audio.length || CR.P.texts.length || CR.kept().some((c) => c.speed !== 1 || c.blur || c.rotate || c.fadeIn || c.fadeOut || c.trans);
    if (fx) CR.toast('컷 편집만에서는 효과 · 글자 · 배경음악 없이 컷만 보여요 (전체 편집으로 돌아가면 그대로 있어요)', { ms: 5000 });
  }
};

CR.renderToolbar = function () {
  const tb = CR.V.toolbar;
  tb.innerHTML = '';
  const logo = h('button', { class: 'logo', title: CR.T('처음 화면으로 (⌘O)'), style: { border: 'none', background: 'transparent', padding: '0 6px 0 0' }, onclick: () => CR.goHome() },
    CR.logoSVG(), CR.word());
  if (CR.quick()) {
    CR.put(tb, logo, CR.modeSwitch(), h('div', { class: 'grow' }),
      h('span', { style: { fontSize: '12px', color: 'var(--sub)' } }, '원래 화질 그대로 MP4로 저장돼요'),
      h('button', { class: 'btn icon ghost', title: '설정', 'aria-label': '설정', onclick: () => CR.openSettings() }, I('gear')),
      h('button', { class: 'btn primary', style: { height: '34px', padding: '0 16px' }, onclick: () => CR.openExport('quick') }, I('export'), '저장하기'));
    return;
  }
  CR.put(tb, logo, CR.modeSwitch(), h('div', { class: 'vsep' }),
    h('button', { class: 'btn', onclick: () => CR.pickImport() }, I('plus'), '가져오기'),
    h('button', { class: 'btn', onclick: () => { CR.edit('제목 넣기', () => { const x = CR.addText('title', CR.S.t); CR.S.sel = { type: 'text', id: x.id }; }); } }, I('text'), '텍스트'),
    h('button', { class: 'btn', onclick: () => CR.openCaptions() }, I('mic'), '자동 자막'),
    h('button', { class: 'btn', onclick: () => CR.pickImport('audio') }, I('music'), '배경음악'),
    h('div', { class: 'vsep' }),
    h('button', { class: 'btn icon ghost', title: CR.T('실행 취소 (⌘Z)'), 'aria-label': '실행 취소', disabled: !CR.hist.undo.length, onclick: () => CR.undo() }, I('undo')),
    h('button', { class: 'btn icon ghost', title: CR.T('다시 실행 (⇧⌘Z)'), 'aria-label': '다시 실행', disabled: !CR.hist.redo.length, onclick: () => CR.redo() }, I('redo')),
    h('div', { class: 'grow' }),
    h('span', { class: 'chip wide-only' }, CR.resLabel()),
    h('button', { class: 'btn icon ghost', title: '설정', 'aria-label': '설정', onclick: () => CR.openSettings() }, I('gear')),
    h('button', { class: 'btn primary', style: { height: '34px', padding: '0 16px' }, onclick: () => CR.openExport() }, I('export'), '내보내기'));
};

CR.resLabel = function () {
  const first = CR.kept()[0];
  const m = first && CR.media(first.mediaId);
  const fps = m && m.fps ? Math.round(m.fps) : 30;
  const res = { '16:9': '1080p', '9:16': '1080×1920', '1:1': '1080×1080' }[CR.P.aspect] || '1080p';
  return res + ' · ' + fps + 'fps · ' + CR.P.aspect;
};

CR.goHome = function () {
  CR.save.now();
  CR.P = null;
  CR.go('home');
};

CR.pickImport = async function (kind) {
  try {
    const r = await CR.native('open', { kind: kind || '' });
    if (r && r.paths && r.paths.length) CR.importPaths(r.paths);
  } catch (e) { CR.toast(e.message, { bad: true }); }
};

// ---------------------------------------------------------------- 미리보기

CR.buildPreview = function () {
  const txt = h('div', { class: 'txtlayer' });
  const empty = h('div', { class: 'empty' }, CR.icon('film'), h('div', null, '영상 파일을 이 창에 끌어다 놓으세요'), h('div', { style: { fontSize: '12px', opacity: .8 } }, 'MOV · MP4 · MP3 · WAV · M4A'));
  const stage = h('div', { class: 'stage' }, txt, h('div', { class: 'missing' }), empty);
  stage.querySelector('svg').style.cssText = 'width:30px;height:30px';
  stage.addEventListener('click', () => CR.Player.toggle());
  const wrap = h('div', { class: 'stageWrap' }, stage);
  CR.V.stage = stage; CR.V.stageWrap = wrap; CR.V.empty = empty;
  CR.V.tc = h('span', { class: 'tc' });
  CR.V.playBtn = h('button', { class: 'play', 'aria-label': '재생', onclick: () => CR.Player.toggle() }, I('play'));
  const tr = h('div', { class: 'transport' }, CR.V.tc,
    h('div', { class: 'ctl' },
      h('button', { 'aria-label': '처음으로', title: '처음으로 (Home)', onclick: () => CR.Player.seek(0) }, I('back')),
      h('button', { 'aria-label': '1초 뒤로', title: '1초 뒤로 (⇧←)', onclick: () => CR.Player.seek(CR.S.t - 1) }, h('span', { class: 'mono', style: { fontSize: '11px' } }, '-1s')),
      CR.V.playBtn,
      h('button', { 'aria-label': '1초 앞으로', title: '1초 앞으로 (⇧→)', onclick: () => CR.Player.seek(CR.S.t + 1) }, h('span', { class: 'mono', style: { fontSize: '11px' } }, '+1s')),
      h('button', { 'aria-label': '끝으로', title: '끝으로 (End)', onclick: () => CR.Player.seek(CR.total()) }, I('fwd'))),
    CR.V.resChip = h('div', { class: 'right' }));
  const area = h('div', { class: 'previewArea' }, wrap, tr);
  CR.Player.mount(stage, txt);
  const ro = new ResizeObserver(() => CR.sizeStage());
  ro.observe(wrap);
  return area;
};

CR.stageAspect = function () {
  if (!CR.P) return 16 / 9;
  if (CR.quick()) {
    const c = CR.P.clips[0];
    const m = c && CR.media(c.mediaId);
    if (m && m.width && m.height) return m.width / m.height;
    return 16 / 9;
  }
  return { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }[CR.P.aspect] || 16 / 9;
};

CR.sizeStage = function () {
  const wrap = CR.V.stageWrap, stage = CR.V.stage;
  if (!wrap || !stage) return;
  const ar = CR.stageAspect();
  const aw = wrap.clientWidth - 36, ah = wrap.clientHeight - 14;
  if (aw <= 0 || ah <= 0) return;
  let W = aw, H = aw / ar;
  if (H > ah) { H = ah; W = ah * ar; }
  W = Math.floor(W); H = Math.floor(H);
  stage.style.width = W + 'px';
  stage.style.height = H + 'px';
  if (CR.V.empty) CR.V.empty.style.display = CR.P && CR.P.clips.length ? 'none' : 'flex';
  if (CR.V.resChip) {
    CR.V.resChip.innerHTML = '';
    if (!CR.quick()) CR.V.resChip.appendChild(h('span', { class: 'chip', style: { background: 'transparent', border: '1px solid var(--line)' } },
      (CR.P.fit === 'fill' ? '꽉 채우기' : '화면 맞춤') + ' · ' + CR.P.aspect));
  }
  CR.Player.setSize(W, H);
};

// ---------------------------------------------------------------- 미디어 (왼쪽)

CR.S.mtab = 'video';
/** 사진으로 영상을 만든 직후 보여 주는 안내 줄 */
CR.renderBanner = function () {
  const b = CR.V.banner;
  if (!b) return;
  b.innerHTML = '';
  const info = CR.S.autoInfo;
  if (!info || !CR.P || !CR.P.auto) return;
  const note = { short: ' · 사진이 적어서 음악을 ' + CR.short(info.end) + '에서 줄였어요', many: ' · 사진이 많아서 아주 빠르게 넘어가요', fit: ' · 사진이 많아서 음악 전체에 맞췄어요' }[info.note] || '';
  CR.put(b, h('div', { class: 'autobanner' }, I('check'),
    h('b', null, '사진 ' + info.n + '장을 ‘' + info.music + '’ 흐름에 맞춰 편집했어요'),
    info.flow ? h('span', { class: 'sub' }, '· ' + info.flow) : null,
    h('span', { class: 'sub' }, '· ' + CR.short(info.total) + ' · ' + (info.bpm ? Math.round(info.bpm) + ' BPM · ' : '') + '넘기기 ' + info.trans + '곳' + note),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn', style: { height: '30px' }, onclick: () => CR.reshuffle() }, I('refresh'), '효과 다시 섞기'),
    h('button', { class: 'btn', style: { height: '30px' }, onclick: () => CR.openAutoMake(CR.P.auto) }, I('gear'), '설정 바꿔서 다시 만들기'),
    h('button', { class: 'btn icon ghost', style: { height: '30px', width: '30px' }, 'aria-label': '안내 닫기', onclick: () => { CR.S.autoInfo = null; CR.renderBanner(); } }, I('x'))));
};

CR.renderMedia = function () {
  const box = CR.V.media;
  if (!box) return;
  const keep = box.querySelector('.list');
  const top = keep ? keep.scrollTop : 0;
  box.innerHTML = '';
  const P = CR.P;
  const vids = P.media.filter((m) => m.kind === 'video' || m.kind === 'image'), auds = P.media.filter((m) => m.kind === 'audio');
  const tab = CR.S.mtab;
  CR.put(box, h('div', { class: 'head' }, h('b', null, '미디어'), h('span', { style: { fontSize: '12px', color: 'var(--dim)' } }, P.media.length + '개')),
    h('div', { class: 'tabs' },
      [['video', '영상 · 사진'], ['audio', '오디오'], ['text', '텍스트']].map(([k, label]) =>
        h('button', { class: tab === k ? 'on' : '', onclick: () => { CR.S.mtab = k; CR.renderMedia(); } }, label))));
  const list = h('div', { class: 'list' });
  box.appendChild(list);
  if (tab === 'text') {
    CR.put(list, h('div', { class: 'actions', style: { marginBottom: '10px' } },
      h('button', { class: 'btn', style: { flex: 1 }, onclick: () => CR.edit('제목 넣기', () => { const x = CR.addText('title', CR.S.t); CR.S.sel = { type: 'text', id: x.id }; }) }, I('text'), '제목'),
      h('button', { class: 'btn', style: { flex: 1 }, onclick: () => CR.edit('자막 넣기', () => { const x = CR.addText('caption', CR.S.t); CR.S.sel = { type: 'text', id: x.id }; }) }, I('plus'), '자막')),
    h('button', { class: 'btn', style: { width: '100%', marginBottom: '12px' }, onclick: () => CR.openCaptions() }, I('mic'), '자동 자막 만들기'));
    const items = P.texts.slice().sort((a, b) => a.start - b.start);
    if (!items.length) list.appendChild(h('div', { class: 'empty' }, '아직 글자가 없어요. 재생 위치에 제목이나 자막을 넣을 수 있어요.'));
    list.appendChild(h('div', { class: 'tlist' }, items.map((x) => h('div', {
      class: 'titem' + (CR.S.sel && CR.S.sel.id === x.id ? ' sel' : ''),
      onclick: () => { CR.select('text', x.id); CR.Player.seek(x.start + 0.01); } },
      x.text, h('small', null, (x.kind === 'title' ? '제목 · ' : '자막 · ') + CR.shortD(x.start) + ' → ' + CR.shortD(x.end))))));
  } else {
    const items = tab === 'video' ? vids : auds;
    if (!items.length) list.appendChild(h('div', { class: 'empty' }, tab === 'video' ? '가져온 영상이 여기에 보여요.' : '가져온 소리 파일(MP3 · WAV · M4A)이 여기에 보여요.'));
    const grid = h('div', { class: 'grid' });
    items.forEach((m) => {
      const th = CR.cache.thumbs[m.path];
      const img = th && th.frames && th.frames[0];
      const used = P.clips.some((c) => c.mediaId === m.id && !c.removed) || P.audio.some((a) => a.mediaId === m.id);
      const it = h('div', { class: 'mitem' + (m.kind === 'audio' ? ' audio' : '') + (m.missing ? ' missing' : ''), title: m.path + (m.missing ? '\n(파일을 찾을 수 없어요)' : '') },
        h('div', { class: 'th', style: img ? { backgroundImage: 'url(' + img + ')' } : {} },
          m.kind === 'audio' ? I('wave') : null,
          h('span', { class: 'dur' }, m.kind === 'image' ? '사진' : CR.short(m.duration)),
          h('button', { class: 'add', title: '타임라인에 넣기', 'aria-label': '타임라인에 넣기', onclick: (e) => {
            e.stopPropagation();
            if (m.missing) return CR.toast('파일을 찾을 수 없어요: ' + m.name, { bad: true });
            CR.edit('타임라인에 넣기', () => {
              if (m.kind !== 'audio') { const c = CR.appendClip(m); CR.S.sel = { type: 'clip', id: c.id }; }
              else { const a = CR.addBGM(m, CR.S.t); CR.S.sel = { type: 'audio', id: a.id }; }
            });
          } }, I('plus'))),
        h('span', { class: 'nm' }, (used ? '' : '· ') + m.name));
      it.addEventListener('dblclick', () => it.querySelector('.add').click());
      it.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        CR.menu(e.clientX, e.clientY, [
          { label: '타임라인에 넣기', icon: 'plus', run: () => it.querySelector('.add').click() },
          { label: CR.T('Finder에서 보기'), icon: 'folder', run: () => CR.native('reveal', { path: m.path }) },
          { label: '목록에서 빼기', icon: 'trash', danger: true, run: () => {
            if (used) return CR.toast('타임라인에서 쓰고 있어서 뺄 수 없어요');
            CR.edit('미디어 빼기', () => { CR.P.media = CR.P.media.filter((x) => x.id !== m.id); });
          } },
        ]);
      });
      grid.appendChild(it);
    });
    list.appendChild(grid);
  }
  box.appendChild(h('div', { class: 'drop' }, '파일을 여기로 끌어다 놓기'));
  list.scrollTop = top;
};

// ---------------------------------------------------------------- 속성 (오른쪽)

function field(label, value, ...ctl) {
  return h('div', { class: 'field' }, h('div', { class: 'lab' }, h('span', null, label), value !== null && value !== undefined ? h('span', { class: 'v' }, value) : null), ...ctl);
}

/** 끌면서 바로 보이고, 놓으면 되돌리기 한 번으로 남는 막대 */
function slider(opt) {
  const r = h('input', { type: 'range', min: opt.min, max: opt.max, step: opt.step || 1, 'aria-label': opt.label });
  r.value = opt.value;
  r.addEventListener('input', () => {
    if (!CR.live.before) CR.live.begin();
    opt.set(+r.value);
    if (opt.show) opt.show(+r.value);
    CR.renderTimeline && !CR.quick() && CR.renderTimeline(CR.V.tl);
    CR.Player.apply();
  });
  r.addEventListener('change', () => CR.live.end(opt.label));
  return r;
}

function numBox(label, value, unit, onset, opt) {
  opt = opt || {};
  const inp = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': label, value: String(value) });
  const commit = () => {
    const v = parseFloat(String(inp.value).replace(',', '.'));
    if (!isFinite(v)) { inp.value = String(value); return; }
    onset(CR.clamp(v, opt.min !== undefined ? opt.min : 0, opt.max !== undefined ? opt.max : 1e9));
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
  return h('label', { class: 'num' }, label, h('span', { style: { display: 'flex', alignItems: 'center', gap: '3px' } }, inp, unit ? h('em', null, unit) : null));
}

function segPick(options, value, onpick, cls) {
  return h('div', { class: 'seg wide' + (cls ? ' ' + cls : '') }, options.map(([v, label]) =>
    h('button', { class: v === value ? 'on' : '', onclick: () => onpick(v) }, label)));
}

CR.renderInspector = function () {
  const box = CR.V.inspector;
  if (!box) return;
  box.innerHTML = '';
  const sel = CR.S.sel;
  const obj = CR.findSel(sel);
  const type = obj ? sel.type : 'project';
  const names = { clip: '클립', trans: '트랜지션', text: '텍스트', audio: '배경음악', project: '프로젝트' };
  const tabs = h('div', { class: 'tabs' },
    type !== 'project' ? h('span', { class: 'on' }, names[type]) : null,
    h('span', { class: type === 'project' ? 'on' : '', onclick: () => CR.select(null) }, names.project));
  const body = h('div', { class: 'body' });
  CR.put(box, tabs, body);
  if (type === 'clip') CR.inspectClip(body, obj);
  else if (type === 'trans') CR.inspectTrans(body, obj);
  else if (type === 'text') CR.inspectText(body, obj);
  else if (type === 'audio') CR.inspectAudio(body, obj);
  else CR.inspectProject(body);
};

function fxGrid(list, value, onpick) {
  return h('div', { class: 'fxgrid' }, list.map(([k, label]) => h('button', { class: k === value ? 'on' : '', onclick: () => onpick(k) }, label)));
}

CR.inspectClip = function (body, c) {
  const m = CR.media(c.mediaId);
  const isImg = m && m.kind === 'image';
  const volV = h('span', { class: 'v' }, Math.round(c.volume * 100) + '%');
  const blurV = h('span', { class: 'v' }, String(c.blur));
  const TB = CR.timelineBeats();
  let beatSeg = null;
  if (isImg && TB.beats.length > 1) {
    const g = TB.beats.slice(1).map((b, i) => b - TB.beats[i]).sort((x, y) => x - y);
    const bl = g[g.length >> 1];
    const cur = Math.round(CR.dur(c) / bl);
    beatSeg = segPick([[2, '2박'], [4, '4박'], [8, '8박']], cur, (n) => CR.edit('보이는 시간', () => { c.out = CR.round(c.in + n * bl, 3); }));
  }
  const taken = isImg && m.taken ? new Date(m.taken) : null;
  CR.put(body,
    h('div', { class: 'ititle' }, h('b', null, m ? m.name : '?'),
      h('span', null, isImg ? (taken ? (taken.getMonth() + 1) + '월 ' + taken.getDate() + '일' : '사진') : CR.shortD(c.in) + ' – ' + CR.shortD(c.out))),
    isImg ? field('보이는 시간', null, h('div', { class: 'row' },
      numBox('길이', CR.round(CR.dur(c), 2), '초', (v) => CR.edit('보이는 시간', () => { c.out = CR.round(c.in + Math.max(0.2, v), 3); }), { min: 0.2, max: 600 }))) : null,
    beatSeg ? field('박자에 맞추기', null, beatSeg) : null,
    !isImg ? h('div', { class: 'field' }, h('div', { class: 'lab' }, h('span', null, '볼륨'), volV),
      slider({ label: '볼륨', min: 0, max: 100, value: Math.round(c.volume * 100), set: (v) => { c.volume = v / 100; }, show: (v) => { volV.textContent = v + '%'; } })) : null,
    field(isImg ? '페이드' : '페이드 (영상 + 소리)', null, h('div', { class: 'row' },
      numBox('인', c.fadeIn, '초', (v) => CR.edit('페이드 인', () => { c.fadeIn = CR.round(Math.min(v, CR.dur(c)), 2); }), { max: 10 }),
      numBox('아웃', c.fadeOut, '초', (v) => CR.edit('페이드 아웃', () => { c.fadeOut = CR.round(Math.min(v, CR.dur(c)), 2); }), { max: 10 }))),
    !isImg ? field('속도', null, segPick([[0.5, '0.5×'], [1, '1×'], [1.5, '1.5×'], [2, '2×']], c.speed, (v) => CR.edit('속도', () => { c.speed = v; }), 'mono')) : null,
    c.role ? h('p', { class: 'hint' }, (CR.SECTION_NAMES[c.role.sec] || '') + ' 구간' + (c.role.burst ? ' · 몰아치기 컷' : '') + '에 놓인 사진이에요') : null,
    field('움직임', null, fxGrid(CR.MOTIONS, c.motion, (v) => CR.edit('움직임', () => { c.motion = v; }))),
    c.motion !== 'none' ? field('움직임 크기', null, segPick([[0.7, '작게'], [1, '보통'], [1.3, '크게'], [1.6, '아주 크게']],
      [0.7, 1, 1.3, 1.6].reduce((b, v) => (Math.abs(v - (c.motionAmt || 1)) < Math.abs(b - (c.motionAmt || 1)) ? v : b), 1), (v) => CR.edit('움직임 크기', () => { c.motionAmt = v; }))) : null,
    field('색감', null, fxGrid(CR.FILTER_NAMES, c.filter, (v) => CR.edit('색감', () => { c.filter = v; }))),
    h('button', { class: 'btn ghost', style: { height: '28px', fontSize: '12px', alignSelf: 'flex-start' }, onclick: () => CR.edit('색감 모두', () => {
      CR.kept().forEach((x) => { x.filter = c.filter; });
    }) }, '이 색감을 모든 클립에'),
    h('div', { class: 'field' }, h('div', { class: 'lab' }, h('span', null, '블러'), blurV),
      slider({ label: '블러', min: 0, max: 40, value: c.blur, set: (v) => { c.blur = v; }, show: (v) => { blurV.textContent = String(v); } })),
    field('회전', c.rotate + '°', h('div', { class: 'row' },
      h('button', { class: 'btn', style: { flex: 1 }, onclick: () => CR.edit('회전', () => { c.rotate = (c.rotate + 270) % 360; }) }, I('rotL'), '왼쪽'),
      h('button', { class: 'btn', style: { flex: 1 }, onclick: () => CR.edit('회전', () => { c.rotate = (c.rotate + 90) % 360; }) }, I('rotR'), '오른쪽'))),
    h('div', { class: 'actions' },
      !isImg ? h('button', { class: 'btn', onclick: () => CR.split() }, I('scissors'), '재생 위치에서 자르기') : null,
      h('button', { class: 'btn danger', onclick: () => CR.deleteSel() }, I('trash'), isImg ? '빼기' : '지우기')),
    m && m.missing ? h('div', { class: 'errbox' }, '원본 파일을 찾을 수 없어요. 옮기거나 이름을 바꿨다면 원래 자리에 되돌려 주세요.') : null);
};

CR.inspectTrans = function (body, c) {
  const L = CR.layout();
  const i = L.list.indexOf(c);
  const next = L.list[i + 1];
  const nm = (x) => { const m = x && CR.media(x.mediaId); return m ? m.name.replace(/\.[^.]+$/, '') : '?'; };
  const cur = (c.trans && c.trans.type) || '';
  const durV = h('span', { class: 'v' }, ((c.trans && c.trans.dur) || 0.8).toFixed(1) + '초');
  const kinds = CR.TRANS.concat([['', '없음']]);
  CR.put(body, 
    h('div', { class: 'ititle' }, h('b', null, nm(c) + ' → ' + nm(next))),
    field('종류', null, fxGrid(kinds, cur, (k) => { CR.setTrans(c.id, k, c.trans && c.trans.dur); if (k) CR.select('trans', c.id); else CR.select('clip', c.id); })),
    cur && CR.P.auto ? h('button', { class: 'btn ghost', style: { height: '28px', fontSize: '12px', alignSelf: 'flex-start' }, onclick: () => CR.edit('넘기기 모두', () => {
      CR.kept().forEach((x) => { if (x.trans) x.trans.type = cur; });
    }) }, '모든 넘기기를 이걸로') : null,
    cur ? h('div', { class: 'field' }, h('div', { class: 'lab' }, h('span', null, '길이'), durV),
      slider({ label: '트랜지션 길이', min: 0.2, max: 2, step: 0.1, value: c.trans.dur, set: (v) => { c.trans.dur = v; }, show: (v) => { durV.textContent = v.toFixed(1) + '초'; } })) : null,
    h('p', { class: 'hint' }, '두 클립이 겹치면서 바뀌어요. 그만큼 전체 길이가 조금 짧아져요. 소리도 함께 자연스럽게 바뀌어요.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => CR.Player.seek(Math.max(0, L.starts[i + 1] - 1)) }, I('play'), '이 부분으로 가기')));
};

CR.inspectText = function (body, x) {
  const ta = h('textarea', { class: 'ta', 'aria-label': '글자 내용' });
  ta.value = x.text;
  ta.addEventListener('input', () => {
    if (!CR.live.before) CR.live.begin();
    x.text = ta.value;
    CR.renderTimeline(CR.V.tl);
    CR.Player.apply();
  });
  ta.addEventListener('change', () => CR.live.end('글자 고치기'));
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  CR.put(body, 
    field(x.kind === 'title' ? '제목' : '자막', null, ta),
    field('종류', null, segPick([['title', '제목'], ['caption', '자막']], x.kind, (v) => CR.edit('글자 종류', () => {
      x.kind = v;
      if (v === 'title') { x.pos = 'center'; x.size = 'l'; x.box = false; } else { x.pos = 'bottom'; x.size = 'm'; x.box = true; }
    }))),
    field('위치', null, segPick([['top', '위'], ['center', '가운데'], ['bottom', '아래']], x.pos, (v) => CR.edit('글자 위치', () => { x.pos = v; }))),
    field('크기', null, segPick([['s', '작게'], ['m', '보통'], ['l', '크게']], x.size, (v) => CR.edit('글자 크기', () => { x.size = v; }))),
    h('label', { class: 'check' }, (() => { const cb = h('input', { type: 'checkbox', checked: x.box }); cb.addEventListener('change', () => CR.edit('글자 배경', () => { x.box = cb.checked; })); return cb; })(), '어두운 배경 상자'),
    field('나오는 시간', null, h('div', { class: 'row' },
      numBox('시작', CR.round(x.start, 2), '초', (v) => CR.edit('글자 시간', () => { x.start = CR.round(Math.min(v, x.end - 0.2), 2); })),
      numBox('끝', CR.round(x.end, 2), '초', (v) => CR.edit('글자 시간', () => { x.end = CR.round(Math.max(v, x.start + 0.2), 2); })))),
    h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: () => CR.deleteSel() }, I('trash'), '지우기')));
};

CR.inspectAudio = function (body, a) {
  const m = CR.media(a.mediaId);
  const volV = h('span', { class: 'v' }, Math.round(a.volume * 100) + '%');
  CR.put(body, 
    h('div', { class: 'ititle' }, h('b', null, m ? m.name : '?'), h('span', null, CR.short(a.out - a.in))),
    h('div', { class: 'field' }, h('div', { class: 'lab' }, h('span', null, '볼륨'), volV),
      slider({ label: '배경음악 볼륨', min: 0, max: 100, value: Math.round(a.volume * 100), set: (v) => { a.volume = v / 100; }, show: (v) => { volV.textContent = v + '%'; } })),
    field('페이드', null, h('div', { class: 'row' },
      numBox('인', a.fadeIn, '초', (v) => CR.edit('페이드 인', () => { a.fadeIn = CR.round(v, 2); }), { max: 20 }),
      numBox('아웃', a.fadeOut, '초', (v) => CR.edit('페이드 아웃', () => { a.fadeOut = CR.round(v, 2); }), { max: 20 }))),
    field('시작 위치', null, h('div', { class: 'row' },
      numBox('타임라인', CR.round(a.start, 2), '초', (v) => CR.edit('배경음악 위치', () => { const tot = CR.total(); a.start = CR.round(CR.clamp(v, 0, tot > 1 ? tot - 1 : Math.max(0, v)), 3); })),
      h('button', { class: 'btn', onclick: () => CR.edit('배경음악 위치', () => { a.start = CR.round(CR.S.t, 3); }) }, '재생 위치로'))),
    h('label', { class: 'check' }, (() => { const cb = h('input', { type: 'checkbox', checked: !!a.keep });
      cb.addEventListener('change', () => CR.edit(cb.checked ? '영상 끝나도 음악 계속' : '영상 끝나면 음악도 끝', () => { if (cb.checked) a.keep = true; else delete a.keep; })); return cb; })(),
      '영상이 끝나도 음악 계속 (뒤는 검은 화면)'),
    h('p', { class: 'hint' }, a.keep ? '영상이 끝난 뒤에도 음악이 끝까지 나와요. 그동안 화면은 검게 나오고, 글자는 넣을 수 있어요.'
      : '영상보다 길면 영상이 끝날 때 함께 끝나요. 끝부분은 페이드 아웃으로 부드럽게 줄어들어요.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => CR.split() }, I('scissors'), '재생 위치에서 자르기'),
      h('button', { class: 'btn danger', onclick: () => CR.deleteSel() }, I('trash'), '지우기')));
};

CR.inspectProject = function (body) {
  const P = CR.P;
  const L = CR.timing(CR.kept());
  const name = h('input', { class: 'tin', type: 'text', value: P.name, 'aria-label': '프로젝트 이름' });
  name.addEventListener('change', () => { const v = name.value.trim() || '새 프로젝트'; CR.edit('이름 바꾸기', () => { P.name = v; }); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
  CR.put(body, 
    field('프로젝트 이름', null, name),
    field('화면 비율', null, segPick([['16:9', '가로 16:9'], ['9:16', '세로 9:16'], ['1:1', '1:1']], P.aspect, (v) => CR.edit('화면 비율', () => { P.aspect = v; }))),
    field('화면 맞춤', null, segPick([['fit', '전체 보이기'], ['fill', '꽉 채우기']], P.fit, (v) => CR.edit('화면 맞춤', () => { P.fit = v; }))),
    h('p', { class: 'hint' }, '비율이 다른 영상은 ‘전체 보이기’면 검은 띠가 생기고, ‘꽉 채우기’면 가장자리가 잘려요.'),
    P.media.some((m) => m.kind === 'image') ? field('사진', null,
      h('label', { class: 'check' }, (() => { const cb = h('input', { type: 'checkbox', checked: P.bgBlur }); cb.addEventListener('change', () => CR.edit('흐린 배경', () => { P.bgBlur = cb.checked; })); return cb; })(), '빈 곳은 사진을 흐리게 채우기'),
      h('label', { class: 'check' }, (() => { const cb = h('input', { type: 'checkbox', checked: P.photoFrame }); cb.addEventListener('change', () => CR.edit('흰 액자', () => { P.photoFrame = cb.checked; })); return cb; })(), '흰 액자 테두리')) : null,
    CR.timelineBeats().beats.length ? field('박자 효과', null, h('div', { class: 'chips2' }, CR.BEATFX.map(([k, label]) =>
      h('button', { class: P.beatFx[k] ? 'on' : '', onclick: () => CR.edit('박자 효과', () => { P.beatFx[k] = !P.beatFx[k]; }) }, label)))) : null,
    h('div', { class: 'facts', style: { padding: '10px 12px' } },
      h('div', null, h('small', null, '길이'), h('b', null, CR.short(CR.spanOf(P, L.total)))),
      h('div', null, h('small', null, '클립'), h('b', null, String(L.list.length))),
      h('div', null, h('small', null, '글자'), h('b', null, String(P.texts.length)))),
    h('p', { class: 'hint' }, CR.T('타임라인에서 클립 · 글자 · 배경음악을 누르면 여기서 자세히 바꿀 수 있어요.\nSpace 재생 · ⌘B 자르기 · ⌫ 지우기 · ⌘Z 되돌리기')));
};

// ---------------------------------------------------------------- 컷 편집만 아래쪽

CR.renderQuick = function () {
  const box = CR.V.qbottom;
  if (!box) return;
  box.innerHTML = '';
  const host = h('div');
  const sel = CR.S.sel;
  const selClip = sel && sel.type === 'clip' && CR.findSel(sel);
  CR.put(box, host, h('div', { class: 'qactions' },
    h('button', { class: 'btn big solid', onclick: () => CR.split() }, I('scissors'), '여기서 자르기 ', h('span', { class: 'kbd', style: { color: 'inherit', opacity: .7 } }, CR.T('⌘B'))),
    selClip && selClip.removed
      ? h('button', { class: 'btn big', onclick: () => CR.restoreClip(selClip.id) }, I('restore'), '선택한 조각 되살리기')
      : h('button', { class: 'btn big', disabled: !selClip, onclick: () => CR.deleteSel() }, I('trash'), '선택한 조각 지우기 ', h('span', { class: 'kbd' }, CR.T('⌫'))),
    h('button', { class: 'btn big ghost', disabled: !CR.hist.undo.length, onclick: () => CR.undo() }, I('undo'), '되돌리기'),
    h('button', { class: 'btn big ghost', title: '말소리가 없는 부분 찾기', onclick: () => {
      const list = CR.findSilences();
      if (!list.length) return CR.toast('1초 넘게 조용한 곳이 없어요');
      CR.cutSilences(list);
    } }, I('silence'), '무음 자동 컷'),
    h('div', { class: 'grow' }),
    h('span', { class: 'hint' }, '재생 위치에서 자르고, 필요 없는 조각을 눌러 지우세요')));
  requestAnimationFrame(() => CR.renderQuickStrip(host));
};

// ---------------------------------------------------------------- 상태 줄

CR.status = function () {
  const s = CR.V.status;
  if (!s || !CR.P) return;
  s.innerHTML = '';
  const P = CR.P;
  const L = CR.layout();
  const nameBtn = h('span', { class: 'name', title: '눌러서 이름 바꾸기', onclick: () => CR.rename() }, P.name);
  let info;
  if (L.quick) {
    const gone = P.clips.filter((c) => c.removed).length;
    info = '조각 ' + P.clips.length + '개 · ' + gone + '개 지움 · 남는 길이 ' + CR.human(L.kept);
  } else {
    info = '클립 ' + L.list.length + '개 · 길이 ' + CR.human(CR.total());
  }
  const saved = CR.S.settings.autoSave === false ? (CR.S.saved ? '저장됨' : CR.T('저장 안 됨 · ⌘S')) : (CR.S.saved ? '자동 저장됨' : '저장 중…');
  s.append(h('span', null, nameBtn, ' · ' + saved + ' · ' + info), h('span', { class: 'made' }, 'made by. Nevertheless_D'));
};

CR.rename = function () {
  CR.ask('프로젝트 이름', CR.P.name, (v) => { v = v.trim(); if (v) CR.edit('이름 바꾸기', () => { CR.P.name = v; }); });
};

// ---------------------------------------------------------------- 처음 화면

CR.renderHome = async function () {
  const v = CR.V.home;
  v.innerHTML = '';
  const recent = h('div', { class: 'recent' });
  const left = h('div', { class: 'left' },
    h('div', { class: 'brand' }, CR.logoSVG(), h('div', null, h('h1', null, 'CUT', h('b', null, 'ROAD')), h('p', { class: 'tag' }, '가볍게 자르고, 붙이고, 바로 내보내는 영상 편집기'))),
    h('div', { class: 'dropbig' },
      h('div', { class: 'ic' }, I('film')),
      h('div', { style: { textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('b', null, '영상을 여기에 끌어다 놓으세요'), h('p', null, '영상 MOV · MP4 · 소리 MP3 · WAV · M4A · 사진 JPG · PNG · HEIC')),
      h('div', { class: 'actions', style: { marginTop: '4px' } },
        h('button', { class: 'btn primary big', style: { height: '38px', fontSize: '14px' }, onclick: () => CR.startNew() }, '새 프로젝트'),
        h('button', { class: 'btn big', style: { height: '38px', fontSize: '14px' }, onclick: async () => {
          try { const r = await CR.native('open', {}); if (r.paths && r.paths.length) CR.startNew(r.paths); } catch (e) { CR.toast(e.message, { bad: true }); }
        } }, '파일 선택…'),
        h('button', { class: 'btn big', style: { height: '38px', fontSize: '14px' }, onclick: async () => {
          try {
            const r = await CR.native('open', {});
            if (r.paths && r.paths.length) { CR.P = CR.newProject(); CR.P.mode = 'quick'; CR.hist = { undo: [], redo: [] }; CR.S.sel = null; CR.S.t = 0; CR.go('editor'); CR.importPaths(r.paths); }
          } catch (e) { CR.toast(e.message, { bad: true }); }
        } }, I('scissors'), '컷 편집만 하기')),
      h('button', { class: 'btn big', style: { height: '42px', fontSize: '14px', borderColor: 'var(--accent)', fontWeight: 600, marginTop: '2px' }, onclick: () => CR.openAutoMake() },
        I('photo'), '사진 + 음악으로 영상 만들기')),
    h('div', { class: 'keys' },
      CR.WIN ? null : h('span', null, h('span', { class: 'kbd', style: { color: 'var(--sub)' } }, CR.T('⌘N')), ' 새 프로젝트'),
      h('span', null, h('span', { class: 'kbd', style: { color: 'var(--sub)' } }, CR.T('⌘I')), ' 가져오기'),
      h('span', null, h('span', { class: 'kbd', style: { color: 'var(--sub)' } }, CR.T('⌘,')), ' 설정'),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn ghost', style: { height: '26px', fontSize: '12px' }, onclick: () => CR.openSettings() }, I('gear'), '설정')));
  const right = h('div', { class: 'right' }, h('h2', null, '최근 프로젝트'), recent);
  CR.put(v, h('div', { class: 'home' }, left, right),
    h('div', { class: 'statusbar' }, h('span', null, '버전 ' + (CR.S.settings.build || '') + (CR.S.updateText ? ' · ' + CR.S.updateText : '')), h('span', { class: 'made' }, 'made by. Nevertheless_D')));
  let list = [];
  try { list = (await CR.api('/api/projects')).projects || []; } catch (e) { /* 엔진 준비 중 */ }
  if (!list.length) recent.appendChild(h('div', { class: 'none' }, '아직 프로젝트가 없어요.\n영상을 끌어다 놓거나 ‘새 프로젝트’를 눌러 시작하세요.'));
  list.slice(0, 30).forEach((p) => {
    const more = h('button', { class: 'more', 'aria-label': '더 보기' }, I('more'));
    const card = h('div', { class: 'rcard', onclick: (e) => { if (!more.contains(e.target)) CR.openProject(p.id).catch((er) => CR.toast(er.message, { bad: true })); } },
      h('div', { class: 'th', style: p.thumb ? { backgroundImage: 'url(' + p.thumb + ')' } : {} }, h('span', null, CR.short(p.duration || 0))),
      h('div', { class: 'tx' }, h('b', null, p.name), h('small', null, CR.when(p.updatedAt) + (p.mode === 'quick' ? ' · 컷 편집' : ''))),
      more);
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      CR.menu(e.clientX, e.clientY, [
        { label: '열기', icon: 'film', run: () => CR.openProject(p.id) },
        { label: '지우기', icon: 'trash', danger: true, run: () => CR.confirm('‘' + p.name + '’ 프로젝트를 지울까요?', '영상 파일은 지워지지 않아요. 프로젝트(편집 내용)만 지워요.', '지우기', async () => {
          await CR.api('/api/project/delete', { id: p.id });
          CR.renderHome();
        }) },
      ]);
    });
    recent.appendChild(card);
  });
};
