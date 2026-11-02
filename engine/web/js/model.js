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
    c.motion = c.motion || 'none'; c.filter = c.filter || 'none';
    if (c.trans === undefined) c.trans = null;
  });
  p.audio.forEach((a) => { a.volume = a.volume === undefined ? 0.6 : a.volume; a.fadeIn = a.fadeIn || 0; a.fadeOut = a.fadeOut || 0; });
  p.texts.forEach((x) => { x.pos = x.pos || 'bottom'; x.size = x.size || 'm'; if (x.box === undefined) x.box = x.kind !== 'title'; });
  p.bgBlur = !!p.bgBlur; p.photoFrame = !!p.photoFrame;
  p.beatFx = Object.assign({ pulse: false, flash: false, shake: false }, p.beatFx || {});
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
      if (!it.error) CR.applyProbe(m, it);
    });
  } catch (e) { /* 앱 밖에서 시험할 때 */ }
  CR.P.media.forEach((m) => { if (!m.missing) CR.loadAssets(m); });
  CR.render && CR.render('all');
};

/** 파일 정보를 미디어에 넣어요 (사진은 미리보기 · 작은 그림 · 찍은 날짜도) */
CR.applyProbe = function (m, it) {
  Object.assign(m, { name: it.name, kind: it.kind, duration: it.duration, width: it.width, height: it.height, fps: it.fps, hasAudio: it.hasAudio, size: it.size, missing: false });
  if (it.kind === 'image') {
    m.preview = it.preview; m.taken = it.taken;
    if (it.thumb) CR.cache.thumbs[m.path] = { frames: [it.thumb], interval: 1e9, aspect: it.width && it.height ? it.width / it.height : 4 / 3 };
  }
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
      CR.applyProbe(m, it);
      if (opt.binOnly) return;
      if (m.kind === 'video' || m.kind === 'image') CR.appendClip(m);
      else CR.addBGM(m);
    });
    if (CR.P.name === '새 프로젝트') {
      const v = good.find((x) => x.kind !== 'audio') || good[0];
      CR.P.name = v.name.replace(/\.[^.]+$/, '');
    }
    if (CR.P.clips.length && CR.P.clips.length === good.filter((x) => x.kind !== 'audio').length) {
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

CR.appendClip = function (m, index, dur) {
  const out = m.kind === 'image' ? (dur || 3) : CR.round(m.duration, 3);
  const c = { id: 'c' + CR.uid(), mediaId: m.id, in: 0, out: CR.round(out, 3), speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, blur: 0, rotate: 0,
    motion: 'none', filter: 'none', trans: null };
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
  const clips = CR.kept().map((c) => {
    const m = CR.media(c.mediaId) || {};
    return { path: path(c.mediaId), kind: m.kind === 'image' ? 'image' : 'video', w: m.width || 0, h: m.height || 0, in: c.in, out: c.out,
      speed: opt.plain ? 1 : c.speed, volume: c.volume, fadeIn: opt.plain ? 0 : c.fadeIn, fadeOut: opt.plain ? 0 : c.fadeOut,
      blur: opt.plain ? 0 : c.blur, rotate: opt.plain ? 0 : c.rotate, trans: opt.plain ? null : c.trans,
      motion: opt.plain ? 'none' : c.motion, motionAmt: c.motionAmt === undefined ? 1 : c.motionAmt, filter: opt.plain ? 'none' : c.filter };
  });
  const audio = opt.plain ? [] : P.audio.map((a) => ({ path: path(a.mediaId), start: a.start, in: a.in, out: a.out, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut }));
  let texts = opt.plain ? [] : P.texts.slice();
  if (opt.captions === 'none' || opt.captions === 'srt') texts = texts.filter((x) => x.kind !== 'caption');
  const out = { clips, audio, texts: texts.map((x) => ({ text: x.text, start: x.start, end: x.end, pos: x.pos, size: x.size, box: x.box })),
    aspect: P.aspect, fit: P.fit, bgBlur: !opt.plain && P.bgBlur, photoFrame: !opt.plain && P.photoFrame };
  const fx = P.beatFx || {};
  if (!opt.plain && (fx.pulse || fx.flash || fx.shake)) {
    const B = CR.timelineBeats();
    out.beatFx = { pulse: !!fx.pulse, flash: !!fx.flash, shake: !!fx.shake, beats: B.beats, flashes: B.flashes, climax: B.climax, pulseIn: B.pulseIn };
  }
  return out;
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

// ---------------------------------------------------------------- 효과 (Render.swift 의 Effects 와 같은 값)

CR.MOTIONS = [['zoomIn', '천천히 확대'], ['zoomOut', '천천히 축소'], ['panL', '왼쪽 → 오른쪽'], ['panR', '오른쪽 → 왼쪽'],
  ['up', '위로'], ['down', '아래로'], ['tilt', '기울며 확대'], ['none', '움직이지 않기']];
/** k = 움직임 크기 (1 = 보통, 쉬어 가는 부분은 작게, 절정은 크게) — Render.swift Effects.motion 과 같은 값 */
CR.motion = function (m, p, k) {
  p = CR.clamp(p || 0, 0, 1);
  k = k === undefined || k === null ? 1 : k;
  switch (m) {
    case 'zoomIn': return { s: 1 + 0.12 * k * p, dx: 0, dy: 0, rot: 0 };
    case 'zoomOut': return { s: 1 + 0.12 * k * (1 - p), dx: 0, dy: 0, rot: 0 };
    case 'panL': return { s: 1 + 0.12 * k, dx: (0.05 - 0.10 * p) * k, dy: 0, rot: 0 };
    case 'panR': return { s: 1 + 0.12 * k, dx: (-0.05 + 0.10 * p) * k, dy: 0, rot: 0 };
    case 'up': return { s: 1 + 0.12 * k, dx: 0, dy: (-0.04 + 0.08 * p) * k, rot: 0 };
    case 'down': return { s: 1 + 0.12 * k, dx: 0, dy: (0.04 - 0.08 * p) * k, rot: 0 };
    case 'tilt': return { s: 1 + (0.1 + 0.08 * p) * k, dx: 0, dy: 0, rot: (-3 + 3 * p) * k };
    default: return { s: 1, dx: 0, dy: 0, rot: 0 };
  }
};

CR.FILTER_NAMES = [['none', '원본'], ['warm', '따뜻하게'], ['cool', '시원하게'], ['vivid', '선명하게'], ['mono', '흑백'], ['vintage', '빈티지'], ['film', '필름'], ['faded', '바랜 색']];
CR.FILTERS = {
  warm: [['sepia', 0.25], ['saturate', 1.3], ['hue-rotate', -8]],
  cool: [['saturate', 1.1], ['hue-rotate', 18], ['brightness', 1.05]],
  vivid: [['saturate', 1.7], ['contrast', 1.15]],
  mono: [['grayscale', 1], ['contrast', 1.2]],
  vintage: [['sepia', 0.75], ['contrast', 0.9], ['brightness', 1.05]],
  film: [['contrast', 1.15], ['saturate', 0.75], ['sepia', 0.2]],
  faded: [['contrast', 0.8], ['brightness', 1.12], ['saturate', 0.65]],
};
CR.cssFilter = function (name) {
  const ops = CR.FILTERS[name];
  if (!ops) return '';
  return ops.map(([k, v]) => k + '(' + v + (k === 'hue-rotate' ? 'deg' : '') + ')').join(' ');
};

CR.TRANS = [['dissolve', '디졸브'], ['fadeblack', '검은 화면'], ['flash', '흰색 번쩍'], ['wipe', '와이프'], ['slide', '밀어내기'],
  ['circle', '원형 열기'], ['zoom', '확대하며'], ['spin', '빙글 돌며'], ['blur', '흐리게'], ['blinds', '블라인드']];
CR.BEATFX = [['pulse', '박자 펄스'], ['flash', '강한 박자에 번쩍'], ['shake', '절정에서 흔들림']];

/** 배경음악에 저장된 박자(음악 기준 시각)를 타임라인 시각으로 */
CR.SECTION_NAMES = { intro: '도입', verse: '전개', chorus: '절정', calm: '쉬어 가기', outro: '마무리' };

CR.timelineBeats = function () {
  const P = CR.P;
  const total = CR.timing(CR.kept()).total;
  const key = JSON.stringify(P.audio.map((a) => [a.id, a.start, a.in, a.out, !!a.beats])) + '|' + total;
  if (CR.cache.tlBeats && CR.cache.tlBeats.key === key) return CR.cache.tlBeats;
  const beats = [], down = [], flashes = [], climax = [], sections = [], pulseIn = [];
  P.audio.forEach((a) => {
    const B = a.beats;
    if (!B || !B.beats) return;
    const end = Math.min(total, a.start + (a.out - a.in));
    const map = (b) => a.start + (b - a.in);
    const ds = new Set(B.downbeats || []);
    const secs = (B.sections || []).map((x) => ({ start: Math.max(a.start, map(x.start)), end: Math.min(end, map(x.end)), type: x.type })).filter((x) => x.end > x.start);
    const inChorus = (t) => secs.some((x) => x.type === 'chorus' && t >= x.start && t < x.end);
    B.beats.forEach((b, i) => {
      if (b < a.in || b >= a.out) return;
      const t = map(b);
      if (t < 0 || t >= end) return;
      beats.push(t);
      if (ds.has(b)) {
        down.push(t);
        if (secs.length) {
          // 1.2: 번쩍은 '절정'에 들어가는 첫 박 + 절정 안에서 두 마디마다
          const sec = secs.find((x) => t >= x.start - 0.05 && t < x.end);
          if (sec && sec.type === 'chorus') {
            const nb = down.filter((d) => d >= sec.start - 0.05 && d <= t).length;
            if (nb === 1 || nb % 2 === 1) flashes.push(t);
          }
        } else if ((B.energy && B.energy[i] || 0) >= 0.7) flashes.push(t);
      }
    });
    if (secs.length) {
      secs.forEach((x) => { sections.push(x); if (x.type === 'chorus') { climax.push([CR.round(x.start, 3), CR.round(x.end, 3)]); pulseIn.push([CR.round(x.start, 3), CR.round(x.end, 3)]); } });
    } else {
      (B.climax || []).forEach(([x, y]) => {
        const s0 = Math.max(a.start, map(x)), e = Math.min(end, map(y));
        if (e > s0) climax.push([CR.round(s0, 3), CR.round(e, 3)]);
      });
    }
    void inChorus;
  });
  beats.sort((x, y) => x - y); down.sort((x, y) => x - y); flashes.sort((x, y) => x - y);
  CR.cache.tlBeats = { key, beats, down, flashes, climax, sections, pulseIn };
  return CR.cache.tlBeats;
};

function lastLE(a, t) {
  let lo = 0, hi = a.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r >= 0 ? a[r] : null;
}

/** 박자 효과 (Render.swift 의 BeatFx.at 과 같은 계산) */
CR.beatFxAt = function (t) {
  const fx = CR.P && CR.P.beatFx;
  if (!fx || !(fx.pulse || fx.flash || fx.shake)) return null;
  const B = CR.timelineBeats();
  let s = 1, dx = 0, dy = 0, white = 0;
  const b = lastLE(B.beats, t);
  if (b !== null) {
    const e = t - b;
    const pulseHere = !B.pulseIn.length || B.pulseIn.some(([x, y]) => t >= x && t < y);
    if (fx.pulse && pulseHere && e < 0.5) s = 1 + 0.035 * Math.exp(-e / 0.12);
    if (fx.shake && e < 0.6 && B.climax.some(([x, y]) => t >= x && t < y)) {
      const a = 0.012 * Math.exp(-e / 0.25);
      dx = a * Math.sin(2 * Math.PI * 7 * t);
      dy = 0.6 * a * Math.cos(2 * Math.PI * 9 * t);
    }
  }
  if (fx.flash) { const f = lastLE(B.flashes, t); if (f !== null && t - f < 0.45) white = 0.45 * Math.exp(-(t - f) / 0.09); }
  return { s, dx, dy, white };
};

// ---------------------------------------------------------------- 사진 + 음악 → 자동 배치

/** 같은 씨앗이면 같은 순서 (다시 섞기에 씀) */
CR.rng = function (seed) {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
};

CR.STYLES = {
  clean: { name: '깔끔하게', desc: '부드럽게 넘기고 천천히 확대', motions: ['zoomIn', 'zoomOut'], trans: ['dissolve'], color: 'none', beat: [] },
  vlog: { name: '여행 브이로그', desc: '밀어내기 · 따뜻한 색 · 박자 펄스', motions: ['zoomIn', 'zoomOut', 'panL', 'panR'], trans: ['dissolve', 'slide', 'circle', 'zoom'], color: 'warm', beat: ['pulse'] },
  film: { name: '감성 필름', desc: '흐리게 넘기기 · 필름 색감', motions: ['zoomIn', 'panL', 'panR'], trans: ['blur', 'dissolve', 'fadeblack'], color: 'film', beat: [] },
  party: { name: '신나게', desc: '빠른 컷 · 번쩍 · 흔들림', motions: ['zoomIn', 'tilt', 'zoomOut'], trans: ['flash', 'zoom', 'spin', 'slide', 'wipe'], color: 'vivid', beat: ['pulse', 'flash', 'shake'], mood: 'upbeat' },
  retro: { name: '레트로', desc: '빈티지 색 · 블라인드 넘기기', motions: ['zoomIn', 'up', 'down'], trans: ['blinds', 'wipe', 'fadeblack'], color: 'vintage', beat: ['flash'] },
  mono: { name: '흑백 시네마', desc: '흑백 · 검은 화면 · 느린 움직임', motions: ['zoomIn', 'zoomOut', 'panR'], trans: ['fadeblack', 'dissolve'], color: 'mono', beat: [], mood: 'calm' },
  auto: { name: '맡기기', desc: '스타일까지 음악에 맞춰 자동', motions: [], trans: [], color: 'none', beat: [] },
};
CR.autoStyle = function (ana) {
  const e = ana && ana.energy && ana.energy.length ? ana.energy.reduce((x, y) => x + y, 0) / ana.energy.length : 0.5;
  const bpm = (ana && ana.bpm) || 100;
  if (bpm >= 118 && e >= 0.45) return 'party';
  if (bpm >= 92) return 'vlog';
  return 'film';
};

/**
 * 음악을 도입 · 전개 · 절정 · 쉬어 가기 · 마무리로 나눠요 (1.2)
 * 마디(강박) 단위로 소리 크기를 보고, 크게 바뀌는 곳(최소 4마디 · 최대 16마디마다)에서 나눠요.
 */
CR.sections = function (ana) {
  const B = ana.beats || [], E = ana.energy || [], dur = ana.duration || 0;
  if (B.length < 24) return [{ start: 0, end: dur, type: 'verse', energy: 0.6 }];
  const ds = new Set(ana.downbeats || []);
  let bars = [];
  B.forEach((b, i) => { if (ds.has(b)) bars.push(i); });
  if (bars.length < 6) { bars = []; for (let i = 0; i < B.length; i += 4) bars.push(i); }
  const nb = bars.length;
  const barE = bars.map((st, k) => {
    const en = k + 1 < nb ? bars[k + 1] : B.length;
    let sum = 0; for (let i = st; i < en; i++) sum += E[i] || 0;
    return sum / Math.max(1, en - st);
  });
  const mean = (a, b) => { a = Math.max(0, a); b = Math.min(nb, b); let t = 0; for (let k = a; k < b; k++) t += barE[k]; return b > a ? t / (b - a) : 0; };
  const nov = barE.map((_, k) => (k < 2 || k > nb - 2 ? 0 : Math.abs(mean(k, k + 4) - mean(k - 4, k))));
  const cuts = [0];
  for (let k = 4; k < nb - 3; k++) {
    const last = cuts[cuts.length - 1];
    if (k - last < 4) continue;
    const peak = nov[k] >= nov[k - 1] && nov[k] >= (nov[k + 1] || 0);
    if ((peak && nov[k] > 0.12) || k - last >= 16) cuts.push(k);
  }
  const raw = cuts.map((k, j) => ({ b0: k, b1: j + 1 < cuts.length ? cuts[j + 1] : nb }));
  const es = raw.map((x) => mean(x.b0, x.b1));
  const sorted = es.slice().sort((x, y) => x - y);
  const hi = Math.max(0.62, sorted[Math.floor((sorted.length - 1) * 0.7)]);
  const lo = Math.min(0.5, sorted[Math.floor((sorted.length - 1) * 0.3)]);
  return raw.map((x, j) => {
    const e = es[j];
    let type = e >= hi ? 'chorus' : e <= lo ? 'calm' : 'verse';
    if (raw.length > 2 && j === 0 && type !== 'chorus') type = 'intro';
    if (raw.length > 2 && j === raw.length - 1 && type !== 'chorus') type = 'outro';
    return { start: x.b0 === 0 ? 0 : B[bars[x.b0]], end: x.b1 >= nb ? dur : B[bars[x.b1]], type, energy: CR.round(e, 2) };
  });
};

/** 구간마다 쓰는 컷 길이(박자) 묶음 — 사람이 편집할 때처럼 길고 짧은 컷을 섞어요 */
CR.PATTERNS = {
  intro: [[8], [8, 4, 4], [4, 4, 8], [8, 8]],
  verse: [[4, 4, 2, 2, 4], [4, 2, 2, 4, 4], [4, 4, 8], [2, 2, 4, 8], [4, 4, 4, 2, 2]],
  chorus: [[2, 2, 2, 2, 4], [2, 2, 4, 2, 2, 4], [1, 1, 2, 2, 2, 4], [4, 2, 2, 1, 1, 2], [2, 1, 1, 2, 2, 4]],
  calm: [[8, 8], [8, 4, 4], [4, 8, 4]],
  outro: [[4, 4, 8], [8, 8], [4, 8]],
};

/**
 * 사진 n장을 음악 흐름에 맞춰 나눠요 (1.2: 구간별 리듬 · 몰아치기 · 마무리).
 * 돌려주는 값: {bounds: [0, …, end] (컷 수 + 1), shots: [{t0, t1, sec, burst}], sections, end, beatLen, note, used}
 */
CR.arrange = function (n, ana, opt, rnd) {
  rnd = rnd || CR.rng(opt.seed || 7);
  const dur = ana.duration || 0;
  let beats = (ana.beats || []).filter((b) => b > 0.3 && b < dur - 0.2);
  if (beats.length < 4) { beats = []; for (let t = 0.6; t < dur - 0.2; t += 0.6) beats.push(t); }
  const gaps = beats.slice(1).map((b, i) => b - beats[i]).sort((x, y) => x - y);
  const beatLen = gaps.length ? gaps[gaps.length >> 1] : 0.6;
  const scale = { calm: 2, normal: 1, upbeat: 0.5 }[opt.mood] || 1;
  const minSeg = 0.35, maxSeg = 10;
  let sections = CR.sections(Object.assign({}, ana, { duration: dur }));
  let note = '';
  const grid = [0].concat(beats).concat([dur]);
  const idxAt = (t) => { let best = 0; grid.forEach((g, i) => { if (Math.abs(g - t) < Math.abs(grid[best] - t)) best = i; }); return best; };

  // 1) 자연스러운 컷: 구간마다 그 구간다운 묶음을 골라 채워요
  const natural = () => {
    const shots = [];
    sections.forEach((sec, si) => {
      const i0 = idxAt(sec.start), i1 = idxAt(sec.end);
      let i = i0;
      let pats = CR.PATTERNS[sec.type] || CR.PATTERNS.verse;
      while (i < i1) {
        const pat = pats[Math.floor(rnd() * pats.length)];
        for (const L0 of pat) {
          if (i >= i1) break;
          const L = Math.max(1, Math.round(L0 * scale));
          let j = Math.min(i1, i + L);
          if (i1 - j > 0 && i1 - j < 1) j = i1;
          shots.push({ i0: i, i1: j, sec: sec.type, si, burst: L <= 1 && sec.type === 'chorus' });
          i = j;
        }
      }
    });
    return shots.map((x) => ({ t0: grid[x.i0], t1: grid[x.i1], sec: x.sec, si: x.si, burst: x.burst }));
  };
  let shots = natural();
  const len = (x) => x.t1 - x.t0;

  if (opt.length === 'photos' && shots.length >= n) {
    // 사진 수에 맞춰: 사진이 끝나는 곳에서 마디에 맞춰 끝내요
    shots = shots.slice(0, n);
    const end = shots[n - 1].t1;
    if (end < dur - 0.5) { sections = sections.filter((x) => x.start < end).map((x) => Object.assign({}, x, { end: Math.min(x.end, end) })); note = 'photos'; }
  } else if (opt.length === 'photos') note = 'fit';

  // 사진이 너무 적으면 한 장이 maxSeg 를 넘지 않게, 구간 경계에서 영상을 줄여요
  if (shots.length > n && dur / n > maxSeg) {
    const want = n * 6;
    const cutAt = (sections.find((x) => x.end >= want) || sections[sections.length - 1]).end;
    sections = sections.filter((x) => x.start < cutAt).map((x) => Object.assign({}, x, { end: Math.min(x.end, cutAt) }));
    const last = sections[sections.length - 1]; if (last && last.type !== 'chorus') last.type = 'outro';
    shots = shots.filter((x) => x.t0 < cutAt - 0.2).map((x) => Object.assign({}, x, { t1: Math.min(x.t1, cutAt) }));
    shots[shots.length - 1].t1 = cutAt;
    note = 'short';
  }

  // 2) 사진 수에 맞추기 — 구간마다 원래 컷 수의 비율대로 사진을 나눠 줘서, 절정은 늘 더 빠르고 도입 · 마무리는 느리게 남아요
  const secW = { chorus: 1.3, verse: 1, intro: 0.7, calm: 0.7, outro: 0.7 };
  const mergeAt = (k) => { shots[k] = { t0: shots[k].t0, t1: shots[k + 1].t1, sec: shots[k].sec, si: shots[k].si, burst: false }; shots.splice(k + 1, 1); };
  const splitAt = (k) => {
    const x = shots[k], mid = (x.t0 + x.t1) / 2;
    let cut = null;
    beats.forEach((b) => { if (b > x.t0 + minSeg && b < x.t1 - minSeg && (cut === null || Math.abs(b - mid) < Math.abs(cut - mid))) cut = b; });
    if (cut === null) cut = mid;
    const burst = x.sec === 'chorus' && (x.t1 - x.t0) <= beatLen * 1.6;
    shots.splice(k, 1, { t0: x.t0, t1: cut, sec: x.sec, si: x.si, burst }, { t0: cut, t1: x.t1, sec: x.sec, si: x.si, burst });
  };
  const ids = [...new Set(shots.map((x) => x.si))];
  if (shots.length !== n && n >= ids.length) {
    const N0 = shots.length;
    const cnt = ids.map((si) => shots.filter((x) => x.si === si).length);
    const raw = cnt.map((c) => (c * n) / N0);
    const q = raw.map((r) => Math.max(1, Math.floor(r)));
    let rem = n - q.reduce((a, b) => a + b, 0);
    const order = raw.map((r, j) => [r - Math.floor(r), j]).sort((a, b) => b[0] - a[0]);
    for (let k = 0; rem > 0; k = (k + 1) % order.length) { q[order[k][1]]++; rem--; }
    while (rem < 0) { let j = q.indexOf(Math.max(...q)); if (q[j] <= 1) break; q[j]--; rem++; }
    ids.forEach((si, j) => {
      for (let guard = 0; guard < 2000; guard++) {
        const idx = shots.map((x, k) => (x.si === si ? k : -1)).filter((k) => k >= 0);
        if (idx.length === q[j]) break;
        if (idx.length > q[j]) {
          let best = -1, bc = 1e9;
          for (const k of idx) if (k + 1 < shots.length && shots[k + 1].si === si) { const c = len(shots[k]) + len(shots[k + 1]) + rnd() * 0.01; if (c < bc) { bc = c; best = k; } }
          if (best < 0) break;
          mergeAt(best);
        } else {
          let best = -1, bl = 0;
          for (const k of idx) if (len(shots[k]) >= 2 * minSeg && len(shots[k]) > bl) { bl = len(shots[k]); best = k; }
          if (best < 0) break;
          splitAt(best);
        }
      }
    });
  }
  while (shots.length > n) {
    let best = -1, bc = 1e9;
    for (let k = 0; k + 1 < shots.length; k++) {
      const same = shots[k].sec === shots[k + 1].sec ? 1 : 1.6;
      const c = (len(shots[k]) + len(shots[k + 1])) * same * (shots[k].sec === 'chorus' ? 1.25 : 1) + rnd() * 0.01;
      if (c < bc) { bc = c; best = k; }
    }
    mergeAt(best);
  }
  while (shots.length < n) {
    let best = -1, bs = 0;
    shots.forEach((x, k) => { const sc = len(x) * (secW[x.sec] || 1); if (len(x) >= 2 * minSeg && sc > bs) { bs = sc; best = k; } });
    if (best < 0) break;
    splitAt(best); // 박자 위에서 나눠요 (가운데에 가장 가까운 박자, 없으면 반 박자)
  }
  const used = shots.length;
  if (used < n) note = 'many';
  const end = shots.length ? shots[shots.length - 1].t1 : dur;
  return { bounds: [0].concat(shots.map((x) => CR.round(x.t1, 3))), shots, sections, end: CR.round(end, 3), beatLen, note, used };
};

/** 넘기기 종류 묶음: 부드럽게(쉬어 가는 곳) · 보통(전개) · 힘차게(절정에 들어갈 때) */
CR.TRANS_KIND = { dissolve: 'soft', blur: 'soft', fadeblack: 'soft', slide: 'medium', wipe: 'medium', circle: 'medium', blinds: 'medium', flash: 'punch', zoom: 'punch', spin: 'punch' };

/**
 * 컷마다 움직임 · 넘기기를 정해요 (사람 편집처럼):
 *  - 같은 구간 안은 대부분 바로 넘어가고(컷), 구간이 바뀌는 곳에만 눈에 띄는 넘기기
 *  - 절정에 들어갈 때는 힘찬 넘기기(번쩍 · 확대 · 빙글), 쉬어 가는 곳 · 마무리로 갈 때는 부드럽게 길게
 *  - 움직임은 방향을 번갈아(왼→오 다음엔 오→왼이나 확대), 세로 사진은 위아래 · 확대, 짧은 몰아치기 컷은 멈추거나 툭 확대
 *  - 첫 컷은 천천히 확대, 마지막 컷은 천천히 축소하며 끝나요
 */
CR.planEffects = function (shots, photos, st, rnd) {
  const motions = st.motions || [], trans = st.trans || [];
  const out = shots.map(() => ({ motion: 'none', amt: 1, trans: null, tdur: 0 }));
  const has = (m) => motions.includes(m);
  const opposite = { panL: 'panR', panR: 'panL', up: 'down', down: 'up', zoomIn: 'zoomOut', zoomOut: 'zoomIn' };
  let prev = null;
  const beatLen = st.beatLen || 0.55;
  shots.forEach((x, k) => {
    const L = x.t1 - x.t0;
    const ph = photos[k] || {};
    const portrait = ph.height > ph.width;
    const o = out[k];
    o.amt = { intro: 0.7, calm: 0.7, outro: 0.75, verse: 1, chorus: 1.25 }[x.sec] || 1;
    if (!motions.length) { o.motion = 'none'; return; }
    if (x.burst || L < 0.7) {
      // 몰아치기: 멈춤과 툭 확대를 번갈아
      o.motion = prev === 'zoomIn' || !has('zoomIn') ? 'none' : 'zoomIn';
      o.amt = 1.6;
    } else {
      let cand = motions.filter((m) => m !== prev);
      if (portrait) { const pv = cand.filter((m) => m === 'up' || m === 'down' || m === 'zoomIn' || m === 'zoomOut'); if (pv.length) cand = pv; }
      else { const pv = cand.filter((m) => m !== 'up' && m !== 'down'); if (pv.length) cand = pv; }
      if (prev && opposite[prev] && cand.includes(opposite[prev]) && rnd() < 0.55) o.motion = opposite[prev];
      else o.motion = cand.length ? cand[Math.floor(rnd() * cand.length)] : motions[0];
    }
    if (k === 0 && has('zoomIn')) { o.motion = 'zoomIn'; o.amt = 0.8; }
    if (k === shots.length - 1 && has('zoomOut')) { o.motion = 'zoomOut'; o.amt = 0.8; }
    prev = o.motion;
  });
  if (!trans.length) return out;
  const pickKind = (kind, prevT) => {
    let list = trans.filter((t) => CR.TRANS_KIND[t] === kind);
    if (!list.length) list = trans.filter((t) => t !== 'fadeblack' || kind === 'soft');
    if (!list.length) list = trans;
    const l2 = list.filter((t) => t !== prevT);
    const L = l2.length ? l2 : list;
    return L[Math.floor(rnd() * L.length)];
  };
  let prevT = null;
  for (let k = 0; k + 1 < shots.length; k++) {
    const a = shots[k], b = shots[k + 1];
    const lim = Math.min(a.t1 - a.t0, b.t1 - b.t0) / 1.6;
    let kind = null;
    if (a.sec !== b.sec) kind = b.sec === 'chorus' ? 'punch' : (b.sec === 'calm' || b.sec === 'outro') ? 'soft' : 'medium';
    else if (a.burst || b.burst) kind = null;
    else if (a.sec === 'chorus') kind = rnd() < 0.15 ? 'punch' : null;
    else if (a.sec === 'verse') kind = rnd() < 0.35 ? 'medium' : null;
    else kind = rnd() < 0.75 ? 'soft' : null;
    if (st.mood === 'calm' && !kind && rnd() < 0.5) kind = 'soft';
    if (!kind) continue;
    let ty = pickKind(kind, prevT);
    if (ty === 'fadeblack' && a.sec === b.sec) ty = pickKind('soft', 'fadeblack');
    const want = kind === 'soft' ? CR.clamp(beatLen * (b.sec === 'calm' || b.sec === 'outro' ? 2 : 1.5), 0.4, 1.6)
      : kind === 'medium' ? CR.clamp(beatLen, 0.3, 0.9) : CR.clamp(beatLen * 0.5, 0.2, 0.45);
    const d = Math.min(want, lim);
    if (d < 0.18) continue;
    out[k].trans = ty; out[k].tdur = CR.round(d, 3);
    prevT = ty;
  }
  return out;
};

/**
 * 사진(probe 결과) + 음악으로 새 프로젝트를 만들어요.
 * st = {photos, music, ana, style, motions, trans, color, beat, bgBlur, frame, mood, order, length, aspect, titleOn, title, dates, seed}
 */
CR.buildAuto = function (st) {
  const rnd = CR.rng(st.seed || 1);
  let photos = st.photos.slice();
  if (st.order === 'date') photos.sort((a, b) => (a.taken || 0) - (b.taken || 0) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  else if (st.order === 'name') photos.sort((a, b) => a.path.localeCompare(b.path, 'ko', { numeric: true }));
  else { for (let i = photos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [photos[i], photos[j]] = [photos[j], photos[i]]; } }
  const A = CR.arrange(photos.length, st.ana, { mood: st.mood, length: st.length }, CR.rng(st.seed || 1)); // 만들기 창 미리보기와 같은 컷
  if (A.used < photos.length) {
    // 사진이 너무 많으면 고르게 골라 써요 (순서는 그대로)
    const pick = [];
    for (let k = 0; k < A.used; k++) pick.push(photos[Math.floor(k * photos.length / A.used)]);
    photos = pick;
  }
  const n = photos.length;
  const segs = A.shots.map((x) => x.t1 - x.t0);
  const fx = CR.planEffects(A.shots, photos, Object.assign({}, st, { beatLen: A.beatLen }), rnd);
  const P = CR.newProject();
  P.name = (st.titleOn && st.title.trim()) || st.folderName || '사진 영상';
  P.aspect = st.aspect; P.fit = 'fit';
  P.bgBlur = !!st.bgBlur; P.photoFrame = !!st.frame;
  P.beatFx = { pulse: st.beat.includes('pulse'), flash: st.beat.includes('flash'), shake: st.beat.includes('shake') };
  P.auto = { v: 2, folder: st.folder, folderName: st.folderName, music: st.music.path, style: st.style, mood: st.mood, order: st.order, length: st.length,
    motions: st.motions, trans: st.trans, color: st.color, beat: st.beat, seed: st.seed, note: A.note, total: st.photos.length };
  photos.forEach((ph) => {
    const m = { id: 'm' + CR.uid(), path: ph.path };
    CR.applyProbe(m, ph);
    P.media.push(m);
  });
  const mm = { id: 'm' + CR.uid(), path: st.music.path };
  CR.applyProbe(mm, st.music);
  P.media.push(mm);
  // 클립 길이 = 컷 + 앞뒤 넘기기의 절반 (넘기기가 박자 경계 가운데에 오게)
  photos.forEach((ph, i) => {
    const before = i > 0 ? fx[i - 1].tdur : 0;
    const d = segs[i] + before / 2 + fx[i].tdur / 2;
    const c = CR.appendClipTo(P, P.media[i], d);
    c.motion = fx[i].motion; c.motionAmt = fx[i].amt;
    c.filter = st.color || 'none';
    c.role = { sec: A.shots[i].sec, burst: !!A.shots[i].burst };
    if (fx[i].trans) c.trans = { type: fx[i].trans, dur: fx[i].tdur };
    if (st.dates && ph.taken) {
      const dt = new Date(ph.taken);
      P.texts.push({ id: 't' + CR.uid(), kind: 'caption', text: dt.getFullYear() + '. ' + (dt.getMonth() + 1) + '. ' + dt.getDate() + '.',
        start: CR.round(A.bounds[i], 2), end: CR.round(A.bounds[i + 1], 2), pos: 'br', size: 's', box: false });
    }
  });
  if (n) { P.clips[0].fadeIn = CR.round(Math.min(0.8, segs[0] / 3), 2); P.clips[n - 1].fadeOut = CR.round(Math.min(2, segs[n - 1] / 2), 2); }
  if (st.titleOn && st.title.trim()) {
    // 제목은 도입 구간 동안 (길어야 5초)
    const intro = A.sections[0];
    const e = intro && intro.type === 'intro' ? Math.min(intro.end, 5) : (A.bounds.find((b) => b >= 2.5) || 3);
    P.texts.unshift({ id: 't' + CR.uid(), kind: 'title', text: st.title.trim(), start: 0, end: CR.round(Math.min(e, 5, A.end), 2), pos: 'center', size: 'l', box: false });
  }
  const musicEnd = Math.min(st.music.duration, A.end);
  const cutEarly = musicEnd < st.music.duration - 0.5;
  P.audio.push({ id: 'a' + CR.uid(), mediaId: mm.id, start: 0, in: 0, out: CR.round(musicEnd, 3), volume: 0.8, fadeIn: 0,
    fadeOut: cutEarly ? CR.round(Math.min(3, A.beatLen * 8), 2) : 1.5,
    beats: { bpm: st.ana.bpm, beats: st.ana.beats, downbeats: st.ana.downbeats, energy: st.ana.energy, climax: st.ana.climax, sections: A.sections } });
  P.thumb = photos[0] && photos[0].thumb;
  return { P, segs, A, trans: fx.map((x) => x.tdur) };
};

CR.appendClipTo = function (P, m, dur) {
  const c = { id: 'c' + CR.uid(), mediaId: m.id, in: 0, out: CR.round(dur, 3), speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, blur: 0, rotate: 0,
    motion: 'none', filter: 'none', trans: null };
  P.clips.push(c);
  return c;
};

/** 같은 컷으로 움직임 · 넘기기만 새로 뽑아요 (구간 흐름은 그대로) */
CR.reshuffle = function () {
  const a = CR.P && CR.P.auto;
  if (!a) return;
  const rnd = CR.rng((Date.now() & 0xffffff) + 7);
  const L = CR.layout();
  const clips = L.list;
  const shots = [], photos = [];
  clips.forEach((c, i) => {
    const t0 = L.starts[i] + (i > 0 ? L.trans[i - 1] / 2 : 0), t1 = L.end(i) - L.trans[i] / 2;
    const role = c.role || { sec: 'verse', burst: false };
    shots.push({ t0, t1, sec: role.sec, burst: role.burst });
    const m = CR.media(c.mediaId) || {};
    photos.push({ width: m.width, height: m.height });
  });
  const TB = CR.timelineBeats();
  const g = TB.beats.slice(1).map((b, i) => b - TB.beats[i]).sort((x, y) => x - y);
  const fx = CR.planEffects(shots, photos, { motions: a.motions, trans: a.trans, mood: a.mood, beatLen: g.length ? g[g.length >> 1] : 0.55 }, rnd);
  CR.edit('효과 다시 섞기', () => {
    // 컷 위치를 그대로 두려고, 넘기기 길이가 바뀐 만큼 클립 길이를 맞춰요
    clips.forEach((c, i) => {
      const before = i > 0 ? fx[i - 1].tdur : 0;
      c.out = CR.round(c.in + (shots[i].t1 - shots[i].t0) * (c.speed || 1) + (before / 2 + fx[i].tdur / 2) * (c.speed || 1), 3);
      c.motion = fx[i].motion; c.motionAmt = fx[i].amt;
      c.trans = fx[i].trans ? { type: fx[i].trans, dur: fx[i].tdur } : null;
    });
  });
  CR.toast('같은 흐름으로 움직임 · 넘기기를 새로 골랐어요', { action: CR.undo });
};
