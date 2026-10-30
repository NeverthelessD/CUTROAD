// CUTROAD — 미리보기 재생기
// made by. Nevertheless_D
//
// 영상 두 개(A · B)를 번갈아 써서 클립과 트랜지션을 이어 보여 주고, 소리는 Web Audio 로 볼륨 · 페이드를 맞춰요.
// 효과(블러 · 페이드 · 회전 · 화면 맞춤 · 트랜지션 · 글자)는 내보내기(Render.swift)와 같은 계산으로 CSS 로 흉내 내요.
'use strict';

CR.Player = {
  playing: false,
  vids: [],
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
      v.addEventListener('loadedmetadata', () => { v._ready = true; this.apply(); });
      v.addEventListener('seeked', () => { if (!this.playing) this.draw(); });
      v.addEventListener('error', () => { v._ready = false; v._error = true; this.apply(); });
      this.vids.push(v);
    }
  },

  mount(stage, txtLayer) {
    this.stage = stage;
    this.txtLayer = txtLayer;
    this.vids.forEach((v) => stage.insertBefore(v, txtLayer));
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
        src.connect(g).connect(this.ctx.destination);
        this.nodes.set(el, g);
      } catch (e) { return null; }
    }
    return g;
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
    this.vids.forEach((v) => { if (!v.paused) v.pause(); });
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
    // 화면에 나오는 클립 영상의 시각을 기준으로 맞춰요 (소리 · 화면이 어긋나지 않게)
    const i = CR.clipAt(CR.S.t, L);
    if (i >= 0) {
      const c = L.list[i], v = this.vids[i % 2];
      const sp = L.quick ? 1 : c.speed;
      if (v._ready && !v.paused && !v.seeking && v.dataset.clip === c.id) {
        const tv = L.starts[i] + (v.currentTime - c.in) / sp;
        if (tv > CR.S.t - 0.05 && tv < CR.S.t + 0.3) t = Math.max(CR.S.t, tv);
      }
    }
    // 컷 편집만: 지운 조각은 건너뛰어요
    if (L.quick) {
      const j = CR.clipAt(t, L);
      if (j >= 0 && L.list[j].removed) {
        let k = j;
        while (k < L.list.length && L.list[k].removed) k++;
        t = k < L.list.length ? L.starts[k] : L.total;
      }
    }
    if (t >= L.total) {
      CR.S.t = L.total;
      this.pause();
      CR.onTime && CR.onTime();
      return;
    }
    CR.S.t = t;
    this.apply(L);
    CR.onTime && CR.onTime();
  },

  /** 지금 시각에 맞춰 영상 · 소리 · 글자를 맞춰요 */
  apply(L) {
    if (!this.stage || !CR.P) return;
    L = L || CR.layout();
    const t = CR.S.t;
    const playing = this.playing;
    const active = [];
    for (let i = 0; i < L.list.length; i++) {
      if (t >= L.starts[i] - 1e-6 && t < L.end(i) - 1e-6) active.push(i);
    }
    if (!active.length && L.list.length && t >= L.total - 1e-3) active.push(L.list.length - 1);
    const used = new Set();
    const layers = [];
    active.slice(-2).forEach((i) => {
      const c = L.list[i];
      const m = CR.media(c.mediaId);
      const v = this.vids[i % 2];
      used.add(v);
      const sp = L.quick ? 1 : c.speed;
      const target = CR.clamp(c.in + (t - L.starts[i]) * sp, 0, Math.max(0, c.out - 0.001));
      this.sync(v, c, m, target, sp, playing);
      layers.push({ i, c, m, v });
    });
    // 다음 클립 미리 준비
    const cur = active.length ? active[active.length - 1] : -1;
    const nx = cur + 1;
    if (nx < L.list.length && L.starts[nx] - t < 2 && !used.has(this.vids[nx % 2])) {
      const c = L.list[nx];
      const v = this.vids[nx % 2];
      this.sync(v, c, CR.media(c.mediaId), c.in, 1, false);
      used.add(v);
    }
    this.vids.forEach((v) => {
      if (!layers.find((l) => l.v === v)) {
        v.style.visibility = 'hidden';
        if (!used.has(v) && !v.paused) v.pause();
        if (!v.paused && playing) v.pause();
        this.setVol(v, 0);
      }
    });
    this.layers = layers;
    this.draw(L);
    this.audio(L, playing);
    this.texts(t);
  },

  sync(v, c, m, target, rate, playing) {
    if (!m || m.missing) { v.dataset.clip = c.id; return; }
    const url = CR.mediaURL(m.path);
    if (v.dataset.url !== url) {
      v.dataset.url = url;
      v._ready = false; v._error = false;
      v.src = url;
      v._pendingSeek = target;
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

  geom(m, c) {
    const W = this.W, H = this.H;
    let w = (m && m.width) || 1920, h = (m && m.height) || 1080;
    const rot = CR.quick() ? 0 : (c.rotate || 0);
    const rw = rot % 180 === 90 ? h : w, rh = rot % 180 === 90 ? w : h;
    const fill = !CR.quick() && CR.P.fit === 'fill';
    const s = fill ? Math.max(W / rw, H / rh) : Math.min(W / rw, H / rh);
    return { w: w * s, h: h * s, left: (W - w * s) / 2, top: (H - h * s) / 2, rot };
  },

  /** 화면 그리기: 위치 · 회전 · 블러 · 페이드 · 트랜지션 */
  draw(L) {
    if (!this.layers) return;
    L = L || CR.layout();
    const t = CR.S.t;
    const quick = L.quick;
    const base = Math.min(this.W, this.H);
    this.layers.forEach((ly, k) => {
      const { v, c, m, i } = ly;
      if (!m || m.missing || v._error) { v.style.visibility = 'hidden'; return; }
      const g = this.geom(m, c);
      let tx = 0, opacity = 1, clip = 'none';
      let bright = 1;
      if (!quick) {
        const s = L.starts[i], e = L.end(i);
        if (c.fadeIn > 0 && t < s + c.fadeIn) bright = Math.min(bright, (t - s) / c.fadeIn);
        if (c.fadeOut > 0 && t > e - c.fadeOut) bright = Math.min(bright, (e - t) / c.fadeOut);
        // 트랜지션: 앞 클립(k=0)과 뒤 클립(k=1)이 겹친 구간
        if (this.layers.length === 2) {
          const a = this.layers[0], b = this.layers[1];
          const tr = a.c.trans && a.c.trans.type;
          const td = L.trans[a.i];
          const p = td > 0 ? CR.clamp((t - L.starts[b.i]) / td, 0, 1) : 1;
          if (tr === 'fadeblack') {
            if (k === 0) { bright *= p < 0.5 ? 1 - p * 2 : 0; if (p >= 0.5) opacity = 0; }
            else { bright *= p < 0.5 ? 0 : p * 2 - 1; if (p < 0.5) opacity = 0; }
          } else if (tr === 'wipe') {
            if (k === 1) clip = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)';
          } else if (tr === 'slide') {
            tx = k === 0 ? -p * this.W : (1 - p) * this.W;
          } else if (k === 1) {
            opacity = p;
          }
          // wipe 의 잘라내기는 무대 기준이라 영상 위치에 맞게 바꿔요
          if (tr === 'wipe' && k === 1) {
            const right = Math.max(0, (g.left + g.w) - p * this.W);
            clip = 'inset(0 ' + (right / g.w * 100) + '% 0 0)';
            if (g.rot) clip = 'none';
          }
        }
      }
      const filters = [];
      if (!quick && c.blur > 0) filters.push('blur(' + (c.blur * base / 1080).toFixed(2) + 'px)');
      if (bright < 0.999) filters.push('brightness(' + CR.clamp(bright, 0, 1).toFixed(3) + ')');
      Object.assign(v.style, {
        visibility: 'visible',
        width: g.w + 'px', height: g.h + 'px', left: g.left + 'px', top: g.top + 'px',
        transform: 'translateX(' + tx + 'px) rotate(' + g.rot + 'deg)',
        filter: filters.join(' ') || 'none',
        opacity: String(CR.clamp(opacity, 0, 1)),
        clipPath: clip,
        zIndex: String(k + 1),
      });
    });
    const miss = this.stage.querySelector('.missing');
    if (miss) {
      const ly = this.layers[this.layers.length - 1];
      const bad = ly && (!ly.m || ly.m.missing || ly.v._error);
      miss.style.display = bad ? 'flex' : 'none';
      if (bad) miss.textContent = '파일을 찾을 수 없어요: ' + (ly.m ? ly.m.name : '');
    }
  },

  /** 소리: 클립 소리(볼륨 · 페이드 · 트랜지션 크로스페이드) + 배경음악 */
  audio(L, playing) {
    const t = CR.S.t;
    (this.layers || []).forEach((ly) => {
      const { v, c, i } = ly;
      let g = c.volume;
      if (!L.quick) {
        const s = L.starts[i], e = L.end(i), d = e - s;
        let a = Math.max(c.fadeIn, i > 0 ? L.trans[i - 1] : 0), b = Math.max(c.fadeOut, L.trans[i]);
        if (a + b > d) { const k = d / (a + b); a *= k; b *= k; }
        if (a > 0.001 && t < s + a) g *= (t - s) / a;
        if (b > 0.001 && t > e - b) g *= (e - t) / b;
      } else g = 1;
      this.setVol(v, CR.clamp(g, 0, 4));
    });
    const seen = new Set();
    if (!L.quick) {
      CR.P.audio.forEach((a) => {
        const m = CR.media(a.mediaId);
        if (!m || m.missing) return;
        const s = a.start, e = Math.min(L.total, a.start + (a.out - a.in));
        if (t < s || t >= e) return;
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
        const d = e - s;
        let fi = a.fadeIn, fo = a.fadeOut;
        if (fi + fo > d) { const k = d / (fi + fo); fi *= k; fo *= k; }
        if (fi > 0.001 && t < s + fi) g *= (t - s) / fi;
        if (fo > 0.001 && t > e - fo) g *= (e - t) / fo;
        this.setVol(el, CR.clamp(g, 0, 1));
        const target = a.in + (t - s);
        if (!el._ready) return;
        if (playing) {
          if (el.paused) { el.currentTime = target; el.play().catch(() => {}); }
          else if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
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
      d.style.top = d.style.bottom = '';
      d.style.transform = 'translateX(-50%)';
      if (x.pos === 'top') d.style.top = margin + 'px';
      else if (x.pos === 'center') { d.style.top = '50%'; d.style.transform = 'translate(-50%, -50%)'; }
      else d.style.bottom = margin + 'px';
      if (d.textContent !== x.text) d.textContent = x.text;
    });
  },

  /** 프로젝트가 바뀌면 영상 연결을 끊어요 */
  reset() {
    this.pause();
    this.vids.forEach((v) => { v.removeAttribute('src'); delete v.dataset.url; v._ready = false; v.load(); });
    this.bgm.forEach((el) => { el.pause(); el.src = ''; });
    this.bgm.clear();
    this.layers = [];
  },
};
CR.Player.init();
