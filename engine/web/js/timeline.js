// CUTROAD — 타임라인 (전체 편집) · 필름 띠 (컷 편집만)
// made by. Nevertheless_D
'use strict';

CR.TL = { el: null, scroll: null, inner: null, head: null, ph: null };

// 끌면서 바꾸기: 시작할 때 모습을 기억했다가, 끝나면 '되돌리기' 한 번으로 묶어요
CR.live = {
  begin() { this.before = CR.snapshot(); },
  end(label) {
    if (!this.before) return;
    const b = this.before;
    this.before = null;
    if (CR.snapshot() === b) return CR.render('timeline');
    CR.hist.undo.push({ label, data: b });
    CR.hist.redo = [];
    CR.changed();
  },
};

CR.ppsFor = function (width, total) {
  return CR.clamp((width - 60) / Math.max(total, 8), 1, 400);
};

/** 확대 막대: 0(전체가 한눈에) ~ 100(1초 = 200px) */
CR.zoomToPps = function (v, fit) { return fit * Math.pow(Math.max(1.0001, 200 / fit), v / 100); };
CR.ppsToZoom = function (pps, fit) { return CR.clamp(Math.log(pps / fit) / Math.log(Math.max(1.0001, 200 / fit)) * 100, 0, 100); };

function tickStep(pps) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s * pps >= 64) return s;
  return 1200;
}

function snapTo(t, pps, except) {
  const L = CR.layout();
  const pts = [CR.S.t, 0, L.total].concat(L.quick ? [] : CR.timelineBeats().beats);
  L.list.forEach((c, i) => { pts.push(L.starts[i], L.end(i)); });
  CR.P.audio.forEach((a) => { if (a.id !== except) pts.push(a.start, a.start + a.out - a.in); });
  CR.P.texts.forEach((x) => { if (x.id !== except) pts.push(x.start, x.end); });
  let best = t, bd = 7 / pps;
  pts.forEach((p) => { if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; } });
  return best;
}

/** 끌기 도우미: 누른 곳에서 얼마나 움직였는지(초)를 알려 줘요 */
function drag(e, pps, onMove, onUp) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  let moved = false;
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    onMove(dx / pps, ev);
  };
  const up = (ev) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    onUp && onUp(moved, ev);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function drawWave(canvas, w, hgt, peaks, per, srcIn, speed, pps, gain, color) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.min(Math.ceil(w), 12000);
  canvas.width = Math.max(1, Math.floor(cw * dpr));
  canvas.height = Math.floor(hgt * dpr);
  canvas.style.width = cw + 'px';
  canvas.style.height = hgt + 'px';
  if (!peaks || !peaks.length) return;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.strokeStyle = color;
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.beginPath();
  const mid = hgt / 2, amp = hgt / 2 - 5;
  const scale = w / cw;
  for (let x = 3; x < cw - 2; x += 3) {
    const t0 = srcIn + (x * scale) / pps * speed, t1 = srcIn + ((x + 3) * scale) / pps * speed;
    let a = Math.floor(t0 * per), b = Math.max(a + 1, Math.floor(t1 * per));
    let pk = 0;
    for (let k = a; k < b && k < peaks.length; k++) if (peaks[k] > pk) pk = peaks[k];
    const y = Math.max(0.6, Math.min(1, Math.pow(pk, 0.7) * gain) * amp);
    g.moveTo(x, mid - y);
    g.lineTo(x, mid + y);
  }
  g.stroke();
}

function envSVG(w, hgt, d, fadeIn, fadeOut, pps) {
  if (fadeIn <= 0 && fadeOut <= 0) return null;
  let a = fadeIn, b = fadeOut;
  if (a + b > d) { const k = d / (a + b); a *= k; b *= k; }
  const svg = h('svg:svg', { class: 'env', width: w, height: hgt, viewBox: '0 0 ' + w + ' ' + hgt });
  const top = 8, bot = hgt - 4;
  const pts = [[1, a > 0 ? bot : top], [a * pps, top], [w - b * pps, top], [w - 1, b > 0 ? bot : top]];
  svg.appendChild(h('polyline:svg', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: 'var(--text)', 'stroke-width': '1.5', opacity: '.85' }));
  if (a > 0) svg.appendChild(h('circle:svg', { cx: a * pps, cy: top, r: 3.5, fill: 'var(--text)' }));
  if (b > 0) svg.appendChild(h('circle:svg', { cx: w - b * pps, cy: top, r: 3.5, fill: 'var(--text)' }));
  return svg;
}

function stripTiles(c, m, width, height, pps, speed) {
  const th = m && CR.cache.thumbs[m.path];
  const asp = (th && th.aspect) || (m && m.width && m.height ? m.width / m.height : 16 / 9);
  const tw = Math.max(24, Math.round(height * asp));
  const n = Math.max(1, Math.min(200, Math.ceil(width / (tw + 2))));
  const out = [];
  for (let k = 0; k < n; k++) {
    let style = { width: tw + 'px' };
    if (th && th.frames && th.frames.length && th.interval) {
      const src = c.in + ((k * (tw + 2) + tw / 2) / pps) * speed;
      const idx = CR.clamp(Math.floor(src / th.interval), 0, th.frames.length - 1);
      if (th.frames[idx]) style.backgroundImage = 'url(' + th.frames[idx] + ')';
    }
    out.push(h('div', { style }));
  }
  return out;
}

// ---------------------------------------------------------------- 전체 편집 타임라인

CR.renderTimeline = function (host) {
  const P = CR.P;
  const L = CR.layout();
  const keep = CR.TL.scroll ? CR.TL.scroll.scrollLeft : 0;
  const tl = host || CR.TL.el;
  if (!tl) return;
  tl.innerHTML = '';
  CR.TL.el = tl;

  const sel = CR.S.sel;
  const bar = h('div', { class: 'tlbar' },
    h('button', { class: 't', title: CR.T('자르기 (⌘B)'), onclick: () => CR.split() }, I('scissors'), '자르기 ', h('span', { class: 'kbd' }, CR.T('⌘B'))),
    h('button', { class: 't', title: '선택한 클립 뒤에 트랜지션 넣기', onclick: () => CR.addTransHere() }, I('trans'), '트랜지션'),
    h('button', { class: 't' + (CR.S.silences ? ' on' : ''), title: '말소리가 없는 부분 찾기', onclick: () => CR.toggleSilences() }, I('silence'), '무음 구간 찾기'),
    h('button', { class: 't', title: CR.T('선택한 것 지우기 (⌫)'), onclick: () => CR.deleteSel(), disabled: !sel }, I('trash'), '지우기'),
    h('div', { class: 'grow' }),
    h('span', { class: 'zoomlab' }, '확대'),
    (() => {
      const r = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': '타임라인 확대' });
      r.value = CR.S.zoomFit ? 0 : CR.ppsToZoom(CR.S.pps, CR.S.fitPps || CR.S.pps);
      r.addEventListener('input', () => {
        const fit = CR.S.fitPps || CR.S.pps;
        const v = +r.value;
        CR.S.zoomFit = v === 0;
        const center = CR.S.t;
        CR.S.pps = CR.zoomToPps(v, fit);
        CR.renderTimeline();
        const sc = CR.TL.scroll;
        if (sc) sc.scrollLeft = Math.max(0, center * CR.S.pps + 8 - sc.clientWidth / 2);
      });
      return r;
    })());

  const heads = h('div', { class: 'tlheads' },
    h('div', { class: 'tlhead', style: { height: '30px' } }, h('i', { style: { background: 'var(--tLine)' } }), '자막 · 텍스트'),
    h('div', { class: 'tlhead', style: { height: '62px' } }, h('i', { style: { background: 'var(--vLine)' } }), '영상'),
    h('div', { class: 'tlhead', style: { height: '44px' } }, h('i', { style: { background: 'var(--aWave)' } }), '영상 소리'),
    CR.timelineBeats().beats.length ? h('div', { class: 'tlhead', style: { height: '18px' } }, h('i', { style: { background: 'var(--accent)' } }), '박자') : null,
    h('div', { class: 'tlhead', style: { height: '44px' } }, h('i', { style: { background: 'var(--bWave)' } }), '배경음악'));

  const scroll = h('div', { class: 'tlscroll' });
  const body = h('div', { class: 'tlbody' }, heads, scroll);
  tl.append(bar, body);
  CR.TL.scroll = scroll;

  // 확대 정도
  const viewW = scroll.clientWidth || (tl.clientWidth - 96) || 1000;
  CR.S.fitPps = CR.ppsFor(viewW, L.total);
  if (CR.S.zoomFit) CR.S.pps = CR.S.fitPps;
  const pps = CR.S.pps;
  const innerW = Math.max(viewW, L.total * pps + 48);
  const inner = h('div', { class: 'tlinner', style: { width: innerW + 'px' } });
  scroll.appendChild(inner);
  CR.TL.inner = inner;
  const X = (t) => t * pps;

  // 눈금
  const ruler = h('div', { class: 'ruler' });
  const step = tickStep(pps);
  const minor = step / 5;
  const maxT = (innerW - 8) / pps;
  for (let t = 0; t <= maxT; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ruler.appendChild(h('div', { class: 'tick', style: { left: X(t) + 'px', height: (major ? 10 : 5) + 'px' } }));
    if (major) ruler.appendChild(h('span', { class: 'lab', style: { left: X(t) + 4 + 'px' } }, step < 1 ? CR.shortD(t) : CR.short(t)));
  }
  ruler.addEventListener('pointerdown', (e) => {
    const rect = inner.getBoundingClientRect();
    const seekTo = (ev) => CR.Player.seek((ev.clientX - rect.left - 8) / pps);
    seekTo(e);
    const mv = (ev) => seekTo(ev);
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  });
  inner.appendChild(ruler);

  const laneClick = (e) => {
    if (e.target !== e.currentTarget) return;
    const rect = inner.getBoundingClientRect();
    CR.Player.seek((e.clientX - rect.left - 8) / pps);
    CR.select(null);
  };

  // 글자 줄
  const tText = h('div', { class: 'track text', onpointerdown: laneClick });
  P.texts.slice().sort((a, b) => a.start - b.start).forEach((x) => {
    const isSel = sel && sel.type === 'text' && sel.id === x.id;
    const blk = h('div', { class: 'tblock' + (x.kind === 'title' ? ' title' : '') + (isSel ? ' sel' : ''),
      style: { left: X(x.start) + 'px', width: Math.max(6, X(x.end - x.start)) + 'px' }, title: x.text },
      x.text, h('div', { class: 'h l' }), h('div', { class: 'h r' }));
    blk.addEventListener('pointerdown', (e) => {
      CR.select('text', x.id);
      const side = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : '';
      const o = { start: x.start, end: x.end };
      CR.live.begin();
      drag(e, pps, (dt) => {
        const total = CR.total();
        if (side === 'l') x.start = CR.round(CR.clamp(snapTo(o.start + dt, pps, x.id), 0, x.end - 0.2), 2);
        else if (side === 'r') x.end = CR.round(CR.clamp(snapTo(o.end + dt, pps, x.id), x.start + 0.2, Math.max(total, x.start + 0.2)), 2);
        else {
          const len = o.end - o.start;
          const s = CR.clamp(snapTo(o.start + dt, pps, x.id), 0, Math.max(0, total - len));
          x.start = CR.round(s, 2); x.end = CR.round(s + len, 2);
        }
        CR.renderTimeline(); CR.Player.apply();
      }, (moved) => { if (moved) CR.live.end('글자 옮기기'); else { CR.live.before = null; CR.render('select'); } });
    });
    blk.addEventListener('dblclick', () => { CR.select('text', x.id); setTimeout(() => { const ta = document.querySelector('.inspector textarea'); if (ta) { ta.focus(); ta.select(); } }, 30); });
    tText.appendChild(blk);
  });

  // 영상 줄
  const tVid = h('div', { class: 'track video', onpointerdown: laneClick });
  const tAud = h('div', { class: 'track audio', onpointerdown: laneClick });
  L.list.forEach((c, i) => {
    const m = CR.media(c.mediaId);
    const left = X(L.starts[i]), w = Math.max(4, X(CR.dur(c)));
    const isSel = sel && sel.type === 'clip' && sel.id === c.id;
    const fx = [];
    if (c.speed !== 1) fx.push(c.speed + '×');
    if (c.blur > 0) fx.push('블러');
    if (c.filter && c.filter !== 'none') fx.push((CR.FILTER_NAMES.find((f) => f[0] === c.filter) || ['', ''])[1]);
    if (c.rotate) fx.push(c.rotate + '°');
    const clip = h('div', { class: 'clip' + (isSel ? ' sel' : '') + (m && m.missing ? ' missing' : ''), style: { left: left + 'px', width: w + 'px' },
      'data-id': c.id, title: m ? m.name : '' },
      h('div', { class: 'cap' }, h('span', null, (m ? m.name.replace(/\.[^.]+$/, '') : '?'), fx.length ? ' ' : '', fx.map((f) => h('span', { class: 'fx' }, f))),
        h('span', null, CR.short(CR.dur(c)))),
      h('div', { class: 'strip' }, stripTiles(c, m, w, 37, pps, c.speed)),
      h('div', { class: 'h l', title: '앞부분 자르기' }), h('div', { class: 'h r', title: '뒷부분 자르기' }));
    clip.addEventListener('pointerdown', (e) => {
      CR.select('clip', c.id);
      const side = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : '';
      if (side) {
        const o = { in: c.in, out: c.out };
        CR.live.begin();
        drag(e, pps, (dt) => {
          const md = m ? m.duration : c.out;
          if (side === 'l') c.in = CR.round(CR.clamp(o.in + dt * c.speed, 0, c.out - 0.1), 3);
          else {
            let out = CR.clamp(o.out + dt * c.speed, c.in + 0.1, md);
            // 끝을 끌면 가까운 박자에 붙어요
            const st = L.starts[i], e = st + (out - c.in) / c.speed, sn = snapTo(e, pps, null);
            if (sn !== e && sn > st + 0.1) out = CR.clamp(c.in + (sn - st) * c.speed, c.in + 0.1, md);
            c.out = CR.round(out, 3);
          }
          CR.renderTimeline();
          const L2 = CR.layout(), j = L2.list.indexOf(c);
          CR.Player.seek(side === 'l' ? L2.starts[j] : L2.end(j) - 0.001);
        }, (moved) => { if (moved) CR.live.end('클립 길이 바꾸기'); else CR.live.before = null; });
        return;
      }
      // 순서 바꾸기
      let line = null, to = -1;
      drag(e, pps, () => {
        clip.classList.add('dragging');
      }, (moved, ev) => {
        clip.classList.remove('dragging');
        if (line) line.remove();
        if (moved && to >= 0) CR.moveClip(c.id, to);
        else if (!moved) {
          const rect = inner.getBoundingClientRect();
          CR.Player.seek((ev.clientX - rect.left - 8) / pps);
        }
      });
      const mv = (ev) => {
        const rect = inner.getBoundingClientRect();
        const t = (ev.clientX - rect.left - 8) / pps;
        to = L.list.length;
        for (let k = 0; k < L.list.length; k++) { if (t < L.starts[k] + CR.dur(L.list[k]) / 2) { to = k; break; } }
        const lx = to < L.list.length ? X(L.starts[to]) : X(L.total);
        if (!line) { line = h('div', { class: 'dropline' }); tVid.appendChild(line); }
        line.style.left = lx + 'px';
      };
      addEventListener('pointermove', mv);
      addEventListener('pointerup', () => removeEventListener('pointermove', mv), { once: true });
    });
    tVid.appendChild(clip);

    // 트랜지션 자리 (클립 사이)
    if (i + 1 < L.list.length) {
      const td = L.trans[i];
      const cx = X(L.end(i) - td / 2);
      const has = !!(c.trans && c.trans.type);
      const isT = sel && sel.type === 'trans' && sel.id === c.id;
      const chip = h('button', { class: 'tchip' + (has ? ' on' : '') + (isT ? ' sel' : ''), style: { left: cx + 'px' },
        title: has ? '트랜지션: ' + CR.transName(c.trans.type) : '트랜지션 넣기' }, I('trans'));
      chip.addEventListener('pointerdown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!has) CR.setTrans(c.id, 'dissolve', 0.8);
        CR.select('trans', c.id);
      });
      tVid.appendChild(chip);
    }

    // 영상 소리
    const ab = h('div', { class: 'ablock clipa' + (isSel ? ' sel' : ''), style: { left: left + 'px', width: w + 'px' } });
    const wave = m && CR.cache.waves[m.path];
    if (m && m.hasAudio !== false) {
      const cv = h('canvas');
      drawWave(cv, w, 44, wave && wave.peaks, (wave && wave.perSec) || 50, c.in, c.speed, pps, c.volume, getComputedStyle(document.documentElement).getPropertyValue('--aWave').trim() || '#4FD1C5');
      ab.appendChild(cv);
      const prevT = i > 0 ? L.trans[i - 1] : 0;
      const env = envSVG(w, 44, CR.dur(c), Math.max(c.fadeIn, prevT), Math.max(c.fadeOut, L.trans[i]), pps);
      if (env) ab.appendChild(env);
      if (c.volume === 0) ab.appendChild(h('span', { class: 'nm', style: { color: 'var(--dim)' } }, '소리 끔'));
    } else if (!m || m.kind !== 'image') {
      ab.appendChild(h('span', { class: 'nm', style: { color: 'var(--dim)' } }, '소리 없음'));
    } else ab.style.opacity = '.35';
    ab.addEventListener('pointerdown', (e) => {
      CR.select('clip', c.id);
      const rect = inner.getBoundingClientRect();
      CR.Player.seek((e.clientX - rect.left - 8) / pps);
    });
    tAud.appendChild(ab);
  });

  // 무음 구간 표시
  if (CR.S.silences) {
    CR.S.silences.forEach((s) => {
      tAud.appendChild(h('div', { class: 'silence', style: { left: X(s.ta) + 'px', width: Math.max(4, X(s.tb - s.ta)) + 'px' } },
        X(s.tb - s.ta) > 56 ? h('span', null, '무음 ' + CR.round(s.b - s.a, 1) + '초') : null));
    });
  }

  // 배경음악 줄
  // 박자 줄 (배경음악에 박자 정보가 있으면)
  const TB = CR.timelineBeats();
  let tBeat = null;
  if (TB.beats.length) {
    tBeat = h('div', { class: 'track beats', onpointerdown: laneClick });
    const ds = new Set(TB.down);
    const cuts = new Set(L.list.map((c, i) => Math.round((L.starts[i] + (i > 0 ? L.trans[i - 1] / 2 : 0)) * 100)));
    const minGap = 3 / pps;
    let lastX = -1e9;
    TB.beats.forEach((b) => {
      const x = X(b);
      if (x - lastX < 3) return;
      lastX = x;
      const cut = cuts.has(Math.round(b * 100)) || [...cuts].some((k) => Math.abs(k / 100 - b) < minGap);
      tBeat.appendChild(h('div', { class: 'beat' + (ds.has(b) ? ' down' : '') + (cut ? ' cut' : ''), style: { left: x + 'px' } }));
    });
    if (TB.sections.length) TB.sections.forEach((x) => tBeat.insertBefore(h('div', { class: 'sec ' + x.type, style: { left: X(x.start) + 'px', width: Math.max(2, X(x.end - x.start) - 2) + 'px' }, title: CR.SECTION_NAMES[x.type] },
      X(x.end - x.start) > 40 ? CR.SECTION_NAMES[x.type] : ''), tBeat.firstChild));
    else TB.climax.forEach(([a, b]) => tBeat.appendChild(h('div', { class: 'climax', style: { left: X(a) + 'px', width: X(b - a) + 'px' }, title: '음악이 가장 신나는 부분' })));
  }
  const tBgm = h('div', { class: 'track bgm', onpointerdown: laneClick });
  P.audio.forEach((a) => {
    const m = CR.media(a.mediaId);
    const len = a.out - a.in;
    const w = Math.max(4, X(len));
    const isSel = sel && sel.type === 'audio' && sel.id === a.id;
    const blk = h('div', { class: 'ablock bgm' + (isSel ? ' sel' : ''), style: { left: X(a.start) + 'px', width: w + 'px' }, title: m ? m.name : '' });
    const wave = m && CR.cache.waves[m.path];
    const cv = h('canvas');
    drawWave(cv, w, 44, wave && wave.peaks, (wave && wave.perSec) || 50, a.in, 1, pps, a.volume, getComputedStyle(document.documentElement).getPropertyValue('--bWave').trim() || '#6BD38A');
    blk.appendChild(cv);
    const env = envSVG(w, 44, len, a.fadeIn, a.fadeOut, pps);
    if (env) blk.appendChild(env);
    blk.appendChild(h('span', { class: 'nm', style: { left: Math.max(8, a.fadeIn * pps + 8) + 'px' } }, (m ? m.name : '?') + ' · 볼륨 ' + Math.round(a.volume * 100) + '%'));
    blk.append(h('div', { class: 'h l' }), h('div', { class: 'h r' }));
    if (L.total > 0 && a.start + len > L.total) {
      blk.appendChild(h('div', { style: { position: 'absolute', top: 0, bottom: 0, left: X(L.total - a.start) + 'px', right: 0, background: 'color-mix(in srgb, var(--panel) 65%, transparent)' }, title: '영상이 끝난 뒤라 나오지 않아요' }));
    }
    blk.addEventListener('pointerdown', (e) => {
      CR.select('audio', a.id);
      const side = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : '';
      const o = { start: a.start, in: a.in, out: a.out };
      CR.live.begin();
      drag(e, pps, (dt) => {
        const md = m ? m.duration : o.out;
        if (side === 'l') {
          const d = CR.clamp(dt, -o.in, o.out - o.in - 0.2);
          const d2 = CR.clamp(snapTo(o.start + d, pps, a.id) - o.start, -o.in, o.out - o.in - 0.2);
          a.in = CR.round(o.in + d2, 3); a.start = CR.round(Math.max(0, o.start + d2), 3);
        } else if (side === 'r') {
          a.out = CR.round(CR.clamp(snapTo(o.start + (o.out - o.in) + dt, pps, a.id) - o.start + o.in, o.in + 0.2, md), 3);
        } else {
          a.start = CR.round(Math.max(0, snapTo(o.start + dt, pps, a.id)), 3);
        }
        CR.renderTimeline();
      }, (moved, ev) => {
        if (moved) CR.live.end('배경음악 옮기기');
        else {
          CR.live.before = null;
          const rect = inner.getBoundingClientRect();
          CR.Player.seek((ev.clientX - rect.left - 8) / pps);
        }
      });
    });
    tBgm.appendChild(blk);
  });

  CR.put(inner, tText, tVid, tAud, tBeat, tBgm);
  if (!L.list.length) inner.appendChild(h('div', { class: 'tlempty' }, '영상 파일을 끌어다 놓거나 [가져오기]를 누르세요'));
  const ph = h('div', { class: 'playhead', style: { left: X(CR.S.t) + 8 + 'px' } });
  inner.appendChild(ph);
  CR.TL.ph = ph;

  if (CR.S.silences) {
    const list = CR.S.silences;
    const sec = list.reduce((s, x) => s + (x.b - x.a), 0);
    body.appendChild(h('div', { class: 'silbar' },
      list.length ? h('span', null, '무음 ', h('b', null, list.length + '곳'), ' · 모두 ', h('b', null, CR.round(sec, 1) + '초')) : h('span', null, '1초 넘게 조용한 곳이 없어요'),
      list.length ? h('button', { class: 'btn primary', style: { height: '28px' }, onclick: () => CR.cutSilences(list) }, I('scissors'), '모두 잘라내기') : null,
      h('button', { class: 'btn', style: { height: '28px' }, onclick: () => { CR.S.silences = null; CR.renderTimeline(); } }, '닫기')));
  }

  scroll.scrollLeft = keep;
  scroll.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const fit = CR.S.fitPps;
      const z = CR.clamp(CR.ppsToZoom(CR.S.pps, fit) - e.deltaY * 0.4, 0, 100);
      CR.S.zoomFit = z <= 0.01;
      CR.S.pps = CR.zoomToPps(z, fit);
      CR.renderTimeline();
    }
  }, { passive: false });
};

CR.transName = (t) => (CR.TRANS.find((x) => x[0] === t) || ['', '없음'])[1];

CR.addTransHere = function () {
  const L = CR.layout();
  if (L.quick) return;
  let i = -1;
  const sel = CR.S.sel;
  if (sel && (sel.type === 'clip' || sel.type === 'trans')) i = L.list.findIndex((c) => c.id === sel.id);
  if (i < 0) {
    // 재생 위치에서 가장 가까운 클립 사이
    let best = 1e9;
    for (let k = 0; k + 1 < L.list.length; k++) { const d = Math.abs(L.end(k) - CR.S.t); if (d < best) { best = d; i = k; } }
  }
  if (i < 0 || i + 1 >= L.list.length) return CR.toast('트랜지션은 두 클립 사이에 넣어요. 클립을 2개 이상 놓아 주세요');
  const c = L.list[i];
  if (!c.trans) CR.setTrans(c.id, 'dissolve', 0.8);
  CR.select('trans', c.id);
};

CR.toggleSilences = function () {
  if (CR.S.silences) { CR.S.silences = null; return CR.render('timeline'); }
  const waiting = CR.kept().some((c) => { const m = CR.media(c.mediaId); const w = m && CR.cache.waves[m.path]; return w && w.loading; });
  if (waiting) return CR.toast('소리를 분석하는 중이에요. 잠시 뒤 다시 눌러 주세요');
  CR.S.silences = CR.findSilences();
  CR.render('timeline');
};

CR.onTimeTimeline = function () {
  const pps = CR.S.pps;
  if (CR.TL.ph && CR.TL.ph.isConnected) {
    const x = CR.S.t * pps + 8;
    CR.TL.ph.style.left = x + 'px';
    const sc = CR.TL.scroll;
    if (sc && CR.Player.playing && (x > sc.scrollLeft + sc.clientWidth - 40 || x < sc.scrollLeft)) sc.scrollLeft = x - 60;
  }
  if (CR.Q.ph && CR.Q.ph.isConnected) {
    CR.Q.ph.style.left = CR.S.t * CR.Q.pps + 'px';
  }
};

// ---------------------------------------------------------------- 컷 편집만: 필름 띠

CR.Q = { ph: null, pps: 10 };

CR.renderQuickStrip = function (host) {
  host.innerHTML = '';
  const L = CR.layout();
  const strip = h('div', { class: 'qstrip' });
  host.appendChild(strip);
  const width = (host.clientWidth || 1200) - 4;
  const pps = CR.clamp(width / Math.max(L.total, 4), 2, 400);
  CR.Q.pps = pps;
  const inner = h('div', { class: 'qinner', style: { width: Math.max(width, L.total * pps) + 'px' } });
  strip.appendChild(inner);
  const sel = CR.S.sel;
  L.list.forEach((c, i) => {
    const m = CR.media(c.mediaId);
    const left = L.starts[i] * pps + (i ? 1 : 0), w = Math.max(6, (c.out - c.in) * pps - (i ? 2 : 0));
    const isSel = sel && sel.type === 'clip' && sel.id === c.id;
    const seg = h('div', { class: 'qseg' + (c.removed ? ' removed' : '') + (isSel ? ' sel' : ''), style: { left: left + 'px', width: w + 'px' } },
      stripTiles(c, m, w - 4, 72, pps, 1).map((d) => { d.className = 'f'; return d; }));
    if (c.removed) {
      seg.appendChild(h('div', { class: 'gone' }, w > 90 ? h('b', null, '지운 부분 · ' + CR.short(c.out - c.in)) : null,
        h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); CR.restoreClip(c.id); } }, w > 70 ? '되살리기' : I('restore'))));
    }
    seg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      CR.select('clip', c.id);
      const rect = inner.getBoundingClientRect();
      CR.Player.seek((e.clientX - rect.left) / pps);
    });
    inner.appendChild(seg);
    if (i > 0) inner.appendChild(h('div', { class: 'qcut', style: { left: L.starts[i] * pps + 'px' }, title: '자른 곳' }, I('scissors')));
  });
  if (!L.list.length) inner.appendChild(h('div', { class: 'tlempty', style: { top: '20px', height: '76px', left: 0, right: 0 } }, '영상 파일을 끌어다 놓거나 [가져오기]를 누르세요'));
  inner.addEventListener('pointerdown', (e) => {
    if (e.target !== inner) return;
    const rect = inner.getBoundingClientRect();
    CR.Player.seek((e.clientX - rect.left) / pps);
    const mv = (ev) => CR.Player.seek((ev.clientX - rect.left) / pps);
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
  });
  const ph = h('div', { class: 'qplay', style: { left: CR.S.t * pps + 'px' } });
  inner.appendChild(ph);
  CR.Q.ph = ph;
};
