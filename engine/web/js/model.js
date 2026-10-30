// CUTROAD — 프로젝트 (클립 · 배경음악 · 글자), 시간 계산, 편집 동작, 되돌리기, 저장
// made by. Nevertheless_D
'use strict';

CR.P = null;                        // 지금 편집 중인 프로젝트
CR.cache = { thumbs: {}, waves: {} }; // 파일 경로 → 썸네일 · 파형 (저장하지 않아요)
CR.S = { view: 'home', sel: null, t: 0, pps: 10, zoomFit: true, silences: null, settings: {}, saved: true };
CR.hist = { undo: [], redo: [] };

CR.newProject = function () {
  return { v: 1, id: '', name: '새 프로젝트', mode: 'full', aspect: '16:9', fit: 'fit', media: [], clips: [], audio: [], texts: [] };
};

CR.normalize = function (p) {
  const d = CR.newProject();
  for (const k in d) if (p[k] === undefined) p[k] = d[k];
  p.clips.forEach((c) => {
    c.speed = c.speed || 1; c.volume = c.volume === undefined ? 1 : c.volume;
    c.fadeIn = c.fadeIn || 0; c.fadeOut = c.fadeOut || 0; c.blur = c.blur || 0; c.rotate = c.rotate || 0;
    if (c.trans === undefined) c.trans = null;
  });
  p.audio.forEach((a) => { a.volume = a.volume === undefined ? 0.6 : a.volume; a.fadeIn = a.fadeIn || 0; a.fadeOut = a.fadeOut || 0; });
  p.texts.forEach((x) => { x.pos = x.pos || 'bottom'; x.size = x.size || 'm'; if (x.box === undefined) x.box = x.kind !== 'title'; });
  return p;
};

CR.media = (id) => CR.P && CR.P.media.find((m) => m.id === id);
CR.clipById = (id) => CR.P && CR.P.clips.find((c) => c.id === id);
CR.dur = (c) => (c.out - c.in) / (c.speed || 1);
CR.kept = () => (CR.P ? CR.P.clips.filter((c) => !c.removed) : []);
CR.quick = () => CR.P && CR.P.mode === 'quick';

/** 클립들의 시작 시각 · 트랜지션 길이 · 전체 길이 (Render.swift 의 Plan.timing() 과 같은 계산) */
CR.timing = function (list) {
  const n = list.length, starts = [], trans = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    starts.push(t);
    let td = 0;
    if (i + 1 < n && list[i].trans && list[i].trans.type) {
      td = Math.min(list[i].trans.dur || 0.8, CR.dur(list[i]) / 2, CR.dur(list[i + 1]) / 2);
    }
    trans.push(td);
    t += CR.dur(list[i]) - td;
  }
  const total = n ? starts[n - 1] + CR.dur(list[n - 1]) : 0;
  return { list, starts, trans, total, end: (i) => starts[i] + CR.dur(list[i]) };
};

/** 컷 편집만: 지운 조각까지 순서대로 붙여 놓은 배치 (효과 · 트랜지션 없음) */
CR.quickLayout = function () {
  const list = CR.P ? CR.P.clips : [];
  const starts = [];
  let t = 0, kept = 0;
  list.forEach((c) => { starts.push(t); const d = (c.out - c.in); t += d; if (!c.removed) kept += d; });
  return { list, starts, total: t, kept, end: (i) => starts[i] + (list[i].out - list[i].in) };
};

/** 지금 화면 기준의 배치 (전체 편집 = kept 클립 + 트랜지션, 컷 편집만 = 모든 조각) */
CR.layout = function () {
  if (CR.quick()) {
    const q = CR.quickLayout();
    return { quick: true, list: q.list, starts: q.list.map((c, i) => q.starts[i]), trans: q.list.map(() => 0), total: q.total, kept: q.kept,
      end: q.end, dur: (c) => c.out - c.in };
  }
  const tm = CR.timing(CR.kept());
  return Object.assign(tm, { quick: false, dur: CR.dur });
};

CR.total = function () {
  const L = CR.layout();
  return L.total;
};

/** 타임라인 시각 t 에 있는 클립 (트랜지션 겹침이면 뒤 클립) */
CR.clipAt = function (t, L) {
  L = L || CR.layout();
  let found = -1;
  for (let i = 0; i < L.list.length; i++) {
    if (t >= L.starts[i] - 1e-6 && t < L.end(i) - 1e-6) found = i;
  }
  if (found < 0 && L.list.length && Math.abs(t - L.total) < 1e-3) found = L.list.length - 1;
  return found;
};

// ---------------------------------------------------------------- 되돌리기

CR.snapshot = function () {
  const p = Object.assign({}, CR.P);
  delete p.thumb;
  return JSON.stringify(p);
};

CR.edit = function (label, fn, opt) {
  if (!CR.P) return;
  const before = CR.snapshot();
  const r = fn();
  if (r === false) return false;
  if (CR.snapshot() === before) return r;
  CR.hist.undo.push({ label, data: before });
  if (CR.hist.undo.length > 150) CR.hist.undo.shift();
  CR.hist.redo = [];
  CR.changed(opt);
  return r;
};

CR.restore = function (data) {
  const keep = { id: CR.P.id, thumb: CR.P.thumb };
  CR.P = CR.normalize(Object.assign(JSON.parse(data), keep));
  if (CR.S.sel && !CR.findSel(CR.S.sel)) CR.S.sel = null;
};

CR.undo = function () {
  const u = CR.hist.undo.pop();
  if (!u) return CR.toast('더 되돌릴 게 없어요');
  CR.hist.redo.push({ label: u.label, data: CR.snapshot() });
  CR.restore(u.data);
  CR.changed();
  CR.toast('되돌렸어요: ' + u.label);
};

CR.redo = function () {
  const u = CR.hist.redo.pop();
  if (!u) return CR.toast('다시 할 게 없어요');
  CR.hist.undo.push({ label: u.label, data: CR.snapshot() });
  CR.restore(u.data);
  CR.changed();
  CR.toast('다시 했어요: ' + u.label);
};

// ---------------------------------------------------------------- 선택

CR.findSel = function (sel) {
  if (!sel || !CR.P) return null;
  if (sel.type === 'clip' || sel.type === 'trans') return CR.clipById(sel.id);
  if (sel.type === 'audio') return CR.P.audio.find((a) => a.id === sel.id);
  if (sel.type === 'text') return CR.P.texts.find((x) => x.id === sel.id);
  return null;
};
CR.select = function (type, id) {
  CR.S.sel = type ? { type, id } : null;
  CR.render && CR.render('select');
};

// ---------------------------------------------------------------- 저장

CR.saveNow = async function () {
  if (!CR.P) return;
  const L = CR.timing(CR.kept());
  CR.P.duration = L.total;
  const first = CR.P.clips.find((c) => !c.removed);
  const m = first && CR.media(first.mediaId);
  const th = m && CR.cache.thumbs[m.path];
  if (th && th.frames && th.frames.length) CR.P.thumb = th.frames[0];
  try {
    const r = await CR.api('/api/project/save', CR.P);
    CR.P.id = r.id;
    CR.S.saved = true;
    CR.status && CR.status();
  } catch (e) {
    CR.S.saved = false;
    CR.status && CR.status();
    CR.toast('저장하지 못했어요: ' + e.message, { bad: true });
  }
};
CR.save = CR.debounce(() => { if (CR.S.settings.autoSave !== false) CR.saveNow(); }, 700);

CR.changed = function (opt) {
  CR.S.saved = false;
  CR.S.silences = null;
  if (CR.S.sel && !CR.findSel(CR.S.sel)) CR.S.sel = null;
  CR.S.t = CR.clamp(CR.S.t, 0, CR.total());
  CR.render && CR.render((opt && opt.part) || 'all');
  CR.save();
};

CR.openProject = async function (id) {
  const p = await CR.api('/api/project?id=' + encodeURIComponent(id));
  CR.P = CR.normalize(p);
  CR.hist = { undo: [], redo: [] };
  CR.S.sel = null; CR.S.t = 0; CR.S.zoomFit = true; CR.S.saved = true;
  CR.go('editor');
  CR.refreshMedia();
};

CR.startNew = function (paths) {
  CR.P = CR.newProject();
  CR.hist = { undo: [], redo: [] };
  CR.S.sel = null; CR.S.t = 0; CR.S.zoomFit = true;
  CR.go('editor');
  if (paths && paths.length) CR.importPaths(paths);
};

/** 파일이 그대로 있는지 확인하고 썸네일 · 파형을 받아요 */
CR.refreshMedia = async function () {
  if (!CR.P || !CR.P.media.length) return;
  try {
    const r = await CR.native('probe', { paths: CR.P.media.map((m) => m.path) });
    (r.items || []).forEach((it, i) => {
      const m = CR.P.media[i];
      if (!m) return;
      m.missing = !!it.error;
      if (!it.error) Object.assign(m, { duration: it.duration, width: it.width, height: it.height, fps: it.fps, hasAudio: it.hasAudio });
    });
  } catch (e) { /* 앱 밖에서 시험할 때 */ }
  CR.P.media.forEach((m) => { if (!m.missing) CR.loadAssets(m); });
  CR.render && CR.render('all');
};

CR.loadAssets = function (m) {
  if (m.kind === 'video' && !CR.cache.thumbs[m.path]) {
    CR.cache.thumbs[m.path] = { frames: [], interval: 0, loading: true };
    CR.native('thumbs', { path: m.path, height: 90 }).then((r) => {
      CR.cache.thumbs[m.path] = r || { frames: [] };
      if (CR.P && !CR.P.thumb && r && r.frames && r.frames.length) CR.save(); // 처음 화면의 최근 프로젝트 그림
      CR.render && CR.render('media');
    }).catch(() => { CR.cache.thumbs[m.path] = { frames: [] }; });
  }
  if (m.hasAudio !== false && !CR.cache.waves[m.path]) {
    CR.cache.waves[m.path] = { peaks: [], perSec: 50, loading: true };
    CR.native('waveform', { path: m.path }).then((r) => {
      CR.cache.waves[m.path] = r || { peaks: [] };
      CR.render && CR.render('timeline');
    }).catch(() => { CR.cache.waves[m.path] = { peaks: [] }; });
  }
};

// ---------------------------------------------------------------- 가져오기

CR.importPaths = async function (paths, opt) {
  opt = opt || {};
  if (!paths || !paths.length) return;
  if (!CR.P) { CR.startNew(paths); return; }
  let r;
  try { r = await CR.native('probe', { paths }); } catch (e) { return CR.toast(e.message, { bad: true }); }
  const items = r.items || [];
  const bad = items.filter((x) => x.error);
  const good = items.filter((x) => !x.error);
  if (bad.length) CR.toast(bad.length === 1 ? bad[0].name + ': ' + bad[0].error : '읽을 수 없는 파일 ' + bad.length + '개는 건너뛰었어요', { bad: true });
  if (!good.length) return;
  CR.edit('가져오기', () => {
    good.forEach((it) => {
      let m = CR.P.media.find((x) => x.path === it.path);
      if (!m) {
        m = { id: 'm' + CR.uid(), path: it.path, name: it.name, kind: it.kind };
        CR.P.media.push(m);
      }
      Object.assign(m, { name: it.name, kind: it.kind, duration: it.duration, width: it.width, height: it.height, fps: it.fps, hasAudio: it.hasAudio, missing: false });
      if (opt.binOnly) return;
      if (m.kind === 'video') CR.appendClip(m);
      else CR.addBGM(m);
    });
    if (CR.P.name === '새 프로젝트') {
      const v = good.find((x) => x.kind === 'video') || good[0];
      CR.P.name = v.name.replace(/\.[^.]+$/, '');
    }
    if (CR.P.clips.length && CR.P.clips.length === good.filter((x) => x.kind === 'video').length) {
      // 첫 영상의 모양에 맞춰 화면 비율을 정해요 (세로 영상이면 9:16)
      const fv = good.find((x) => x.kind === 'video');
      if (fv && fv.width && fv.height) {
        const r2 = fv.width / fv.height;
        CR.P.aspect = r2 < 0.8 ? '9:16' : (r2 < 1.2 ? '1:1' : '16:9');
      }
    }
  });
  CR.S.zoomFit = true;
  good.forEach((it) => { const m = CR.P.media.find((x) => x.path === it.path); if (m) CR.loadAssets(m); });
  CR.toast(good.length + '개를 가져왔어요');
  CR.render('all');
};

CR.appendClip = function (m, index) {
  const c = { id: 'c' + CR.uid(), mediaId: m.id, in: 0, out: CR.round(m.duration, 3), speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, blur: 0, rotate: 0, trans: null };
  if (index === undefined || index >= CR.P.clips.length) CR.P.clips.push(c);
  else CR.P.clips.splice(index, 0, c);
  return c;
};

CR.addBGM = function (m, start) {
  if (start === undefined) {
    start = CR.P.audio.reduce((mx, a) => Math.max(mx, a.start + (a.out - a.in)), 0);
    if (start >= CR.timing(CR.kept()).total - 0.5) start = 0;
  }
  const a = { id: 'a' + CR.uid(), mediaId: m.id, start: CR.round(start, 3), in: 0, out: CR.round(m.duration, 3), volume: 0.6, fadeIn: 1, fadeOut: 1.5 };
  CR.P.audio.push(a);
  return a;
};

CR.addText = function (kind, start, text) {
  const total = CR.total();
  start = CR.clamp(start, 0, Math.max(0, total - 0.5));
  const x = { id: 't' + CR.uid(), kind, text: text || (kind === 'title' ? '제목을 입력하세요' : '자막을 입력하세요'),
    start: CR.round(start, 2), end: CR.round(Math.min(Math.max(total, start + 0.5), start + 3), 2),
    pos: kind === 'title' ? 'center' : 'bottom', size: kind === 'title' ? 'l' : 'm', box: kind !== 'title' };
  CR.P.texts.push(x);
  return x;
};

// ---------------------------------------------------------------- 편집 동작

/** 재생 위치에서 자르기 (선택한 배경음악 · 글자가 그 자리에 있으면 그것을, 아니면 영상을) */
CR.split = function () {
  const t = CR.S.t;
  const sel = CR.S.sel;
  if (sel && sel.type === 'audio' && !CR.quick()) {
    const a = CR.findSel(sel);
    if (a && t > a.start + 0.05 && t < a.start + (a.out - a.in) - 0.05) {
      return CR.edit('배경음악 자르기', () => {
        const b = Object.assign({}, a, { id: 'a' + CR.uid() });
        const cut = a.in + (t - a.start);
        a.out = CR.round(cut, 3); a.fadeOut = 0;
        b.in = CR.round(cut, 3); b.start = CR.round(t, 3); b.fadeIn = 0;
        CR.P.audio.push(b);
      });
    }
  }
  if (sel && sel.type === 'text' && !CR.quick()) {
    const x = CR.findSel(sel);
    if (x && t > x.start + 0.1 && t < x.end - 0.1) {
      return CR.edit('글자 나누기', () => {
        const y = Object.assign({}, x, { id: 't' + CR.uid(), start: CR.round(t, 2) });
        x.end = CR.round(t, 2);
        CR.P.texts.push(y);
      });
    }
  }
  const L = CR.layout();
  const i = CR.clipAt(t, L);
  if (i < 0) return CR.toast('재생 위치에 자를 영상이 없어요');
  const c = L.list[i];
  const off = t - L.starts[i];
  if (off < 0.05 || L.end(i) - t < 0.05) return CR.toast('클립의 맨 끝이라 자를 수 없어요');
  return CR.edit('자르기', () => {
    const src = CR.round(c.in + off * (L.quick ? 1 : c.speed), 3);
    const d = Object.assign({}, c, { id: 'c' + CR.uid(), in: src, fadeIn: 0 });
    c.out = src; c.fadeOut = 0;
    d.trans = c.trans; c.trans = null;
    CR.P.clips.splice(CR.P.clips.indexOf(c) + 1, 0, d);
    CR.S.sel = { type: 'clip', id: d.id };
  });
};

CR.deleteSel = function () {
  const sel = CR.S.sel;
  if (!sel) return;
  if (sel.type === 'clip') {
    const c = CR.findSel(sel);
    if (!c) return;
    if (CR.quick()) {
      CR.edit('조각 지우기', () => { c.removed = true; });
      CR.toast('지운 조각은 빗금으로 남아 있어요. 누르면 되살릴 수 있어요');
    } else {
      CR.edit('클립 지우기', () => { CR.P.clips.splice(CR.P.clips.indexOf(c), 1); CR.S.sel = null; });
      CR.toast('클립을 지웠어요', { action: CR.undo });
    }
  } else if (sel.type === 'trans') {
    const c = CR.findSel(sel);
    if (c) CR.edit('트랜지션 빼기', () => { c.trans = null; CR.S.sel = { type: 'clip', id: c.id }; });
  } else if (sel.type === 'audio') {
    CR.edit('배경음악 지우기', () => { CR.P.audio = CR.P.audio.filter((a) => a.id !== sel.id); CR.S.sel = null; });
  } else if (sel.type === 'text') {
    CR.edit('글자 지우기', () => { CR.P.texts = CR.P.texts.filter((x) => x.id !== sel.id); CR.S.sel = null; });
  }
};

CR.restoreClip = function (id) {
  const c = CR.clipById(id);
  if (c) CR.edit('조각 되살리기', () => { delete c.removed; });
};

/** 클립 순서 바꾸기: id 를 kept 목록의 to 번째 자리로 */
CR.moveClip = function (id, to) {
  const list = CR.quick() ? CR.P.clips : CR.kept();
  const from = list.findIndex((c) => c.id === id);
  if (from < 0 || to === from || to === from + 1) return;
  CR.edit('클립 옮기기', () => {
    const c = list[from];
    const target = list[to] || null; // 이 클립 앞에 넣어요 (없으면 맨 끝)
    CR.P.clips.splice(CR.P.clips.indexOf(c), 1);
    if (target) CR.P.clips.splice(CR.P.clips.indexOf(target), 0, c);
    else CR.P.clips.push(c);
  });
};

CR.setTrans = function (id, type, dur) {
  const c = CR.clipById(id);
  if (!c) return;
  CR.edit('트랜지션', () => {
    if (!type) c.trans = null;
    else c.trans = { type, dur: CR.round(dur || (c.trans && c.trans.dur) || 0.8, 2) };
  });
};

// ---------------------------------------------------------------- 무음 구간

/** 영상 소리가 1초 넘게 아주 작은 곳 (앞뒤 0.15초는 남겨요) */
CR.findSilences = function () {
  const L = CR.layout();
  const out = [];
  const minLen = 1.0, margin = 0.15, thr = 0.02;
  L.list.forEach((c, i) => {
    if (c.removed) return;
    const m = CR.media(c.mediaId);
    const w = m && CR.cache.waves[m.path];
    if (!w || !w.peaks || !w.peaks.length) return;
    const per = w.perSec || 50;
    const a0 = Math.floor(c.in * per), a1 = Math.min(w.peaks.length, Math.ceil(c.out * per));
    let runStart = -1;
    for (let k = a0; k <= a1; k++) {
      const quiet = k < a1 && w.peaks[k] < thr;
      if (quiet && runStart < 0) runStart = k;
      if (!quiet && runStart >= 0) {
        const sa = runStart / per, sb = k / per;
        if (sb - sa >= minLen) {
          const a = sa === c.in ? sa : sa + margin, b = Math.abs(sb - c.out) < 0.03 ? sb : sb - margin;
          if (b - a > 0.3) {
            const sp = L.quick ? 1 : c.speed;
            out.push({ clipId: c.id, a: CR.round(a, 3), b: CR.round(b, 3), ta: L.starts[i] + (a - c.in) / sp, tb: L.starts[i] + (b - c.in) / sp });
          }
        }
        runStart = -1;
      }
    }
  });
  return out;
};

CR.cutSilences = function (list) {
  if (!list || !list.length) return;
  CR.edit('무음 구간 잘라내기', () => {
    const byClip = {};
    list.forEach((s) => (byClip[s.clipId] = byClip[s.clipId] || []).push(s));
    const next = [];
    CR.P.clips.forEach((c) => {
      const ss = (byClip[c.id] || []).sort((x, y) => x.a - y.a);
      if (!ss.length) return next.push(c);
      let cur = c.in;
      const pieces = [];
      ss.forEach((s) => {
        if (s.a - cur > 0.05) pieces.push({ in: cur, out: s.a, removed: false });
        pieces.push({ in: s.a, out: s.b, removed: true });
        cur = s.b;
      });
      if (c.out - cur > 0.05) pieces.push({ in: cur, out: c.out, removed: false });
      const keptPieces = pieces.filter((p) => !p.removed);
      pieces.forEach((p) => {
        if (p.removed && !CR.quick()) return;
        const d = Object.assign({}, c, { id: 'c' + CR.uid(), in: CR.round(p.in, 3), out: CR.round(p.out, 3) });
        if (p.removed) d.removed = true; else delete d.removed;
        if (p !== keptPieces[0]) d.fadeIn = 0;
        if (p !== keptPieces[keptPieces.length - 1]) { d.fadeOut = 0; d.trans = null; }
        next.push(d);
      });
    });
    CR.P.clips = next;
    CR.S.sel = null;
  });
  const sec = list.reduce((s, x) => s + (x.b - x.a), 0);
  CR.toast('무음 ' + list.length + '곳(' + CR.round(sec, 1) + '초)을 잘라냈어요', { action: CR.undo });
};

/** 내보내기 · 자동 자막에 보낼 내용 (Render.swift 의 Plan 이 읽어요) */
CR.spec = function (opt) {
  opt = opt || {};
  const P = CR.P;
  const path = (id) => { const m = CR.media(id); return m ? m.path : ''; };
  const clips = CR.kept().map((c) => ({ path: path(c.mediaId), in: c.in, out: c.out,
    speed: opt.plain ? 1 : c.speed, volume: c.volume, fadeIn: opt.plain ? 0 : c.fadeIn, fadeOut: opt.plain ? 0 : c.fadeOut,
    blur: opt.plain ? 0 : c.blur, rotate: opt.plain ? 0 : c.rotate, trans: opt.plain ? null : c.trans }));
  const audio = opt.plain ? [] : P.audio.map((a) => ({ path: path(a.mediaId), start: a.start, in: a.in, out: a.out, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut }));
  let texts = opt.plain ? [] : P.texts.slice();
  if (opt.captions === 'none' || opt.captions === 'srt') texts = texts.filter((x) => x.kind !== 'caption');
  return { clips, audio, texts: texts.map((x) => ({ text: x.text, start: x.start, end: x.end, pos: x.pos, size: x.size, box: x.box })),
    aspect: P.aspect, fit: P.fit };
};

/** SRT 자막 파일 내용 */
CR.srt = function () {
  const tc = (t) => {
    const ms = Math.round(t * 1000), h2 = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    return String(h2).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ',' + String(r).padStart(3, '0');
  };
  return CR.P.texts.filter((x) => x.kind === 'caption').sort((a, b) => a.start - b.start)
    .map((x, i) => (i + 1) + '\n' + tc(x.start) + ' --> ' + tc(x.end) + '\n' + x.text + '\n').join('\n');
};
