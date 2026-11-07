// CUTROAD — 미리보기 재생기
// made by. Nevertheless_D
//
// 칸(slot) 두 개를 번갈아 써서 클립과 트랜지션을 이어 보여 줘요. 칸마다 영상(<video>) · 사진(<img>) · 흐린 배경이 있어요.
// 효과(움직임 · 색감 · 블러 · 페이드 · 회전 · 맞춤 · 액자 · 넘기기 10가지 · 박자 효과 · 글자)는
// 내보내기(Render.swift)와 같은 계산 · 같은 순서로 CSS 로 그려요.
//   stage > fx(박자 효과) > slot(넘기기) > look(블러 · 색감 · 페이드) > [흐린 배경, 영상/사진, 필름 가장자리]
'use strict';

CR.Player = {
  playing: false,
  slots: [],
  stage: null,
  txtLayer: null,
  W: 640, H: 360,
  ctx: null,
  nodes: new Map(),
  bgm: new Map(),
  raf: 0,
  last: 0,

  init() {
    for (let k = 0; k < 2; k++) {
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.disablePictureInPicture = true;
      v.className = 'media';
      v.addEventListener('loadedmetadata', () => { v._ready = true; this.apply(); });
      v.addEventListener('seeked', () => { if (!this.playing) this.draw(); });
      v.addEventListener('error', () => { v._ready = false; v._error = true; this.apply(); });
      const img = document.createElement('img');
      img.className = 'media';
      img.decoding = 'async';
      img.addEventListener('load', () => { img._ready = true; img._error = false; this.draw(); });
      img.addEventListener('error', () => { img._ready = false; img._error = true; this.draw(); });
      const bg = document.createElement('img');
      bg.className = 'bgfill';
      const vign = document.createElement('div');
      vign.className = 'vign';
      const look = document.createElement('div');
      look.className = 'look';
      look.append(bg, v, img, vign);
      const el = document.createElement('div');
      el.className = 'slot';
      el.appendChild(look);
      this.slots.push({ el, look, v, img, bg, vign });
    }
    this.fx = document.createElement('div');
    this.fx.className = 'fx';
    this.tflash = document.createElement('div');
    this.tflash.className = 'flashfx';
    this.slots.forEach((s) => this.fx.appendChild(s.el));
    this.fx.appendChild(this.tflash);
    this.bflash = document.createElement('div');
    this.bflash.className = 'flashfx';
  },

  mount(stage, txtLayer) {
    this.stage = stage;
    this.txtLayer = txtLayer;
    stage.insertBefore(this.fx, txtLayer);
    stage.insertBefore(this.bflash, txtLayer);
    this.apply();
  },

  setSize(W, H) { this.W = W; this.H = H; this.apply(); },

  ensureAudio() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ctx = null; }
  },

  gainFor(el) {
    if (!this.ctx) return null;
    let g = this.nodes.get(el);
    if (!g) {
      try {
        const src = this.ctx.createMediaElementSource(el);
        g = this.ctx.createGain();
        src.connect(g).connect(this.bus() || this.ctx.destination);
        this.nodes.set(el, g);
      } catch (e) { return null; }
    }
    return g;
  },

  /** 모든 소리가 모이는 곳: 소리 고르게(오디오 컴프레서) → 보정 → 리미터(-1dB) → 스피커. 내보내기와 같은 값 (CR.AUDIO_COMP) */
  bus() {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (!this.busIn) {
      this.busIn = ctx.createGain();
      this.comp = ctx.createDynamicsCompressor();
      this.makeup = ctx.createGain();
      this.lim = ctx.createDynamicsCompressor();
      this.lim.threshold.value = -1; this.lim.knee.value = 0; this.lim.ratio.value = 20; this.lim.attack.value = 0.001; this.lim.release.value = 0.05;
      this.comp.connect(this.makeup).connect(this.lim).connect(ctx.destination);
      this.busIn.connect(ctx.destination);
      this.busMode = '';
    }
    this.setComp();
    return this.busIn;
  },
  setComp() {
    if (!this.busIn) return;
    const mode = CR.P && !CR.quick() && CR.AUDIO_COMP[CR.P.audioComp] ? CR.P.audioComp : '';
    if (mode === this.busMode) return;
    this.busMode = mode;
    try { this.busIn.disconnect(); } catch (e) { /* 처음 */ }
    if (!mode) { this.busIn.connect(this.ctx.destination); return; }
    const c = CR.AUDIO_COMP[mode];
    this.comp.threshold.value = c.threshold; this.comp.knee.value = 6; this.comp.ratio.value = c.ratio;
    this.comp.attack.value = c.attack; this.comp.release.value = c.release;
    this.makeup.gain.value = Math.pow(10, c.makeup / 20);
    this.busIn.connect(this.comp);
  },

  setVol(el, v) {
    const g = this.gainFor(el);
    if (g) { g.gain.value = v; el.volume = 1; } else el.volume = CR.clamp(v, 0, 1);
  },

  toggle() { this.playing ? this.pause() : this.play(); },

  play() {
    if (!CR.P) return;
    const total = CR.total();
    if (total <= 0) return;
    if (CR.S.t >= total - 0.04) CR.S.t = 0;
    this.ensureAudio();
    this.playing = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const tick = (now) => {
      if (!this.playing) return;
      this.step(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    CR.onPlayState && CR.onPlayState();
  },

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.slots.forEach((s) => { if (!s.v.paused) s.v.pause(); });
    this.bgm.forEach((a) => { if (!a.paused) a.pause(); });
    this.apply();
    CR.onPlayState && CR.onPlayState();
  },

  seek(t) {
    CR.S.t = CR.clamp(t, 0, CR.total());
    this.apply();
    CR.onTime && CR.onTime();
  },

  step(now) {
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const L = CR.layout();
    let t = CR.S.t + dt;
    // 기준 시계: 화면에 나오는 영상이 있으면 그 영상, 사진만 있으면 배경음악.
    // (화면이 잠깐 버벅여도 소리를 억지로 되감지 않고, 화면이 소리를 따라가요 — 1.1.1)
    let clocked = false;
    const i = CR.clipAt(CR.S.t, L);
    if (i >= 0) {
      const c = L.list[i], s = this.slots[i % 2];
      const m = CR.media(c.mediaId);
      const sp = L.quick ? 1 : c.speed;
      if (m && m.kind !== 'image' && s.v._ready && !s.v.paused && !s.v.seeking && s.v.dataset.clip === c.id) {
        const tv = L.starts[i] + (s.v.currentTime - c.in) / sp;
        if (tv > CR.S.t - 0.05 && tv < CR.S.t + 0.3) { t = Math.max(CR.S.t, tv); clocked = true; }
      }
    }
    if (!clocked && !L.quick) {
      const ta = this.bgmClock(CR.S.t);
      if (ta !== null && ta > CR.S.t - 0.6 && ta < CR.S.t + 3) t = ta; // 화면이 멈췄던 만큼 음악을 따라잡아요
    }
    this.clockedByVideo = clocked;
    if (L.quick) {
      const j = CR.clipAt(t, L);
      if (j >= 0 && L.list[j].removed) {
        let k = j;
        while (k < L.list.length && L.list[k].removed) k++;
        t = k < L.list.length ? L.starts[k] : L.total;
      }
    }
    const end = CR.total();
    if (t >= end) {
      CR.S.t = end;
      this.pause();
      CR.onTime && CR.onTime();
      return;
    }
    CR.S.t = t;
    this.apply(L);
    CR.onTime && CR.onTime();
  },

  /** 재생 중인 배경음악이 가리키는 타임라인 시각 (없으면 null) */
  bgmClock(t) {
    if (!CR.P) return null;
    for (const a of CR.P.audio) {
      const el = this.bgm.get(a.id);
      if (!el || el.paused || el.seeking || !el._ready || el.readyState < 3) continue;
      if (t < a.start - 0.05 || t > a.start + (a.out - a.in)) continue;
      return a.start + (el.currentTime - a.in);
    }
    return null;
  },

  /** 지금 시각에 맞춰 영상 · 사진 · 소리 · 글자를 맞춰요 */
  apply(L) {
    if (!this.stage || !CR.P) return;
    this.setComp();
    L = L || CR.layout();
    const t = CR.S.t;
    const playing = this.playing;
    const active = [];
    for (let i = 0; i < L.list.length; i++) {
      if (t >= L.starts[i] - 1e-6 && t < L.end(i) - 1e-6) active.push(i);
    }
    if (!active.length && L.list.length && t >= L.total - 1e-3 && t <= L.total + 1e-3) active.push(L.list.length - 1); // 영상이 끝난 뒤(음악만 계속)는 검은 화면
    const layers = [];
    const used = new Set();
    active.slice(-2).forEach((i) => {
      const c = L.list[i];
      const m = CR.media(c.mediaId);
      const s = this.slots[i % 2];
      used.add(s);
      const sp = L.quick ? 1 : c.speed;
      const target = CR.clamp(c.in + (t - L.starts[i]) * sp, 0, Math.max(0, c.out - 0.001));
      this.load(s, c, m, target, sp, playing);
      layers.push({ i, c, m, s });
    });
    // 다음 클립 미리 준비
    const cur = active.length ? active[active.length - 1] : -1;
    const nx = cur + 1;
    if (nx < L.list.length && L.starts[nx] - t < 2 && !used.has(this.slots[nx % 2])) {
      const c = L.list[nx];
      const s = this.slots[nx % 2];
      this.load(s, c, CR.media(c.mediaId), c.in, 1, false);
      used.add(s);
    }
    this.slots.forEach((s) => {
      if (!layers.find((l) => l.s === s)) {
        s.el.style.visibility = 'hidden';
        if (!s.v.paused) s.v.pause();
        this.setVol(s.v, 0);
      }
    });
    this.layers = layers;
    this.draw(L);
    this.audio(L, playing);
    this.texts(t);
  },

  load(s, c, m, target, rate, playing) {
    s.clip = c.id;
    if (!m || m.missing) return;
    if (m.kind === 'image') {
      if (!s.v.paused) s.v.pause();
      const url = m.preview ? CR.mediaURL(m.preview) : '';
      if (s.img.dataset.url !== url) {
        s.img.dataset.url = url;
        s.img._ready = false; s.img._error = false;
        if (url) s.img.src = url; else s.img.removeAttribute('src');
      }
      return;
    }
    const v = s.v;
    const url = CR.mediaURL(m.path);
    if (v.dataset.url !== url) {
      v.dataset.url = url;
      v._ready = false; v._error = false;
      v.src = url;
    }
    v.dataset.clip = c.id;
    if (!v._ready) return;
    if (playing) {
      if (v.playbackRate !== rate) v.playbackRate = rate;
      const off = Math.abs(v.currentTime - target);
      if (v.paused) {
        if (off > 0.04) v.currentTime = target;
        v.play().catch(() => {});
      } else if (off > 0.3 && !v.seeking) {
        v.currentTime = target;
      }
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - target) > 0.02 && !v.seeking) v.currentTime = target;
    }
  },

  /** 화면 맞춤 (Render.swift layerImage 와 같은 계산) */
  geom(m, c) {
    const W = this.W, H = this.H, quick = CR.quick();
    const w = (m && m.width) || 1920, h = (m && m.height) || 1080;
    const rot = quick ? 0 : (c.rotate || 0);
    const rw = rot % 180 === 90 ? h : w, rh = rot % 180 === 90 ? w : h;
    const fill = !quick && CR.P.fit === 'fill';
    const framed = !quick && m && m.kind === 'image' && CR.P.photoFrame;
    const s = (fill ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh)) * (framed ? 0.86 : 1);
    return { w: w * s, h: h * s, left: (W - w * s) / 2, top: (H - h * s) / 2, rot, framed, fill };
  },

  /** 화면 그리기 */
  draw(L) {
    if (!this.layers) return;
    L = L || CR.layout();
    const t = CR.S.t;
    const quick = L.quick;
    const W = this.W, H = this.H, base = Math.min(W, H);
    let tWhite = 0;
    this.layers.forEach((ly, k) => {
      const { s, c, m, i } = ly;
      const isImg = m && m.kind === 'image';
      const el = isImg ? s.img : s.v;
      const other = isImg ? s.v : s.img;
      other.style.display = 'none';
      el.style.display = 'block';
      const bad = !m || m.missing || el._error;
      s.el.style.visibility = bad ? 'hidden' : 'visible';
      if (bad) return;
      const g = this.geom(m, c);
      // 움직임
      const mo = quick ? { s: 1, dx: 0, dy: 0, rot: 0 } : CR.motion(c.motion, (t - L.starts[i]) / Math.max(1e-3, L.end(i) - L.starts[i]), c.motionAmt);
      const b = g.framed ? 0.012 * base : 0;
      Object.assign(el.style, {
        width: g.w + 'px', height: g.h + 'px', left: (g.left - b) + 'px', top: (g.top - b) + 'px',
        border: b ? b + 'px solid #fff' : 'none',
        transform: 'translate(' + (mo.dx * W) + 'px,' + (mo.dy * H) + 'px) rotate(' + (g.rot + mo.rot) + 'deg) scale(' + mo.s + ')',
      });
      // 흐린 배경 (사진이 화면을 다 채우지 못할 때)
      const bgOn = !quick && isImg && CR.P.bgBlur && !g.fill;
      s.bg.style.display = bgOn ? 'block' : 'none';
      if (bgOn) {
        if (s.bg.dataset.url !== s.img.dataset.url) { s.bg.dataset.url = s.img.dataset.url; s.bg.src = s.img.dataset.url; }
        s.bg.style.filter = 'blur(' + (0.04 * base).toFixed(1) + 'px) brightness(.75)';
      }
      // 블러 · 색감 · 페이드
      const f = [];
      let bright = 1;
      if (!quick) {
        if (c.blur > 0) f.push('blur(' + (c.blur * base / 1080).toFixed(2) + 'px)');
        f.push(CR.cssFilter(c.filter));
        const st = L.starts[i], en = L.end(i);
        if (c.fadeIn > 0 && t < st + c.fadeIn) bright = Math.min(bright, (t - st) / c.fadeIn);
        if (c.fadeOut > 0 && t > en - c.fadeOut) bright = Math.min(bright, (en - t) / c.fadeOut);
      }
      if (bright < 0.999) f.push('brightness(' + CR.clamp(bright, 0, 1).toFixed(3) + ')');
      s.look.style.filter = f.filter(Boolean).join(' ') || 'none';
      s.vign.style.display = !quick && c.filter === 'film' ? 'block' : 'none';
      // 넘기기 (앞 칸 k=0, 뒤 칸 k=1)
      const st = s.el.style;
      st.opacity = '1'; st.transform = 'none'; st.clipPath = 'none'; st.webkitMaskImage = st.maskImage = 'none'; st.filter = 'none';
      st.zIndex = String(k + 1);
      if (!quick && this.layers.length === 2) {
        const a = this.layers[0], bL = this.layers[1];
        const tr = a.c.trans && a.c.trans.type;
        const td = L.trans[a.i];
        const p = td > 0 ? CR.clamp((t - L.starts[bL.i]) / td, 0, 1) : 1;
        const front = k === 1;
        switch (tr) {
          case 'fadeblack':
            if (front) { st.opacity = p < 0.5 ? '0' : '1'; st.filter = 'brightness(' + (p < 0.5 ? 0 : p * 2 - 1) + ')'; }
            else st.filter = 'brightness(' + (p < 0.5 ? 1 - p * 2 : 0) + ')';
            break;
          case 'flash':
            if (front) st.opacity = p < 0.5 ? '0' : '1';
            tWhite = p < 0.5 ? p * 2 : (1 - p) * 2;
            break;
          case 'wipe':
            if (front) st.clipPath = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)';
            break;
          case 'slide':
            st.transform = 'translateX(' + (front ? (1 - p) * W : -p * W) + 'px)';
            break;
          case 'circle':
            if (front) st.clipPath = 'circle(' + (p * Math.hypot(W, H) / 2) + 'px at 50% 50%)';
            break;
          case 'zoom':
            if (front) { st.transform = 'scale(' + (1.3 - 0.3 * p) + ')'; st.opacity = String(p); } else st.transform = 'scale(' + (1 + 0.5 * p) + ')';
            break;
          case 'spin':
            if (front) { st.transform = 'rotate(' + (-30 * (1 - p)) + 'deg) scale(' + (0.6 + 0.4 * p) + ')'; st.opacity = String(p); }
            break;
          case 'blur': {
            const mb = 0.03 * base;
            if (front) { st.filter = 'blur(' + (mb * (1 - p)).toFixed(1) + 'px)'; st.opacity = String(p); } else st.filter = 'blur(' + (mb * p).toFixed(1) + 'px)';
            break;
          }
          case 'blinds':
            if (front) {
              const sw = W / 10, v = (p * sw).toFixed(2);
              st.webkitMaskImage = st.maskImage = 'repeating-linear-gradient(90deg, #000 0 ' + v + 'px, transparent ' + v + 'px ' + sw.toFixed(2) + 'px)';
            }
            break;
          default:
            if (front) st.opacity = String(p);
        }
      }
    });
    this.tflash.style.opacity = String(tWhite);
    // 박자 효과
    const fx = quick ? null : CR.beatFxAt(t);
    if (fx && (fx.s !== 1 || fx.dx || fx.dy)) this.fx.style.transform = 'translate(' + (fx.dx * W) + 'px,' + (fx.dy * W) + 'px) scale(' + fx.s + ')';
    else this.fx.style.transform = 'none';
    this.bflash.style.opacity = fx ? String(fx.white) : '0';
    const miss = this.stage.querySelector('.missing');
    if (miss) {
      const ly = this.layers[this.layers.length - 1];
      const el = ly && ly.m && (ly.m.kind === 'image' ? ly.s.img : ly.s.v);
      const bad = ly && (!ly.m || ly.m.missing || (el && el._error));
      miss.style.display = bad ? 'flex' : 'none';
      if (bad) miss.textContent = '파일을 찾을 수 없어요: ' + (ly.m ? ly.m.name : '');
    }
  },

  /** 소리: 클립 소리(볼륨 · 페이드 · 트랜지션 크로스페이드) + 배경음악 */
  audio(L, playing) {
    const t = CR.S.t;
    (this.layers || []).forEach((ly) => {
      const { s, c, i, m } = ly;
      if (m && m.kind === 'image') { this.setVol(s.v, 0); return; }
      let g = c.volume;
      if (!L.quick) {
        const st = L.starts[i], e = L.end(i), d = e - st;
        let a = Math.max(c.fadeIn, i > 0 ? L.trans[i - 1] : 0), b = Math.max(c.fadeOut, L.trans[i]);
        if (a + b > d) { const k = d / (a + b); a *= k; b *= k; }
        if (a > 0.001 && t < st + a) g *= (t - st) / a;
        if (b > 0.001 && t > e - b) g *= (e - t) / b;
      } else g = 1;
      this.setVol(s.v, CR.clamp(g, 0, 4));
    });
    const seen = new Set();
    if (!L.quick) {
      CR.P.audio.forEach((a) => {
        const m = CR.media(a.mediaId);
        if (!m || m.missing) return;
        const st = a.start, e = CR.audioEnd(a, L.total, L.span !== undefined ? L.span : L.total);
        if (t < st || t >= e) return;
        seen.add(a.id);
        let el = this.bgm.get(a.id);
        const url = CR.mediaURL(m.path);
        if (!el) {
          el = new Audio();
          el.preload = 'auto';
          el.addEventListener('loadedmetadata', () => { el._ready = true; });
          this.bgm.set(a.id, el);
        }
        if (el.dataset.url !== url) { el.dataset.url = url; el._ready = false; el.src = url; }
        let g = a.volume;
        const d = e - st;
        let fi = a.fadeIn, fo = a.fadeOut;
        if (fi + fo > d) { const k = d / (fi + fo); fi *= k; fo *= k; }
        if (fi > 0.001 && t < st + fi) g *= (t - st) / fi;
        if (fo > 0.001 && t > e - fo) g *= (e - t) / fo;
        this.setVol(el, CR.clamp(g, 0, 1));
        const target = a.in + (t - st);
        if (!el._ready) return;
        if (playing) {
          if (el.paused) { if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target; el.play().catch(() => {}); }
          // 영상이 기준일 때만, 많이 어긋나면(0.5초 넘게) 맞춰요. 사진만 있을 때는 음악이 기준이라 되감지 않아요
          else if (this.clockedByVideo && Math.abs(el.currentTime - target) > 0.5 && !el.seeking) el.currentTime = target;
        } else if (!el.paused) el.pause();
      });
    }
    this.bgm.forEach((el, id) => {
      if (!seen.has(id) && !el.paused) el.pause();
      if (CR.P && !CR.P.audio.find((a) => a.id === id)) { el.pause(); el.src = ''; this.bgm.delete(id); }
    });
  },

  /** 글자: TextArt(Render.swift) 와 같은 비율 */
  texts(t) {
    if (!this.txtLayer) return;
    const list = CR.quick() ? [] : CR.P.texts.filter((x) => t >= x.start && t < x.end);
    const els = Array.from(this.txtLayer.children);
    while (els.length < list.length) { const d = document.createElement('div'); this.txtLayer.appendChild(d); els.push(d); }
    els.forEach((d, k) => {
      const x = list[k];
      if (!x) { d.style.display = 'none'; return; }
      const base = Math.min(this.W, this.H);
      const fs = Math.max(6, base * (x.size === 's' ? 0.045 : x.size === 'l' ? 0.085 : 0.06));
      d.className = 'txt ' + (x.box ? 'box' : 'shadow');
      d.style.display = 'block';
      d.style.fontSize = fs + 'px';
      d.style.padding = (x.box ? fs * 0.28 : fs * 0.2) + 'px ' + (x.box ? fs * 0.5 : fs * 0.3) + 'px';
      d.style.borderRadius = (fs * 0.28) + 'px';
      const margin = this.H * 0.07;
      d.style.top = d.style.bottom = d.style.left = d.style.right = '';
      d.style.transform = 'translateX(-50%)';
      if (x.pos === 'top') d.style.top = margin + 'px';
      else if (x.pos === 'center') { d.style.top = '50%'; d.style.transform = 'translate(-50%, -50%)'; }
      else if (x.pos === 'br') { d.style.bottom = (margin * 0.6) + 'px'; d.style.left = 'auto'; d.style.right = (this.W * 0.04) + 'px'; d.style.transform = 'none'; }
      else d.style.bottom = margin + 'px';
      if (x.pos !== 'br') d.style.left = '50%';
      if (d.textContent !== x.text) d.textContent = x.text;
    });
  },

  /** 프로젝트가 바뀌면 연결을 끊어요 */
  reset() {
    this.pause();
    this.slots.forEach((s) => {
      s.v.removeAttribute('src'); delete s.v.dataset.url; s.v._ready = false; s.v.load();
      s.img.removeAttribute('src'); delete s.img.dataset.url; s.img._ready = false;
      s.bg.removeAttribute('src'); delete s.bg.dataset.url;
    });
    this.bgm.forEach((el) => { el.pause(); el.src = ''; });
    this.bgm.clear();
    this.layers = [];
  },
};
CR.Player.init();
