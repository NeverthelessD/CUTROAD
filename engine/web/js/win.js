// CUTROAD — Windows 판 화면 도우미
//   · 영상 처리 부탁은 엔진(/api/native)으로 (맥은 앱 껍데기)
//   · 파일 · 폴더 고르기 창 (화면 안)
//   · 창에 끌어다 놓은 파일 찾기 (브라우저는 파일 위치를 알려 주지 않아서 엔진이 찾아요)
//   · 처음 켤 때 영상 도구(ffmpeg) 준비 화면
//   · 단축키 표시 ⌘ → Ctrl
// made by. Nevertheless_D
'use strict';

CR.WIN = document.documentElement.dataset.os === 'windows';
CR.engineNative = document.documentElement.dataset.engineNative === '1';

/** Windows 에 맞춘 말 (단축키 · 탐색기) */
CR.T = function (s) {
  if (!CR.WIN || typeof s !== 'string') return s;
  return s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⌫/g, 'Del')
    .replace('Finder에서 보기', '탐색기에서 보기').replace('맥 설정 따르기', 'Windows 설정 따르기');
};

/** 경로의 마지막 이름 · 폴더 (맥 / · Windows \ 모두) */
CR.baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
CR.dirName = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');

if (CR.engineNative) {
  const viaEngine = CR.native;
  CR.native = async function (type, data) {
    if (type === 'open') return CR.pickFiles((data && data.kind) || '');
    if (type === 'chooseFolder') return CR.pickFolder((data && data.start) || '', (data && data.purpose) || '');
    if (type === 'diag') { window.open('/diag'); return { ok: true }; }
    if (type === 'title') return { ok: true };
    const r = await CR.api('/api/native', Object.assign({ type }, data || {}));
    return r;
  };
  void viaEngine;
}

// ---------------------------------------------------------------- 고르기 창

CR.pickerOpen = () => !!document.querySelector('.pickwrap');

function openPicker(opt) {
  return new Promise((resolve) => {
    const folderMode = opt.mode === 'folder';
    const st = { path: opt.start || (CR.S.settings && CR.S.settings.ui && CR.S.settings.ui['pick_' + (opt.kind || 'video')]) || '', data: null, sel: new Set(), busy: false };
    const wrap = h('div', { class: 'modal pickwrap', style: { zIndex: 80 } });
    const dlg = h('div', { class: 'dlg picker', style: { width: '860px', height: 'min(640px, calc(100vh - 40px))' } });
    wrap.appendChild(dlg);
    const done = (v) => {
      wrap.remove();
      removeEventListener('keydown', key, true);
      if (st.data && st.data.path) CR.api('/api/settings', { ui: { ['pick_' + (opt.kind || 'video')]: st.data.path } }).then((s) => { CR.S.settings = s; }).catch(() => {});
      resolve(v);
    };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(folderMode ? { path: '' } : { paths: [] }); }
      if (e.key === 'Enter' && !folderMode && st.sel.size && e.target.tagName !== 'INPUT') { e.preventDefault(); e.stopImmediatePropagation(); done({ paths: [...st.sel] }); }
    };
    addEventListener('keydown', key, true);
    wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) done(folderMode ? { path: '' } : { paths: [] }); });
    const load = async (p) => {
      try {
        st.data = await CR.api('/api/fs/list', { path: p, kind: folderMode ? 'folder' : (opt.kind || 'video') });
        st.path = st.data.path;
        if (!opt.multi) st.sel.clear();
        draw();
      } catch (e) { CR.toast(e.message, { bad: true }); }
    };
    const draw = () => {
      const d = st.data;
      dlg.innerHTML = '';
      dlg.appendChild(dlgHead(opt.title, opt.sub, () => done(folderMode ? { path: '' } : { paths: [] })));
      const side = h('div', { class: 'pside' },
        h('div', { class: 'plab' }, '자주 쓰는 곳'),
        (d.places || []).map((x) => h('button', { class: 'pplace' + (d.path === x.path ? ' on' : ''), onclick: () => load(x.path) }, CR.icon(x.icon === 'film' ? 'film' : x.icon === 'music' ? 'music' : x.icon === 'image' ? 'photo' : x.icon === 'down' ? 'export' : 'folder'), h('span', null, x.name))),
        h('div', { class: 'plab' }, '내 PC'),
        (d.drives || []).map((x) => h('button', { class: 'pplace' + (d.path === x.path ? ' on' : ''), onclick: () => load(x.path) }, CR.icon('folder'), h('span', null, x.name))));
      const crumbs = h('div', { class: 'pcrumb' },
        h('button', { class: 'btn icon ghost', title: '위 폴더', disabled: !d.parent, onclick: () => load(d.parent) }, CR.icon('back')),
        h('span', { class: 'ppath', title: d.path }, d.path));
      const list = h('div', { class: 'plist' });
      if (!d.readable) list.appendChild(h('div', { class: 'hint', style: { padding: '20px' } }, '이 폴더는 열 수 없어요.'));
      d.dirs.forEach((x) => list.appendChild(h('button', { class: 'prow dir', ondblclick: () => load(x.path), onclick: () => load(x.path) }, CR.icon('folder'), h('span', { class: 'pn' }, x.name))));
      (d.files || []).forEach((x) => {
        const on = st.sel.has(x.path);
        list.appendChild(h('button', { class: 'prow file' + (on ? ' on' : ''),
          onclick: (e) => {
            if (opt.multi && (e.ctrlKey || e.metaKey || e.shiftKey)) { if (on) st.sel.delete(x.path); else st.sel.add(x.path); }
            else if (opt.multi && !e.ctrlKey && st.sel.size > 1) { st.sel.clear(); st.sel.add(x.path); }
            else { if (on && opt.multi) st.sel.delete(x.path); else { if (!opt.multi) st.sel.clear(); st.sel.add(x.path); } }
            draw();
          },
          ondblclick: () => done({ paths: opt.multi && st.sel.size > 1 ? [...st.sel] : [x.path] }) },
        CR.icon(/\.(mp3|wav|m4a)$/i.test(x.name) ? 'music' : /\.(jpe?g|png|heic|heif)$/i.test(x.name) ? 'photo' : 'film'),
        h('span', { class: 'pn' }, x.name), h('span', { class: 'ps' }, CR.bytes(x.size))));
      });
      if (!d.dirs.length && !(d.files || []).length && d.readable) list.appendChild(h('div', { class: 'hint', style: { padding: '20px' } }, folderMode ? '안에 폴더가 없어요. 이 폴더를 고를 수 있어요.' : '여기에는 고를 수 있는 파일이 없어요 (' + opt.exts + ')'));
      if (!folderMode && opt.multi && (d.files || []).length > 1) {
        crumbs.appendChild(h('button', { class: 'btn', style: { marginLeft: 'auto' }, onclick: () => { d.files.forEach((x) => st.sel.add(x.path)); draw(); } }, '모두 고르기'));
      }
      dlg.appendChild(h('div', { class: 'pbody' }, side, h('div', { class: 'pmain' }, crumbs, list)));
      const info = folderMode ? h('span', { class: 'note' }, CR.baseName(d.path) + ' 폴더')
        : h('span', { class: 'note' }, st.sel.size ? st.sel.size + '개 골랐어요' : (opt.multi ? 'Ctrl 을 누른 채 누르면 여러 개를 고를 수 있어요' : opt.exts));
      dlg.appendChild(h('div', { class: 'df' }, info, h('div', { class: 'actions' },
        folderMode && opt.canCreate ? h('button', { class: 'btn', onclick: () => CR.ask('새 폴더 이름', '새 폴더', async (name) => {
          try { const r = await CR.api('/api/fs/mkdir', { path: d.path, name }); load(r.path); } catch (e) { CR.toast(e.message, { bad: true }); }
        }) }, CR.icon('plus'), '새 폴더') : null,
        h('button', { class: 'btn', onclick: () => done(folderMode ? { path: '' } : { paths: [] }) }, '취소'),
        folderMode ? h('button', { class: 'btn primary', onclick: () => done({ path: d.path }) }, opt.okLabel)
          : h('button', { class: 'btn primary', disabled: !st.sel.size, onclick: () => done({ paths: [...st.sel] }) }, opt.okLabel))));
    };
    document.body.appendChild(wrap);
    st.data = { path: '', dirs: [], files: [], places: [], drives: [], readable: true };
    draw();
    load(st.path);
  });
}

CR.pickFiles = function (kind) {
  const music = kind === 'music' || kind === 'audio';
  return openPicker({ kind: music ? 'music' : 'video', multi: !music,
    title: music ? '배경음악 고르기' : '가져올 파일 고르기',
    sub: music ? '배경음악으로 쓸 소리 파일을 골라 주세요' : '영상 · 소리 · 사진을 골라 주세요',
    exts: music ? 'MP3 · WAV · M4A' : 'MOV · MP4 · MP3 · WAV · M4A · JPG · PNG · HEIC', okLabel: music ? '고르기' : '가져오기' });
};

CR.pickFolder = function (start, purpose) {
  const photos = purpose === 'photos';
  return openPicker({ mode: 'folder', kind: photos ? 'photos' : 'folder', start, canCreate: !photos,
    title: photos ? '사진 폴더 고르기' : '저장할 폴더 고르기',
    sub: photos ? '영상으로 만들 사진이 들어 있는 폴더를 열고 아래 버튼을 눌러 주세요' : '내보낸 파일을 저장할 폴더를 열고 아래 버튼을 눌러 주세요',
    okLabel: photos ? '이 폴더의 사진 쓰기' : '이 폴더에 저장' });
};

// ---------------------------------------------------------------- 끌어다 놓기

if (CR.engineNative) {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; window.cutroadDragHover && window.cutroadDragHover(true); });
  addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) window.cutroadDragHover && window.cutroadDragHover(false); });
  addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    window.cutroadDragHover && window.cutroadDragHover(false);
    if (CR.modalOpen()) return;
    const ok = /\.(mov|mp4|mp3|wav|m4a|jpe?g|png|heic|heif)$/i;
    const all = [...e.dataTransfer.files];
    const files = all.filter((f) => ok.test(f.name));
    const skipped = all.length - files.length;
    if (!files.length) { window.cutroadDropped([], skipped); return; }
    const hints = [];
    if (CR.P) CR.P.media.forEach((m) => { const d = CR.dirName(m.path); if (d && !hints.includes(d)) hints.push(d); });
    const last = CR.S.settings && CR.S.settings.ui && CR.S.settings.ui.pick_video;
    if (last) hints.unshift(last);
    CR.toast('파일을 찾는 중…', { ms: 1500 });
    try {
      const r = await CR.api('/api/drop', { files: files.map((f) => ({ name: f.name, size: f.size, mtime: f.lastModified })), hints });
      if (r.missing && r.missing.length) {
        CR.toast('파일 ' + r.missing.length + '개는 위치를 찾지 못했어요. ‘가져오기’ 버튼으로 골라 주세요', { bad: true, ms: 7000, action: () => CR.pickImport(), actionLabel: '가져오기' });
      }
      window.cutroadDropped(r.paths || [], skipped);
    } catch (err) { CR.toast(err.message, { bad: true }); }
  });
}

// ---------------------------------------------------------------- 처음 켤 때: 영상 도구 준비

CR.toolsReady = true;
CR.watchTools = async function () {
  if (!CR.engineNative) return;
  let box = null;
  for (;;) {
    let t = null;
    try { t = (await CR.api('/api/poll')).tools; } catch (e) { /* 엔진이 바쁠 수 있어요 */ }
    if (t && t.state === 'ready') { CR.toolsReady = true; if (box) { box.remove(); CR.toast('영상 도구가 준비됐어요. 이제 바로 쓸 수 있어요'); } return; }
    CR.toolsReady = false;
    if (t) {
      if (!box) { box = h('div', { class: 'toolsbox' }); document.body.appendChild(box); }
      box.innerHTML = '';
      const pct = t.total > 0 ? Math.round(t.done / t.total * 100) : 0;
      if (t.state === 'error') {
        CR.put(box, h('b', null, '영상 도구를 받지 못했어요'), h('p', null, t.error || '인터넷 연결을 확인해 주세요'),
          h('button', { class: 'btn primary', onclick: () => CR.api('/api/tools/retry', {}) }, CR.icon('refresh'), '다시 받기'));
      } else {
        CR.put(box, h('b', null, '영상 도구를 준비하는 중이에요 (처음 한 번만)'),
          h('p', null, '영상을 읽고 만드는 도구를 받고 있어요 · ' + (t.total ? Math.round(t.done / 1e6) + ' / ' + Math.round(t.total / 1e6) + 'MB' : '연결 중')),
          h('div', { class: 'bar' }, h('div', { style: { width: pct + '%' } })));
      }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
};
