// CUTROAD — 공통 도구 (화면 만들기 · 엔진/앱과 주고받기 · 시간 표시 · 알림)
// made by. Nevertheless_D
'use strict';
const CR = (window.CR = {});

CR.token = new URLSearchParams(location.search).get('t') || '';

CR.api = async function (path, body) {
  const opt = { headers: { 'x-token': CR.token } };
  if (body !== undefined) {
    opt.method = 'POST';
    opt.headers['content-type'] = 'application/json';
    opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  let j = null;
  try { j = await r.json(); } catch (e) { /* 빈 응답 */ }
  if (!r.ok) throw new Error((j && j.error) || '엔진과 연결이 끊겼어요 (' + r.status + ')');
  return j;
};

// 앱 껍데기(Swift)에 부탁하기. 브라우저에서 시험할 때는 CR.mock 이 대신해요.
CR.hasNative = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cutroad);
CR.native = async function (type, data) {
  const msg = Object.assign({ type }, data || {});
  if (CR.hasNative) return window.webkit.messageHandlers.cutroad.postMessage(msg);
  if (CR.mock && CR.mock[type]) return CR.mock[type](msg);
  throw new Error('이 기능은 CUTROAD 앱 안에서만 쓸 수 있어요');
};

CR.mediaURL = (path) => '/api/media?p=' + encodeURIComponent(path) + '&t=' + encodeURIComponent(CR.token);

// h('div', {class: 'x', onclick: fn, style: {left: '3px'}}, '글자', child, [children])
CR.h = function h(tag, props, ...kids) {
  const el = tag.indexOf(':svg') > 0 ? document.createElementNS('http://www.w3.org/2000/svg', tag.replace(':svg', '')) : document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  const add = (k) => {
    if (k === null || k === undefined || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
};
const h = CR.h;
CR.put = function (el, ...kids) {
  const add = (k) => { if (k === null || k === undefined || k === false) return; if (Array.isArray(k)) return k.forEach(add); el.appendChild(k instanceof Node ? k : document.createTextNode(String(k))); };
  kids.forEach(add);
  return el;
};

// 아이콘 (선 그림)
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  shrink: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  mic: '<path d="M12 2a3 3 0 013 3v6a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1M12 18v4"/>',
  music: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  export: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 15v4a2 2 0 002 2h10a2 2 0 002-2v-4"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
  back: '<path d="M19 20L9 12l10-8v16zM5 19V5"/>',
  fwd: '<path d="M5 4l10 8-10 8V4zM19 5v14"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/>',
  trans: '<path d="M3 5l9 7-9 7zM21 5l-9 7 9 7z"/>',
  silence: '<path d="M4 12h3M17 12h3M9 7v10M15 7v10"/>',
  cursor: '<path d="M5 3l6.5 17 2.4-7.1L21 10.5z"/>',
  rotL: '<path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  rotR: '<path d="M21 12a9 9 0 11-9-9 9.75 9.75 0 016.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  film: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="M17 10l5-3v10l-5-3"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  keys: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  refresh: '<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  folder: '<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  restore: '<path d="M3 12a9 9 0 109-9"/><path d="M3 4v5h5"/>',
  wave: '<path d="M2 12h2M6 8v8M10 5v14M14 9v6M18 7v10M22 12h-2"/>',
  photo: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 13l4-4 4 4 2-2 4 4"/><path d="M20 8v9a2 2 0 01-2 2H7"/>',
  sparkle: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  gif: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10H8v4h2v-2M13 10v4M16 14v-4h2M16 12h1.5"/>',
};
CR.icon = function (name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';
  return s;
};
const I = CR.icon;

CR.logoSVG = function (size) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 32 32');
  if (size) { s.setAttribute('width', size); s.setAttribute('height', size); }
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="#1A1C22" stroke="#33373F"/><rect x="5" y="12" width="10" height="9" rx="2" fill="#4D86FF"/>' +
    '<rect x="18" y="12" width="9" height="9" rx="2" fill="#E8EAEE"/><rect x="15.5" y="8" width="2" height="17" rx="1" fill="#FF5A1F"/><path d="M13.5 6h6l-3 3.2z" fill="#FF5A1F"/>';
  return s;
};
CR.word = () => h('span', { class: 'word' }, 'CUT', h('b', null, 'ROAD'));

// 시간 표시
CR.fps = 30;
CR.tc = function (t) {
  t = Math.max(0, t || 0);
  const f = Math.floor((t - Math.floor(t)) * CR.fps + 1e-6);
  const s = Math.floor(t) % 60, m = Math.floor(t / 60) % 60, hh = Math.floor(t / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return p(hh) + ':' + p(m) + ':' + p(s) + ':' + p(f);
};
CR.short = function (t) {
  t = Math.max(0, t || 0);
  const s = Math.floor(t + 1e-6);
  const m = Math.floor(s / 60);
  if (m >= 60) return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  return m + ':' + String(s % 60).padStart(2, '0');
};
CR.shortD = function (t) { // 0:12.5 처럼 소수점 한 자리
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
};
CR.human = function (t) {
  t = Math.round(Math.max(0, t || 0));
  const m = Math.floor(t / 60), s = t % 60;
  if (m === 0) return s + '초';
  if (m >= 60) return Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  return m + '분' + (s ? ' ' + s + '초' : '');
};
CR.bytes = function (n) {
  if (!n) return '0MB';
  if (n < 1e6) return Math.max(1, Math.round(n / 1e3)) + 'KB';
  if (n < 1e9) return Math.round(n / 1e6) + 'MB';
  return (n / 1e9).toFixed(1) + 'GB';
};
CR.when = function (ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const hm = (d.getHours() < 12 ? '오전 ' : '오후 ') + ((d.getHours() % 12) || 12) + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return '오늘 ' + hm;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '어제 ' + hm;
  return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
};

CR.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
CR.uid = () => Math.random().toString(36).slice(2, 10);
CR.round = (v, n) => Math.round(v * Math.pow(10, n || 2)) / Math.pow(10, n || 2);
CR.debounce = function (fn, ms) {
  let t = 0;
  const d = function () { clearTimeout(t); t = setTimeout(fn, ms); };
  d.now = function () { clearTimeout(t); fn(); };
  return d;
};

// 알림
CR.toast = function (msg, opt) {
  opt = opt || {};
  const box = document.getElementById('toasts');
  const el = h('div', { class: 'toast' + (opt.bad ? ' bad' : '') }, h('span', null, msg));
  if (opt.action) el.appendChild(h('button', { onclick: () => { opt.action(); el.remove(); } }, opt.actionLabel || '되돌리기'));
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), opt.ms || (opt.bad ? 6000 : 3200));
  return el;
};

// 작은 메뉴
CR.menu = function (x, y, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu' }, items.map((it) => h('button', { class: it.danger ? 'danger' : '', onclick: () => { m.remove(); it.run(); } },
    it.icon ? I(it.icon) : null, it.label)));
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); removeEventListener('mousedown', off, true); } };
  setTimeout(() => addEventListener('mousedown', off, true), 0);
};

// 화면에서 생긴 문제는 엔진 기록에 남겨요 (진단 정보에서 볼 수 있게)
CR.clientErrors = [];
CR.reportError = CR.debounce(() => {
  const items = CR.clientErrors.splice(0);
  if (items.length) CR.api('/api/clientlog', { items }).catch(() => {});
}, 1500);
addEventListener('error', (e) => { CR.clientErrors.push(String(e.message) + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno); CR.reportError(); });
addEventListener('unhandledrejection', (e) => { CR.clientErrors.push('promise: ' + (e.reason && e.reason.message || e.reason)); CR.reportError(); });
