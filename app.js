/* Poker Masterclass Coach — PWA. All data is imported from one zip (PokerMasterclassCoach_DATA.zip)
   and stored in the device's IndexedDB. Content and interface in English. */
'use strict';

const VERSION = '1.2.0';
const POS = ['utg', 'utg1', 'lj', 'hj', 'co', 'btn', 'sb', 'bb'];
const POS_LABEL = { utg: 'UTG', utg1: 'UTG+1', lj: 'LJ', hj: 'HJ', co: 'CO', btn: 'BU', sb: 'SB', bb: 'BB' };
const TYPE_ORDER = ['rfi', 'vslimp', 'vsrfi', 'vsopenjam', 'vslimp-allin', 'vs3bet', 'vsallin', 'limp-vsraise', 'limp-vsallin'];
const SIT = { // grupos de situación para filtros del trainer
  rfi: 'Open (RFI)', vsrfi: 'vs open', vs3bet: 'vs 3bet', jam: 'vs jam / all-in', limp: 'Limp',
};
const sitOf = (t) => t === 'rfi' ? 'rfi' : t === 'vsrfi' ? 'vsrfi' : t === 'vs3bet' ? 'vs3bet'
  : (t === 'vsopenjam' || t === 'vsallin') ? 'jam' : 'limp';

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('pmc_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('pmc_' + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('pmcoach', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('img'); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function idb(storeName, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(storeName, mode);
    const out = fn(tx.objectStore(storeName));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}
const getMeta = (k) => idb('meta', 'readonly', s => s.get(k));
const setMeta = (k, v) => idb('meta', 'readwrite', s => s.put(v, k));

const urlCache = new Map();
async function imgURL(file) {
  if (urlCache.has(file)) return urlCache.get(file);
  const blob = await idb('img', 'readonly', s => s.get(file));
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  urlCache.set(file, u);
  if (urlCache.size > 160) { const [k, v] = urlCache.entries().next().value; URL.revokeObjectURL(v); urlCache.delete(k); }
  return u;
}
async function setImg(imgEl, file) { imgEl.src = await imgURL(file); }

// ---------- datos en memoria ----------
let MAN = null;            // manifest
let FICHAS = [];           // index.json
let FBY = {};              // id -> ficha
let FT = {};               // file -> texto md
let PR = null;             // principles.json
let PB = null;             // playbook.json (v1.2)
let RULE = {};             // code -> {code,text,src,fichas,master}
let MASTER = {};           // code -> master
let RINDEX = [];           // rangos
let BY = {};               // BY[pos][stack] = [entries]
const ready = () => !!(PR && FICHAS.length);

function loadData(d) {
  MAN = d.manifest; FT = d.fichas || {}; PR = d.principles; PB = d.playbook || null;
  FICHAS = (d.index || []).map(f => ({
    ...f,
    types: String(f.type || '').split(/[;+]/).map(s => s.trim()).filter(Boolean),
    parsed: null,
  }));
  FBY = {}; FICHAS.forEach(f => FBY[f.id] = f);
  RULE = {}; MASTER = {};
  (PR.masters || []).forEach(m => { MASTER[m.code] = m; m.rules.forEach(r => { r.master = m.code; RULE[r.code] = r; }); });
  buildRanges(d.ranges || []);
}
function buildRanges(list) {
  RINDEX = list.slice().sort((a, b) => POS.indexOf(a.pos) - POS.indexOf(b.pos) || b.stack - a.stack || a.order - b.order);
  BY = {};
  for (const e of RINDEX) { ((BY[e.pos] ||= {})[e.stack] ||= []).push(e); }
}
const stacksOf = (pos) => Object.keys(BY[pos] || {}).map(Number).sort((a, b) => b - a);
const allStacks = () => [...new Set(RINDEX.map(e => e.stack))].sort((a, b) => b - a);
const famName = (id) => { const f = (PR.families || []).find(x => x.id === id); return f ? f.name : id; };

// ---------- parseo de fichas ----------
function parseFicha(f) {
  if (f.parsed) return f.parsed;
  const txt = FT[f.file] || '';
  const P = { rule: '', why: '', key: [], numbers: '', hooks: [], ex: [], extra: [] };
  let cur = null;
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || i < 2 && /^(id:|spot:)/.test(l)) continue;
    let m;
    if ((m = l.match(/^RULE:\s*(.*)$/))) { P.rule = m[1]; cur = 'rule'; continue; }
    if ((m = l.match(/^WHY:\s*(.*)$/))) { P.why = m[1]; cur = 'why'; continue; }
    if (/^KEY POINTS/.test(l)) { cur = 'key'; const r = l.replace(/^KEY POINTS:?\s*/, ''); if (r) P.key.push(r); continue; }
    if ((m = l.match(/^NUMBERS[^:]*:\s*(.*)$/))) { P.numbers = m[1]; cur = 'numbers'; continue; }
    if ((m = l.match(/^STACK hooks:\s*(.*)$/))) { P.hooks = m[1].split(/,\s*(?=\+)|^\+/).map(s => s.replace(/^\+/, '').trim()).filter(Boolean); cur = 'hooks'; continue; }
    if ((m = l.match(/^EXERCISES:\s*(.*)$/))) { P.ex = parseEx(m[1]); cur = 'ex'; continue; }
    if (/^ASSETS:/.test(l)) { cur = 'assets'; continue; }
    if (cur === 'assets') continue;
    const b = l.replace(/^[-•]\s*/, '');
    if (cur === 'key' || l.startsWith('- ')) P.key.push(b);
    else if (cur === 'rule') P.rule += ' ' + l;
    else if (cur === 'why') P.why += ' ' + l;
    else if (cur === 'numbers') P.numbers += ' ' + l;
    else if (cur === 'ex') P.ex.push(...parseEx(l));
    else P.extra.push(b);
  }
  f.parsed = P;
  return P;
}
function parseEx(s) {
  return s.split(/\s+·\s+|\s*;\s*(?=")/).map(x => x.trim()).filter(Boolean).map(x => {
    x = x.replace(/^"|"$/g, '');
    let q = x, a = '';
    if (x.endsWith(')')) {
      let d = 0, k = x.length - 1;
      for (; k >= 0; k--) { if (x[k] === ')') d++; else if (x[k] === '(') { d--; if (d === 0) break; } }
      if (k > 0) { q = x.slice(0, k).trim().replace(/:\s*$/, '').replace(/"\s*$/, ''); a = x.slice(k + 1, -1).trim(); }
    }
    q = q.replace(/^"|"$/g, '').replace(/"/g, '');
    return { q, a };
  }).filter(e => e.q.length > 3);
}

// ---------- importación ----------
async function importZip(file, onProgress) {
  onProgress(0, 'Opening the zip…');
  const zip = await JSZip.loadAsync(file);
  const find = (re) => zip.file(re)[0];
  const man = find(/(^|\/)manifest\.json$/);
  const idx = find(/(^|\/)index\.json$/);
  const pr = find(/(^|\/)principles\.json$/);
  if (!man || !idx || !pr) throw new Error('This zip is not PokerMasterclassCoach_DATA.zip (manifest.json, index.json or principles.json is missing).');
  const prefix = man.name.slice(0, man.name.length - 'manifest.json'.length);
  const manifest = JSON.parse(await man.async('string'));
  const index = JSON.parse(await idx.async('string'));
  const principles = JSON.parse(await pr.async('string'));
  const pbf = zip.file(prefix + 'playbook.json');
  const playbook = pbf ? JSON.parse(await pbf.async('string')) : null;
  const rj = zip.file(prefix + 'ranges/ranges.json');
  const ranges = rj ? JSON.parse(await rj.async('string')) : [];
  onProgress(0.03, 'Reading lessons…');
  const fichas = {};
  for (const f of index) { const z = zip.file(prefix + f.file); if (z) fichas[f.file] = await z.async('string'); }
  await setMeta('data', { manifest, index, principles, playbook, fichas, ranges: [] });
  // imágenes de rangos
  await idb('img', 'readwrite', s => s.clear());
  const ok = [];
  const BATCH = 20;
  for (let i = 0; i < ranges.length; i += BATCH) {
    const chunk = ranges.slice(i, i + BATCH);
    const blobs = await Promise.all(chunk.map(async e => {
      const f = zip.file(prefix + e.file);
      if (!f) return null;
      return new Blob([await f.async('arraybuffer')], { type: 'image/webp' });
    }));
    await idb('img', 'readwrite', s => { chunk.forEach((e, j) => { if (blobs[j]) { s.put(blobs[j], e.file); ok.push(e); } }); });
    onProgress(0.05 + 0.95 * Math.min(1, (i + BATCH) / ranges.length), `Saving ranges… ${Math.min(ranges.length, i + BATCH)}/${ranges.length}`);
  }
  const data = { manifest, index, principles, playbook, fichas, ranges: ok };
  await setMeta('data', data);
  await setMeta('importedAt', new Date().toISOString());
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
  return data;
}
function pickZip() {
  return new Promise(res => { const inp = $('#zip-input'); inp.value = ''; inp.onchange = () => res(inp.files[0] || null); inp.click(); });
}
async function runImport() {
  const file = await pickZip();
  if (!file) return;
  const m = $('#main'); m.innerHTML = '';
  const box = h(`<div class="welcome card"><div class="big">📦</div><h2>Importing data…</h2>
    <p class="muted" id="imp-msg">Reading ${esc(file.name)}. Don't close the app.</p>
    <div class="progress"><div id="imp-bar"></div></div></div>`);
  m.append(box);
  try {
    const data = await importZip(file, (p, msg) => { $('#imp-bar').style.width = (p * 100).toFixed(0) + '%'; if (msg) $('#imp-msg').textContent = msg; });
    urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
    loadData(data);
    location.hash = '#/home'; route();
  } catch (err) {
    box.innerHTML = `<div class="big">⚠️</div><h2>Import failed</h2><p class="muted">${esc(err.message || err)}</p>
      <button class="btn" id="retry">Try again</button>`;
    $('#retry').onclick = runImport;
  }
}
function welcome(m) {
  m.append(h(`<div class="welcome card">
    <div class="big">♠</div>
    <h2>Welcome to Poker Masterclass Coach</h2>
    <p class="muted">To start, import your <b>PokerMasterclassCoach_DATA.zip</b> file from Files.
    Everything (lessons, principles, ranges and images) is stored only on this device and the app works offline.</p>
    <button class="btn" id="imp">Import data</button>
    <p class="muted" style="font-size:13px;margin-top:18px">Tip: add the app to your Home Screen (Share → Add to Home Screen) so the iPad keeps the data. The import takes a minute or two.</p>
  </div>`));
  $('#imp').onclick = runImport;
}

// ---------- modo oscuro ----------
function setDark(on) { store.set('dark', on); document.body.classList.toggle('dark', on); document.documentElement.classList.toggle('dark', on);
  const tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.content = on ? '#161917' : '#F6F1E7'; }

// ---------- lightbox ----------
let lbZoom = 1;
function openLightbox(e) {
  lbZoom = 1; $('#lb-title').textContent = fullLabel(e);
  const img = $('#lb-img'); img.style.width = '100%'; setImg(img, e.file);
  $('#lightbox').classList.remove('hidden');
}
function zoomLB(d) { lbZoom = Math.max(1, Math.min(3, lbZoom + d)); $('#lb-img').style.width = (lbZoom * 100) + '%'; }

// ---------- router ----------
function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/').map(decodeURIComponent);
  const v = parts[0];
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.v === (v === 'ficha' ? 'fichas' : v)));
  const m = $('#main'); m.innerHTML = '';
  if (v !== 'settings' && !ready()) { welcome(m); return; }
  const views = { home: viewHome, study: viewStudy, playbook: viewPlaybook, fichas: viewFichas, ficha: viewFicha, stack: viewStack, ranges: viewRanges, trainer: viewTrainer, settings: viewSettings };
  (views[v] || viewHome)(m, parts.slice(1));
  if (!route.keepScroll) window.scrollTo(0, 0);
  route.keepScroll = false;
}
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const rerender = () => { route.keepScroll = true; route(); };

function chipRow(values, active, label, onPick, disabledFn) {
  const row = h('<div class="chips"></div>');
  values.forEach(v => {
    const b = h(`<button class="chip">${esc(label(v))}</button>`);
    if (Array.isArray(active) ? active.includes(v) : v === active) b.classList.add('on');
    if (disabledFn && disabledFn(v)) b.disabled = true;
    b.onclick = () => onPick(v);
    row.append(b);
  });
  return row;
}

// ---------- progreso ----------
const KNOWN = new Set(store.get('known', []));
const saveKnown = () => store.set('known', [...KNOWN]);
const FAV = new Set(store.get('favF', []));
const saveFav = () => store.set('favF', [...FAV]);

// ================= INICIO =================
function ruleOfDay() {
  const all = Object.values(RULE); if (!all.length) return null;
  const d = new Date(); const seed = d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
  return all[(seed * 2654435761 >>> 0) % all.length];
}
function viewHome(m) {
  const dark = document.body.classList.contains('dark');
  const nRules = Object.keys(RULE).length;
  const hist = store.get('hist', []);
  const lastAcc = hist.length ? Math.round(100 * hist[0].ok / Math.max(1, hist[0].n)) + '%' : '—';
  const hero = h(`<div class="card hero-card">
    <div><h1>Poker Masterclass Coach</h1><div class="muted">Your study coach: principles, lessons, the S.T.A.C.K. method and ranges.</div></div>
    <button class="darkbtn" id="dk">${dark ? '☀️ Light mode' : '🌙 Dark mode'}</button></div>`);
  m.append(hero);
  $('#dk').onclick = () => { setDark(!document.body.classList.contains('dark')); rerender(); };
  m.append(h(`<div class="stats">
    <span class="stat"><b>${FICHAS.length}</b> lessons</span>
    <span class="stat"><b>${nRules}</b> rules · mastered <b>${KNOWN.size}</b></span>
    <span class="stat"><b>${RINDEX.length}</b> ranges</span>
    <span class="stat">Last trainer: <b>${lastAcc}</b></span></div>`));
  const r = ruleOfDay();
  if (r) {
    const c = h(`<div class="card rod"><div class="code">RULE OF THE DAY · ${esc(r.code)} · ${esc(famName(MASTER[r.master].family))}</div>
      <p style="font-weight:800">${esc(MASTER[r.master].title)}</p><p>${esc(r.text)}</p>
      <div class="row" style="margin-top:10px"><a class="mini" href="#/study/${encodeURIComponent(MASTER[r.master].family)}/${encodeURIComponent(r.master)}">Open in Study</a></div></div>`);
    m.append(c);
  }
  const tiles = [
    ['#/study', '📚', 'Study', 'The coach\'s principles by family: master rules, sub-rules and related lessons.'],
    ['#/playbook', '📘', 'Playbook', 'The coach\'s own strategy: game plan, population leaks, player profiles, tournament stages and checklists.'],
    ['#/fichas', '🗂️', 'Lessons', 'Every lesson: rule, why, key points, numbers and exercises. Search and filters.'],
    ['#/stack', '🧠', 'S.T.A.C.K.', 'The method to think through any spot, and practice solving real spots.'],
    ['#/ranges', '♠', 'Ranges', 'Range viewer by position and stack, plus comparisons.'],
    ['#/trainer', '🎯', 'Trainer', 'Drill ranges: pick the right range, name the spot, or flashcards. Score and history.'],
    ['#/settings', '⚙︎', 'Settings', 'Import data, storage and progress.'],
  ];
  const g = h('<div class="home-grid"></div>');
  tiles.forEach(([href, ic, t, d]) => g.append(h(`<a class="htile" href="${href}"><div class="ic">${ic}</div><div class="t">${t}</div><div class="d">${d}</div></a>`)));
  m.append(g);
}

// ================= ESTUDIO =================
function viewStudy(m, args) {
  const [fam, master] = args;
  if (fam) return studyFamily(m, fam, master);
  m.append(h('<h2>Study</h2>'));
  const q = h(`<input class="search" placeholder="Search the ${Object.keys(RULE).length} rules: ‘bubble’, ‘check-raise’, ‘blockers’…" value="${esc(store.get('qRule', ''))}">`);
  m.append(q);
  const out = h('<div style="margin-top:12px"></div>'); m.append(out);
  const paint = () => {
    const s = q.value.trim().toLowerCase(); store.set('qRule', q.value);
    out.innerHTML = '';
    if (s.length >= 2) {
      const words = s.split(/\s+/);
      const hits = Object.values(RULE).filter(r => { const t = (r.text + ' ' + MASTER[r.master].title).toLowerCase(); return words.every(w => t.includes(w)); });
      out.append(h(`<p class="muted">${hits.length} rules</p>`));
      const box = h('<div class="master" style="margin-top:0"></div>');
      hits.slice(0, 80).forEach(r => box.append(ruleEl(r, true)));
      if (hits.length) out.append(box);
      return;
    }
    const g = h('<div class="fam-grid"></div>');
    (PR.families || []).forEach(f => {
      const ms = PR.masters.filter(x => x.family === f.id);
      const rs = ms.flatMap(x => x.rules);
      const k = rs.filter(r => KNOWN.has(r.code)).length;
      g.append(h(`<a class="fam" href="#/study/${encodeURIComponent(f.id)}"><div class="n">${esc(f.name)}</div>
        <div class="e">${ms.length} master rules · ${rs.length} rules</div>
        <div class="pbar"><div style="width:${rs.length ? (100 * k / rs.length) : 0}%"></div></div></a>`));
    });
    out.append(g);
  };
  q.oninput = paint; paint();
}
function ruleEl(r, showMaster) {
  const el = h(`<div class="rule${KNOWN.has(r.code) ? ' known' : ''}">
    <div class="rc">${esc(r.code)}${showMaster ? ' · ' + esc(MASTER[r.master].title) : ''}</div>
    <p>${esc(r.text)}</p>
    <div class="acts"><button class="mini k">${KNOWN.has(r.code) ? '✓ Mastered' : 'Mark as mastered'}</button>
    ${r.fichas.length ? `<button class="mini f">Lessons (${r.fichas.length})</button>` : ''}</div>
    <div class="flist" style="display:none"></div></div>`);
  $('.k', el).onclick = () => {
    KNOWN.has(r.code) ? KNOWN.delete(r.code) : KNOWN.add(r.code); saveKnown();
    el.classList.toggle('known', KNOWN.has(r.code)); $('.k', el).textContent = KNOWN.has(r.code) ? '✓ Mastered' : 'Mark as mastered';
    $('.k', el).classList.toggle('on', KNOWN.has(r.code));
  };
  $('.k', el).classList.toggle('on', KNOWN.has(r.code));
  const fb = $('.f', el);
  if (fb) fb.onclick = () => {
    const l = $('.flist', el);
    if (l.style.display === 'none') {
      l.innerHTML = '';
      r.fichas.map(id => FBY[id]).filter(Boolean).forEach(f => l.append(fichaCard(f, true)));
      l.style.display = '';
    } else l.style.display = 'none';
  };
  return el;
}
function studyFamily(m, fam, openMaster) {
  const f = (PR.families || []).find(x => x.id === fam);
  if (!f) return go('#/study');
  m.append(h('<a class="back" href="#/study">‹ Families</a>'));
  m.append(h(`<h2>${esc(f.name)}</h2>`));
  const ms = PR.masters.filter(x => x.family === fam);
  ms.forEach(M => {
    const k = M.rules.filter(r => KNOWN.has(r.code)).length;
    const d = h(`<details class="master"${M.code === openMaster || ms.length === 1 ? ' open' : ''}><summary><span class="code">${esc(M.code)}</span><span>${esc(M.title)}</span><span class="cnt2">${k}/${M.rules.length}</span></summary></details>`);
    M.rules.forEach(r => d.append(ruleEl(r, false)));
    m.append(d);
    if (M.code === openMaster) setTimeout(() => d.scrollIntoView({ block: 'start' }), 50);
  });
}

// ================= PLAYBOOK (v1.2) =================
function pbItems() { const out = []; (PB && PB.sections || []).forEach(s => s.chapters.forEach(c => c.items.forEach((it, i) => out.push({ s, c, it, key: c.id + '.' + i })))); return out; }
function codeInfo(code) {
  if (RULE[code]) { const r = RULE[code]; const M = MASTER[r.master]; return { code, text: r.text, title: M.title, fam: M.family, master: M.code }; }
  if (MASTER[code]) { const M = MASTER[code]; return { code, text: M.title, title: M.title, fam: M.family, master: M.code }; }
  return null;
}
function pbItemEl(it, ctx) {
  const el = h(`<div class="pb-item">
    ${ctx ? `<div class="rc">${esc(ctx)}</div>` : ''}
    <div class="pb-t">${esc(it.title)}</div>
    <p>${esc(it.text)}</p>
    ${it.example ? `<div class="pb-ex"><b>Example.</b> ${esc(it.example)}</div>` : ''}
    ${it.codes && it.codes.length ? '<div class="pb-codes"><span class="lab">Backed by</span></div>' : '<div class="pb-codes"><span class="lab muted">Coach\'s judgement</span></div>'}
    <div class="pb-rules"></div></div>`);
  const row = $('.pb-codes', el), box = $('.pb-rules', el);
  (it.codes || []).forEach(code => {
    const info = codeInfo(code); if (!info) return;
    const b = h(`<button class="mini">${esc(code)}</button>`);
    b.onclick = () => {
      const ex = box.querySelector(`[data-c="${code}"]`);
      if (ex) { ex.remove(); b.classList.remove('on'); return; }
      b.classList.add('on');
      const r = h(`<div class="rule" data-c="${esc(code)}"><div class="rc">${esc(code)} · ${esc(info.title)}</div><p>${esc(info.text)}</p>
        <div class="acts"><a class="mini" href="#/study/${encodeURIComponent(info.fam)}/${encodeURIComponent(info.master)}">Open in Study</a></div></div>`);
      box.append(r);
    };
    row.append(b);
  });
  return el;
}
function viewPlaybook(m, args) {
  if (!PB) { m.append(h('<h2>Playbook</h2>')); m.append(h('<div class="empty card">This data zip has no playbook. Re-import the latest PokerMasterclassCoach_DATA.zip from Settings.</div>')); return; }
  const [sid, cid] = args;
  if (sid === 'review') return pbReview(m);
  const sec = PB.sections.find(s => s.id === sid);
  if (sec) {
    m.append(h('<a class="back" href="#/playbook">‹ Playbook</a>'));
    m.append(h(`<h2>${esc(sec.title)}</h2>`));
    m.append(h(`<div class="card"><p style="margin:0">${esc(sec.intro)}</p></div>`));
    sec.chapters.forEach(c => {
      const d = h(`<details class="master"${c.id === cid || sec.chapters.length === 1 ? ' open' : ''}><summary><span class="code">${esc(c.id)}</span><span>${esc(c.title)}</span><span class="cnt2">${c.items.length}</span></summary>
        <p class="muted" style="margin:8px 4px">${esc(c.summary || '')}</p></details>`);
      c.items.forEach(it => d.append(pbItemEl(it)));
      m.append(d);
      if (c.id === cid) setTimeout(() => d.scrollIntoView({ block: 'start' }), 50);
    });
    const i = PB.sections.indexOf(sec), nx = PB.sections[(i + 1) % PB.sections.length];
    m.append(h(`<div class="row" style="margin-top:14px"><a class="btn" href="#/playbook/${encodeURIComponent(nx.id)}">Next: ${esc(nx.title)} ›</a></div>`));
    return;
  }
  m.append(h('<h2>Playbook</h2>'));
  m.append(h(`<p class="muted">The coach's own strategy, built from the ${Object.keys(RULE).length} rules. Every tip links to the rules behind it.</p>`));
  const q = h(`<input class="search" placeholder="Search the playbook: ‘bubble’, ‘station’, ‘turn probe’…" value="${esc(store.get('qPB', ''))}">`);
  m.append(q);
  const out = h('<div style="margin-top:12px"></div>'); m.append(out);
  const paint = () => {
    const s = q.value.trim().toLowerCase(); store.set('qPB', q.value); out.innerHTML = '';
    if (s.length >= 2) {
      const words = s.split(/\s+/);
      const hits = pbItems().filter(x => { const t = (x.it.title + ' ' + x.it.text + ' ' + (x.it.example || '') + ' ' + x.c.title + ' ' + x.s.title).toLowerCase(); return words.every(w => t.includes(w)); });
      out.append(h(`<p class="muted">${hits.length} tips</p>`));
      hits.slice(0, 60).forEach(x => out.append(pbItemEl(x.it, x.s.title + ' › ' + x.c.title)));
      return;
    }
    const g = h('<div class="fam-grid"></div>');
    PB.sections.forEach(sx => {
      const n = sx.chapters.reduce((a, c) => a + c.items.length, 0);
      g.append(h(`<a class="fam" href="#/playbook/${encodeURIComponent(sx.id)}"><div class="n">${esc(sx.title)}</div>
        <div class="e">${sx.chapters.length} chapters · ${n} tips</div>
        <div class="e" style="margin-top:6px">${esc(sx.chapters.map(c => c.title).join(' · '))}</div></a>`));
    });
    out.append(g);
    out.append(h(`<div class="row" style="margin-top:14px"><a class="btn" href="#/playbook/review">🎴 Review mode</a></div>`));
  };
  q.oninput = paint; paint();
}
function pbReview(m) {
  m.append(h('<a class="back" href="#/playbook">‹ Playbook</a>'));
  m.append(h('<h2>Playbook review</h2>'));
  const PBS = store.get('pbSec', []);
  const secs = PB.sections;
  const r = chipRow(secs.map(s => s.id), PBS, id => secs.find(s => s.id === id).title, v => { const i = PBS.indexOf(v); i >= 0 ? PBS.splice(i, 1) : PBS.push(v); store.set('pbSec', PBS); rerender(); });
  r.prepend(h('<span class="lab">Sections</span>')); m.append(r);
  const pool = pbItems().filter(x => !PBS.length || PBS.includes(x.s.id));
  const seen = store.get('pbSeen', {});
  const area = h('<div style="margin-top:12px"></div>'); m.append(area);
  const next = () => {
    const w = pool.map(x => ({ x, w: seen[x.key] === 2 ? 0.3 : seen[x.key] === 1 ? 2 : 3 }));
    let t = w.reduce((a, b) => a + b.w, 0) * Math.random(); let cur = w[w.length - 1].x;
    for (const e of w) { t -= e.w; if (t <= 0) { cur = e.x; break; } }
    area.innerHTML = '';
    const c = h(`<div class="card"><div class="rc">${esc(cur.s.title)} › ${esc(cur.c.title)}</div>
      <p style="font-weight:800;font-size:18px">${esc(cur.it.title)}</p>
      <p class="muted">What is the plan? Think it through, then reveal.</p>
      <div class="row"><button class="btn" id="rv">Reveal</button></div><div id="ans"></div></div>`);
    area.append(c);
    $('#rv', c).onclick = () => {
      $('#rv', c).remove();
      const a = $('#ans', c); a.append(pbItemEl(cur.it));
      const row = h('<div class="row" style="margin-top:10px"><button class="btn" id="r0">Didn\'t know</button><button class="btn" id="r1">Knew it</button></div>');
      a.append(row);
      $('#r0', a).onclick = () => { seen[cur.key] = 1; store.set('pbSeen', seen); next(); };
      $('#r1', a).onclick = () => { seen[cur.key] = 2; store.set('pbSeen', seen); next(); };
    };
  };
  const known = pool.filter(x => seen[x.key] === 2).length;
  m.insertBefore(h(`<div class="stats"><span class="stat"><b>${pool.length}</b> tips in pool</span><span class="stat">Known <b>${known}</b></span></div>`), area);
  if (pool.length) next(); else area.append(h('<div class="empty card">No tips for this filter.</div>'));
}

// ================= FICHAS =================
const FF = store.get('ff', { q: '', type: [], street: [], value: [], stack: [], fav: false });
const STACK_BANDS = { '≤15bb': [0, 15], '16-30bb': [16, 30], '31-60bb': [31, 60], '60bb+': [61, 999] };
let lastList = [];
function fichaMatches(f) {
  if (FF.fav && !FAV.has(f.id)) return false;
  if (FF.type.length && !FF.type.some(t => f.types.includes(t))) return false;
  if (FF.street.length && !FF.street.some(t => f.street.includes(t))) return false;
  if (FF.value.length && !FF.value.includes(f.value)) return false;
  if (FF.stack.length) {
    if (f.stack_min == null) return false;
    if (!FF.stack.some(b => { const [a, z] = STACK_BANDS[b]; return f.stack_max >= a && f.stack_min <= z; })) return false;
  }
  const q = FF.q.trim().toLowerCase();
  if (q.length >= 2) {
    const t = (f.title + ' ' + f.spot + ' ' + (FT[f.file] || '')).toLowerCase();
    if (!q.split(/\s+/).every(w => t.includes(w))) return false;
  }
  return true;
}
function fichaCard(f, compact) {
  const P = parseFicha(f);
  return h(`<a class="fcard" href="#/ficha/${encodeURIComponent(f.id)}">
    <div class="t">${FAV.has(f.id) ? '★ ' : ''}${esc(f.title)}</div>
    <div class="s">${esc(f.spot)}</div>
    ${compact ? '' : `<div class="r">${esc(P.rule)}</div>`}
    <div class="badges"><span class="bd ${esc(f.value)}">${f.value === 'A' ? 'Core' : f.value === 'B' ? 'Useful' : 'Intro'}</span>
    ${f.types.map(t => `<span class="bd">${esc(t)}</span>`).join('')}${f.street.map(t => `<span class="bd">${esc(t)}</span>`).join('')}
    ${f.stack_min != null ? `<span class="bd">${f.stack_min === f.stack_max ? f.stack_min : f.stack_min + '-' + f.stack_max}bb</span>` : ''}</div></a>`);
}
function viewFichas(m) {
  m.append(h('<h2>Lessons</h2>'));
  const q = h(`<input class="search" placeholder="Search: ‘squeeze’, ‘K72’, ‘river overbet’…" value="${esc(FF.q)}">`);
  m.append(q);
  const types = [...new Set(FICHAS.flatMap(f => f.types))];
  const streets = ['Preflop', 'Flop', 'Turn', 'River', 'Multiway', 'ICM', 'General'].filter(s => FICHAS.some(f => f.street.includes(s)));
  const filt = h('<div class="filters"></div>'); m.append(filt);
  const list = h('<div class="flist"></div>'); m.append(list);
  const toggle = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); store.set('ff', FF); paintF(); paintL(); };
  const paintF = () => {
    filt.innerHTML = '';
    const row = (lab, vals, arr, labf = x => x) => { const r = chipRow(vals, arr, labf, v => toggle(arr, v)); r.prepend(h(`<span class="lab">${lab}</span>`)); r.querySelectorAll('.chip').forEach(c => c.classList.add('small')); filt.append(r); };
    row('Type', types, FF.type);
    row('Street', streets, FF.street);
    row('Stack', Object.keys(STACK_BANDS), FF.stack);
    row('Value', ['A', 'B', 'C'], FF.value, v => ({ A: 'A · Core', B: 'B · Useful', C: 'C · Intro' }[v]));
    const r = h('<div class="chips"></div>');
    const fb = h(`<button class="chip small${FF.fav ? ' on' : ''}">★ Favourites</button>`); fb.onclick = () => { FF.fav = !FF.fav; store.set('ff', FF); paintF(); paintL(); };
    const cl = h('<button class="chip small">Clear filters</button>'); cl.onclick = () => { FF.type = []; FF.street = []; FF.value = []; FF.stack = []; FF.fav = false; FF.q = ''; q.value = ''; store.set('ff', FF); paintF(); paintL(); };
    r.append(fb, cl); filt.append(r);
  };
  const paintL = () => {
    lastList = FICHAS.filter(fichaMatches);
    list.innerHTML = '';
    list.append(h(`<p class="muted" style="margin:0">${lastList.length} lessons</p>`));
    lastList.slice(0, 120).forEach(f => list.append(fichaCard(f)));
    if (lastList.length > 120) list.append(h('<p class="muted">Narrow the search to see the rest.</p>'));
  };
  q.oninput = () => { FF.q = q.value; store.set('ff', FF); paintL(); };
  paintF(); paintL();
}
function viewFicha(m, [id]) {
  const f = FBY[id]; if (!f) return go('#/fichas');
  const P = parseFicha(f);
  if (!lastList.length) lastList = FICHAS.filter(fichaMatches);
  const el = h(`<div class="ficha">
    <a class="back" href="#/fichas">‹ Lessons</a>
    <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
      <h1>${esc(f.title)}</h1><button class="icon-btn" id="fv">${FAV.has(f.id) ? '★' : '☆'}</button></div>
    <div class="fspot">${esc(f.spot)}</div>
    <div class="badges"><span class="bd ${esc(f.value)}">${f.value === 'A' ? 'Core' : f.value === 'B' ? 'Useful' : 'Intro'}</span>
      ${f.types.map(t => `<span class="bd">${esc(t)}</span>`).join('')}${f.street.map(t => `<span class="bd">${esc(t)}</span>`).join('')}
      ${f.category.map(t => `<span class="bd">${esc(t)}</span>`).join('')}</div>
    ${P.rule ? `<div class="sec"><h3>Rule</h3><div class="rulebox">${esc(P.rule)}</div></div>` : ''}
    ${P.why ? `<div class="sec"><h3>Why</h3><p style="line-height:1.55;margin:0">${esc(P.why)}</p></div>` : ''}
    ${P.key.length ? `<div class="sec card"><h3>Key points</h3><ul>${P.key.map(k => `<li>${esc(k)}</li>`).join('')}</ul></div>` : ''}
    ${P.numbers ? `<div class="sec card"><h3>Numbers</h3><p style="line-height:1.55;margin:0">${esc(P.numbers)}</p></div>` : ''}
    ${P.extra.length ? `<div class="sec"><ul>${P.extra.map(k => `<li>${esc(k)}</li>`).join('')}</ul></div>` : ''}
    ${P.hooks.length ? `<div class="sec"><h3>S.T.A.C.K. hooks</h3><div class="chips">${P.hooks.map(x => `<span class="chip small">${esc(x)}</span>`).join('')}</div></div>` : ''}
    <div class="sec" id="exs"></div>
    <div class="sec" id="rules"></div>
    <div class="pager"><button class="btn ghost" id="pv">‹ Previous</button><button class="btn ghost" id="nx">Next ›</button></div>
  </div>`);
  m.append(el);
  $('#fv').onclick = () => { FAV.has(f.id) ? FAV.delete(f.id) : FAV.add(f.id); saveFav(); $('#fv').textContent = FAV.has(f.id) ? '★' : '☆'; };
  if (P.ex.length) {
    const ex = $('#exs'); ex.append(h(`<h3>Exercises (${P.ex.length}) — think first, then tap to see the answer</h3>`));
    P.ex.forEach(e => { const c = h(`<div class="ex"><div class="q">${esc(e.q)}</div>${e.a ? `<div class="a">→ ${esc(e.a)}</div><button class="mini">Show answer</button>` : ''}</div>`);
      const b = $('button', c); if (b) b.onclick = () => { c.classList.add('open'); b.remove(); }; ex.append(c); });
  }
  if (f.codes.length) {
    const rb = $('#rules'); rb.append(h('<h3>Related principles</h3>'));
    const box = h('<div class="master" style="margin-top:0"></div>');
    f.codes.map(c => RULE[c]).filter(Boolean).forEach(r => box.append(ruleEl(r, true)));
    rb.append(box);
  }
  const i = lastList.indexOf(f);
  const nav = (d) => { const L = i >= 0 ? lastList : FICHAS; const j = (L.indexOf(f) + d + L.length) % L.length; go('#/ficha/' + encodeURIComponent(L[j].id)); };
  $('#pv').onclick = () => nav(-1); $('#nx').onclick = () => nav(1);
}

// ================= S.T.A.C.K. =================
const LETTERS = [
  { L: 'S', w: 'Situation', es: 'Situación', q: ['Effective stack in bb and SPR?', 'Positions: who is IP / OOP?', 'Format and pressure: chip EV, ICM (who covers whom), PKO (bounties)?', 'Pot type: SRP, 3-bet pot, limped, multiway?'], fam: ['SPR', 'ICM', 'PKO', 'PF', 'PUSH', 'HU'] },
  { L: 'T', w: 'Their range vs mine', es: 'Su rango vs el mío', q: ['What did each action filter? Who is capped?', 'Build his range from the preflop chart + his line.', 'Where is the bottom and the top of each range?'], fam: ['RANGE', 'PF', 'DEF'] },
  { L: 'A', w: 'Advantage', es: 'Ventaja', q: ['Who has the range advantage on this texture?', 'Who has the nut advantage?', 'How does the board change on the next cards?'], fam: ['RANGE', 'CB', 'SIZE', 'MW'] },
  { L: 'C', w: 'Core play', es: 'Jugada base', q: ['Solver default: frequency and size for this spot?', 'Where does my hand sit: value, bluff, or middle (check)?', 'Which size makes his continuing range do what I want?'], fam: ['BET', 'CB', 'BARREL', 'SIZE', 'XR', 'DONK', '3BP', 'RBLUFF', 'RVALUE', 'BCATCH', 'BLOCK'] },
  { L: 'K', w: 'Know the player + Plan', es: 'Conoce al jugador + Plan', q: ['Population or player tendency here? Over-folds, over-calls, under-bluffs?', 'Minimal exploit: what changes vs the core play?', 'Plan the next streets: good and bad cards, how many streets of value?'], fam: ['EXPLOIT', 'BARREL', 'MENTAL'] },
];
const SX = store.get('sx', { street: [], type: [], n: 10 });
let drill = null;
function allExercises() {
  const out = [];
  FICHAS.forEach(f => {
    if (SX.street.length && !SX.street.some(s => f.street.includes(s))) return;
    if (SX.type.length && !SX.type.some(s => f.types.includes(s))) return;
    parseFicha(f).ex.forEach((e, i) => { if (e.a) out.push({ f, e, key: f.id + '#' + i }); });
  });
  return out;
}
function viewStack(m, args) {
  if (args[0] === 'drill') return stackDrill(m);
  m.append(h(`<div class="card"><h2>The S.T.A.C.K. method</h2>
    <p class="muted" style="margin:0">Five questions, in order, to find the highest-EV play in any spot. Not memorizing: thinking every spot the same way. Tap a family to study the principles behind each letter.</p></div>`));
  const L = h('<div class="letters" style="margin-top:12px"></div>');
  LETTERS.forEach(x => {
    const el = h(`<div class="letter"><div class="L">${x.L}</div><div style="flex:1"><div class="w">${x.w}</div>
      <ul class="q">${x.q.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
      <div class="chips" style="margin-top:8px">${x.fam.filter(f => (PR.families || []).some(y => y.id === f)).map(f => `<a class="chip small" href="#/study/${f}">${esc(famName(f))}</a>`).join('')}</div></div></div>`);
    L.append(el);
  });
  m.append(L);
  const n = allExercises().length;
  const card = h(`<div class="card" style="margin-top:14px"><h2>Solve spots with S.T.A.C.K.</h2>
    <p class="muted">Real spots taken from the lessons. Walk through the 5 letters, decide your play, then compare with the coach's answer. <b id="nx">${n}</b> spots match this filter.</p>
    <div class="filters" id="sxf"></div>
    <div class="row" id="sxn"></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="start">Start</button></div></div>`);
  m.append(card);
  const sxf = $('#sxf', card);
  const paint = () => {
    sxf.innerHTML = '';
    const tg = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); store.set('sx', SX); paint(); };
    const r1 = chipRow(['Preflop', 'Flop', 'Turn', 'River', 'Multiway', 'ICM'], SX.street, x => x, v => tg(SX.street, v)); r1.prepend(h('<span class="lab">Street</span>'));
    const r2 = chipRow(['Vanilla', 'PKO', 'ICM', 'Mental'], SX.type, x => x, v => tg(SX.type, v)); r2.prepend(h('<span class="lab">Type</span>'));
    [r1, r2].forEach(r => { r.querySelectorAll('.chip').forEach(c => c.classList.add('small')); sxf.append(r); });
    const sn = $('#sxn', card); sn.innerHTML = '';
    const r3 = chipRow([10, 20, 50], SX.n, x => x + ' spots', v => { SX.n = v; store.set('sx', SX); paint(); }); r3.prepend(h('<span class="lab">Session</span>'));
    sn.append(r3);
    $('#nx', card).textContent = allExercises().length;
  };
  paint();
  $('#start', card).onclick = () => {
    const pool = allExercises(); if (!pool.length) return alert('No spots match this filter.');
    drill = { list: shuffle(pool).slice(0, SX.n), i: 0, ok: 0, bad: 0 };
    go('#/stack/drill');
  };
}
function stackDrill(m) {
  if (!drill) return go('#/stack');
  if (drill.i >= drill.list.length) {
    const acc = Math.round(100 * drill.ok / Math.max(1, drill.list.length));
    saveHist({ mode: 'S.T.A.C.K. spots', n: drill.list.length, ok: drill.ok, filt: [...SX.street, ...SX.type].join(', ') || 'All' });
    m.append(h(`<div class="card welcome"><div class="big-num">${acc}%</div><h2>Session complete</h2><p class="muted">${drill.ok} right · ${drill.bad} to review</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/stack">Back</a></div></div>`));
    drill = null; return;
  }
  const { f, e } = drill.list[drill.i];
  const P = parseFicha(f);
  const card = h(`<div class="card">
    <div class="row" style="justify-content:space-between"><b>Spot ${drill.i + 1} / ${drill.list.length}</b><span class="score"><span>✅ ${drill.ok}</span><span>❌ ${drill.bad}</span></span></div>
    <div class="qprog"><div style="width:${100 * drill.i / drill.list.length}%"></div></div>
    <div class="drillctx">${esc(f.title)} — ${esc(f.spot)}</div>
    <div class="drillq">${esc(e.q)}</div>
    <p class="muted" style="margin:4px 0 8px">Tap each letter once you have thought it through:</p>
    <div class="letters" id="ls"></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="rv">Show the coach's answer</button></div>
    <div id="ans" style="display:none;margin-top:12px">
      <div class="answer">→ ${esc(e.a)}</div>
      ${P.rule ? `<p style="line-height:1.5"><b>Rule:</b> ${esc(P.rule)}</p>` : ''}
      <div class="row"><a class="mini" href="#/ficha/${encodeURIComponent(f.id)}">Open lesson</a></div>
      <p style="font-weight:700;margin:14px 0 8px">Did you get it right?</p>
      <div class="row"><button class="btn bad" id="no">No</button><button class="btn" id="si">Yes</button></div>
    </div></div>`);
  m.append(card);
  const ls = $('#ls', card);
  LETTERS.forEach(x => { const el = h(`<div class="letter" style="padding:10px"><div class="L" style="font-size:26px">${x.L}</div><div><div class="w" style="font-size:15px">${x.w}</div><div class="muted" style="font-size:13px">${esc(x.q[0])}</div></div></div>`);
    el.onclick = () => el.classList.toggle('done'); ls.append(el); });
  $('#rv', card).onclick = () => { $('#ans', card).style.display = ''; $('#rv', card).style.display = 'none'; };
  const next = (ok) => { ok ? drill.ok++ : drill.bad++; drill.i++; rerender(); };
  $('#si', card).onclick = () => next(true); $('#no', card).onclick = () => next(false);
}

// ================= RANGOS =================
function spotLabel(e) {
  const v = (e.vs || '').split('-').map(p => POS_LABEL[p] || p).join(' + ');
  switch (e.type) {
    case 'rfi': return 'RFI — first in';
    case 'vsrfi': return `vs open from ${v}`;
    case 'vsopenjam': return `vs open-jam from ${v}`;
    case 'vslimp': return `vs limp from ${v}`;
    case 'vslimp-allin': { const [a, b] = (e.vs || '').split('-'); return `vs limp from ${POS_LABEL[a]} + POL from ${POS_LABEL[b]}`; }
    case 'vs3bet': return `You open → 3bet from ${v}`;
    case 'vsallin': return `You open → all-in from ${v}`;
    case 'limp-vsraise': return `Limp → ROL from ${v}`;
    case 'limp-vsallin': return `Limp → POL from ${v}`;
    default: return `${e.type} ${v}`;
  }
}
const spotKey = (e) => e.type + ':' + (e.vs || '');
const fullLabel = (e) => `${POS_LABEL[e.pos]} · ${e.stack}bb · ${spotLabel(e)}`;
const CHIP = {
  rfi: { cls: 'me', icon: '▶', txt: 'RFI' }, vslimp: { cls: 'lp', icon: '=', txt: 'limp' }, vsrfi: { cls: 'op', icon: '↗', txt: 'open' },
  vsopenjam: { cls: 'jm', icon: '⚡', txt: 'jam' }, 'vslimp-allin': { cls: 'pol', icon: '⚡', txt: 'POL' },
  vs3bet: { cls: 'tb', icon: '⇈', txt: '3bet', band: 'bR' }, vsallin: { cls: 'jm', icon: '⚡', txt: 'jam', band: 'bR' },
  'limp-vsraise': { cls: 'rol', icon: '↗', txt: 'ROL', band: 'bL' }, 'limp-vsallin': { cls: 'pol', icon: '⚡', txt: 'POL', band: 'bL' },
};
const CHIP_ORDER = ['vslimp', 'vsrfi', 'vsopenjam', 'vslimp-allin', 'limp-vsraise', 'limp-vsallin', 'vs3bet', 'vsallin'];
function seatOf(e) { if (e.type === 'rfi') return null; const p = (e.vs || '').split('-'); return e.type === 'vslimp-allin' ? p[p.length - 1] : p[0]; }
function tableLine(hero, list, cur, onPick, badge) {
  const wrap = h('<div class="tline"></div>'); const hi = POS.indexOf(hero);
  POS.forEach((p, i) => {
    const seat = h(`<div class="seat${p === hero ? ' hero' : ''}"><div class="sn">${p === hero ? POS_LABEL[p] + ' · you' : POS_LABEL[p]}</div></div>`);
    const mine = p === hero ? list.filter(e => e.type === 'rfi') : list.filter(e => seatOf(e) === p).sort((a, b) => CHIP_ORDER.indexOf(a.type) - CHIP_ORDER.indexOf(b.type));
    if (!mine.length) seat.classList.add('empty');
    mine.forEach(e => {
      const c = CHIP[e.type] || { cls: 'op', icon: '•', txt: e.type };
      let txt = c.txt; if (e.type === 'vslimp' && (e.vs || '').includes('-')) txt = 'limp ×2';
      const n = badge ? badge(e) : '';
      const b = h(`<button class="m ${c.cls} ${c.band || ''}" title="${esc(spotLabel(e))}"><span class="ic">${c.icon}</span>${esc(txt)}${n ? `<span class="cnt">${n}</span>` : ''}</button>`);
      if (e === cur) b.classList.add('sel'); b.onclick = () => onPick(e); seat.append(b);
    });
    if (i === hi && i > 0) wrap.append(h('<div class="sep"></div>'));
    wrap.append(seat);
    if (i === hi && i < POS.length - 1) wrap.append(h('<div class="sep"></div>'));
  });
  const box = h('<div class="tbox"></div>'); box.append(wrap); return box;
}
function noRanges(m) { m.append(h('<div class="empty card">This data zip has no range images. Re-import the full zip from Settings.</div>')); }
const RS = store.get('rs', { mode: 'study', pos: 'utg', stack: 100, file: null });
function viewRanges(m) {
  if (!RINDEX.length) return noRanges(m);
  m.append(chipRow(['study', 'evo', 'pos'], RS.mode, k => ({ study: 'Study', evo: '⇣ By stack', pos: '⇢ By position' }[k]), k => { RS.mode = k; store.set('rs', RS); rerender(); }));
  m.append(h('<div style="height:10px"></div>'));
  if (RS.mode === 'study') rangesStudy(m); else if (RS.mode === 'evo') compareEvo(m); else comparePos(m);
}
function rangesStudy(m) {
  if (!BY[RS.pos]) RS.pos = POS.find(p => BY[p]);
  if (!BY[RS.pos][RS.stack]) RS.stack = stacksOf(RS.pos)[0];
  const list = BY[RS.pos][RS.stack];
  const cur = list.find(e => e.file === RS.file) || list[0];
  RS.file = cur.file; store.set('rs', RS);
  m.append(chipRow(POS, RS.pos, p => POS_LABEL[p], p => { RS.pos = p; RS.file = null; rerender(); }, p => !BY[p]));
  m.append(h('<div style="height:8px"></div>'));
  m.append(chipRow(allStacks(), RS.stack, s => s + 'bb', s => { RS.stack = s; RS.file = null; rerender(); }, s => !BY[RS.pos][s]));
  m.append(h('<div style="height:10px"></div>'));
  m.append(tableLine(RS.pos, list, cur, e => { RS.file = e.file; store.set('rs', RS); rerender(); }));
  const viewer = h(`<div class="viewer"><div class="viewer-head"><div class="viewer-title">${esc(fullLabel(cur))}</div>
    <div class="nav-row"><button class="icon-btn" id="prev">‹</button><button class="icon-btn" id="next">›</button></div></div>
    <div class="frame"><img id="study-img" alt=""></div>
    <p class="muted" style="font-size:13px">Tap the image to enlarge it. Swipe to change range.</p></div>`);
  m.append(viewer);
  setImg($('#study-img'), cur.file); $('#study-img').onclick = () => openLightbox(cur);
  const mv = (d) => { const i = list.indexOf(cur); RS.file = list[(i + d + list.length) % list.length].file; store.set('rs', RS); rerender(); };
  $('#prev').onclick = () => mv(-1); $('#next').onclick = () => mv(1);
  let x0 = null;
  viewer.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  viewer.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 60) mv(dx < 0 ? 1 : -1); x0 = null; }, { passive: true });
}
function tiles(m, entries, labelFn) {
  const g = h('<div class="grid"></div>');
  entries.forEach(e => { const t = h(`<button class="tile"><div class="lbl"><span>${esc(labelFn(e))}</span></div><div class="frame"><img alt=""></div></button>`);
    setImg($('img', t), e.file); t.onclick = () => openLightbox(e); g.append(t); });
  m.append(g);
}
function compareEvo(m) {
  m.append(chipRow(POS, RS.pos, p => POS_LABEL[p], p => { RS.pos = p; store.set('rs', RS); rerender(); }, p => !BY[p]));
  const entries = RINDEX.filter(e => e.pos === RS.pos);
  const keys = {}; entries.forEach(e => { (keys[spotKey(e)] ||= []).push(e); });
  if (!keys[RS.key]) RS.key = keys['rfi:'] ? 'rfi:' : Object.keys(keys)[0];
  m.append(h('<div style="height:10px"></div>'));
  m.append(tableLine(RS.pos, Object.values(keys).map(l => l[0]), keys[RS.key][0], e => { RS.key = spotKey(e); store.set('rs', RS); rerender(); }, e => keys[spotKey(e)].length));
  m.append(h('<div style="height:10px"></div>'));
  tiles(m, keys[RS.key].slice().sort((a, b) => b.stack - a.stack), e => e.stack + 'bb');
}
function comparePos(m) {
  const st = allStacks(); if (!st.includes(RS.cstack)) RS.cstack = st[0];
  m.append(chipRow(st, RS.cstack, s => s + 'bb', s => { RS.cstack = s; store.set('rs', RS); rerender(); }));
  const at = RINDEX.filter(e => e.stack === RS.cstack);
  const types = TYPE_ORDER.filter(t => at.some(e => e.type === t));
  if (!types.includes(RS.ctype)) RS.ctype = types[0];
  const tr = h('<div class="chips" style="margin-top:10px"></div>');
  types.forEach(t => { const c = CHIP[t]; const b = h(`<button class="m ${c.cls} ${c.band || ''}" style="width:auto;padding:8px 14px"><span class="ic">${c.icon}</span>${esc(c.txt)}</button>`);
    if (t === RS.ctype) b.classList.add('sel'); b.onclick = () => { RS.ctype = t; RS.cvs = ''; store.set('rs', RS); rerender(); }; tr.append(b); });
  m.append(tr);
  const of = at.filter(e => e.type === RS.ctype);
  const vss = [...new Set(of.map(e => e.vs || ''))].sort((a, b) => POS.indexOf(a.split('-')[0]) - POS.indexOf(b.split('-')[0]));
  if (!vss.includes(RS.cvs)) RS.cvs = vss[0];
  if (vss.length > 1 || vss[0]) {
    const vr = chipRow(vss, RS.cvs, v => 'vs ' + v.split('-').map(p => POS_LABEL[p] || p).join(' + '), v => { RS.cvs = v; store.set('rs', RS); rerender(); });
    vr.style.marginTop = '8px'; vr.querySelectorAll('.chip').forEach(c => c.classList.add('small')); m.append(vr);
  }
  m.append(h('<div style="height:10px"></div>'));
  tiles(m, of.filter(e => (e.vs || '') === RS.cvs).sort((a, b) => POS.indexOf(a.pos) - POS.indexOf(b.pos)), e => POS_LABEL[e.pos]);
}

// ================= TRAINER =================
const TR = store.get('tr', { mode: 'pick', pos: [], stack: [], sit: [], n: 20 });
const SRS = store.get('srs', {});
let ses = null;
function saveHist(x) { const hst = store.get('hist', []); hst.unshift({ ...x, d: new Date().toISOString() }); store.set('hist', hst.slice(0, 60)); }
function trPool() {
  return RINDEX.filter(e => (!TR.pos.length || TR.pos.includes(e.pos)) && (!TR.stack.length || TR.stack.includes(e.stack)) && (!TR.sit.length || TR.sit.includes(sitOf(e.type))));
}
const MODES = { pick: 'Which range? (3 options)', guess: 'Which spot is it?', flash: 'Flashcards' };
function viewTrainer(m, args) {
  if (!RINDEX.length) return noRanges(m);
  if (args[0] === 'run' && ses) return trainerRun(m);
  m.append(h('<h2>Range trainer</h2>'));
  const c = h('<div class="card"></div>'); m.append(c);
  const tg = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); store.set('tr', TR); rerender(); };
  const row = (lab, el) => { el.prepend(h(`<span class="lab">${lab}</span>`)); el.querySelectorAll('.chip').forEach(x => x.classList.add('small')); el.style.marginTop = '10px'; c.append(el); };
  row('Mode', chipRow(Object.keys(MODES), TR.mode, k => MODES[k], k => { TR.mode = k; store.set('tr', TR); rerender(); }));
  row('Position', chipRow(POS.filter(p => BY[p]), TR.pos, p => POS_LABEL[p], p => tg(TR.pos, p)));
  row('Stack', chipRow(allStacks(), TR.stack, s => s + 'bb', s => tg(TR.stack, s)));
  row('Situation', chipRow(Object.keys(SIT), TR.sit, k => SIT[k], k => tg(TR.sit, k)));
  row('Exercises', chipRow([10, 20, 50, 100, 150, 200], TR.n, n => String(n), n => { TR.n = n; store.set('tr', TR); rerender(); }));
  const p = trPool();
  c.append(h(`<p class="muted" style="margin-top:12px">${p.length} ranges match this filter (no filter = all).</p>`));
  const b = h('<button class="btn">Start</button>'); c.append(b);
  b.disabled = !p.length;
  b.onclick = () => { ses = { mode: TR.mode, n: TR.n, i: 0, ok: 0, bad: 0, mid: 0, wrong: [] }; go('#/trainer/run'); };
  const hist = store.get('hist', []);
  const hc = h(`<div class="card" style="margin-top:14px"><h2>Progress</h2></div>`); m.append(hc);
  if (!hist.length) hc.append(h('<p class="muted">No sessions yet.</p>'));
  else {
    const tot = hist.reduce((a, x) => a + x.n, 0), ok = hist.reduce((a, x) => a + x.ok, 0);
    hc.append(h(`<div class="stats"><span class="stat"><b>${hist.length}</b> sessions</span><span class="stat"><b>${tot}</b> exercises</span><span class="stat">Overall accuracy <b>${Math.round(100 * ok / Math.max(1, tot))}%</b></span><span class="stat">Flashcards mastered <b>${Object.values(SRS).filter(s => s.box >= 3).length}</b></span></div>`));
    const t = h('<table class="hist" style="margin-top:10px"><thead><tr><th>Date</th><th>Mode</th><th>Filter</th><th>Result</th></tr></thead><tbody></tbody></table>');
    hist.slice(0, 20).forEach(x => $('tbody', t).append(h(`<tr><td>${new Date(x.d).toLocaleDateString('en-GB')}</td><td>${esc(x.mode)}</td><td>${esc(x.filt || '')}</td><td><b>${Math.round(100 * x.ok / Math.max(1, x.n))}%</b> (${x.ok}/${x.n})</td></tr>`)));
    hc.append(t);
  }
}
function filtLabel() {
  const a = [...TR.pos.map(p => POS_LABEL[p]), ...TR.stack.map(s => s + 'bb'), ...TR.sit.map(s => SIT[s])];
  return a.join(', ') || 'All';
}
function weightOf(e) { const s = SRS[e.file]; if (!s) return 3; return [6, 4, 2, 1, 0.5][Math.min(s.box, 4)]; }
function weightedPick(list) { const t = list.reduce((a, e) => a + weightOf(e), 0); let r = Math.random() * t; for (const e of list) { r -= weightOf(e); if (r <= 0) return e; } return list[list.length - 1]; }
function trainerRun(m) {
  const pool = trPool();
  if (ses.i >= ses.n || !pool.length) {
    const acc = Math.round(100 * ses.ok / Math.max(1, ses.i));
    saveHist({ mode: MODES[ses.mode], n: ses.i, ok: ses.ok, filt: filtLabel() });
    const c = h(`<div class="card welcome"><div class="big-num">${acc}%</div><h2>Session complete</h2>
      <p class="muted">${ses.ok} right · ${ses.bad} wrong${ses.mid ? ' · ' + ses.mid + ' so-so' : ''} · of ${ses.i}</p><div id="wr"></div>
      <div class="row" style="justify-content:center;margin-top:12px"><a class="btn" href="#/trainer">Back to trainer</a></div></div>`);
    m.append(c);
    if (ses.wrong.length) { const w = $('#wr', c); w.append(h('<h3>To review</h3>')); [...new Set(ses.wrong)].slice(0, 20).forEach(f => { const e = RINDEX.find(x => x.file === f); if (e) { const b = h(`<button class="chip small" style="margin:3px">${esc(fullLabel(e))}</button>`); b.onclick = () => openLightbox(e); w.append(b); } }); }
    ses = null; return;
  }
  const head = h(`<div><div class="row" style="justify-content:space-between"><b>${MODES[ses.mode]} · ${ses.i + 1} / ${ses.n}</b>
    <span class="score"><span>✅ ${ses.ok}</span>${ses.mode === 'flash' ? `<span>🟡 ${ses.mid}</span>` : ''}<span>❌ ${ses.bad}</span></span>
    <a class="mini" href="#/trainer">Exit</a></div><div class="qprog"><div style="width:${100 * ses.i / ses.n}%"></div></div></div>`);
  m.append(head);
  const area = h('<div class="card"></div>'); m.append(area);
  ({ pick: trPick, guess: trGuess, flash: trFlash })[ses.mode](area, pool);
}
const nextQ = () => { ses.i++; rerender(); };
function distractors(e) {
  const same = (x) => x.file !== e.file;
  const stacks = RINDEX.filter(x => same(x) && x.pos === e.pos && spotKey(x) === spotKey(e)).sort((a, b) => Math.abs(a.stack - e.stack) - Math.abs(b.stack - e.stack));
  const spots = RINDEX.filter(x => same(x) && x.pos === e.pos && x.stack === e.stack && spotKey(x) !== spotKey(e));
  const poss = RINDEX.filter(x => same(x) && x.stack === e.stack && spotKey(x) === spotKey(e) && x.pos !== e.pos);
  const cands = shuffle([...stacks.slice(0, 3), ...shuffle(spots).slice(0, 2), ...shuffle(poss).slice(0, 2)]);
  const out = []; for (const x of cands) { if (!out.some(y => y.file === x.file)) out.push(x); if (out.length === 2) break; }
  while (out.length < 2) { const x = pick(RINDEX); if (same(x) && !out.includes(x)) out.push(x); }
  return out;
}
function trPick(area, pool) {
  const e = weightedPick(pool);
  const opts = shuffle([e, ...distractors(e)]);
  area.append(h(`<p class="muted" style="margin:0">Pick the correct range for this spot:</p><div class="prompt">${esc(POS_LABEL[e.pos])} · ${e.stack}bb<br>${esc(spotLabel(e))}</div>`));
  const g = h('<div class="choices"></div>'); area.append(g);
  const fb = h('<div></div>'); area.append(fb);
  let done = false;
  opts.forEach((o, i) => {
    const b = h(`<button class="choice"><div class="frame"><img alt=""></div><div class="cap">Option ${'ABC'[i]}</div></button>`);
    setImg($('img', b), o.file);
    b.onclick = () => {
      if (done) { openLightbox(o); return; }
      done = true;
      const ok = o === e;
      g.querySelectorAll('.choice').forEach((x, j) => { const oo = opts[j]; $('.cap', x).textContent = fullLabel(oo); if (oo === e) x.classList.add('right'); else if (x === b) x.classList.add('wrong'); });
      ok ? ses.ok++ : (ses.bad++, ses.wrong.push(e.file));
      const s = SRS[e.file] || { box: 0 }; s.box = ok ? Math.min(4, s.box + 1) : 0; SRS[e.file] = s; store.set('srs', SRS);
      fb.append(h(`<div class="fb ${ok ? 'ok' : 'ko'}">${ok ? '✓ Correct!' : '✗ No — the correct one is in green'}</div>`));
      const n = h('<div class="row" style="margin-top:12px"><button class="btn">Next →</button><span class="muted" style="font-size:13px">Tap an image to enlarge it.</span></div>');
      $('button', n).onclick = nextQ; fb.append(n);
    };
    g.append(b);
  });
}
function trGuess(area, pool) {
  const e = pick(pool);
  const posOpts = shuffle([e.pos, ...shuffle(POS.filter(x => x !== e.pos && BY[x])).slice(0, 2)]);
  const st = allStacks(); const si = st.indexOf(e.stack);
  const stackOpts = [e.stack, ...st.filter(s => s !== e.stack).sort((a, b) => Math.abs(st.indexOf(a) - si) - Math.abs(st.indexOf(b) - si)).slice(0, 2)].sort((a, b) => b - a);
  const p2 = (BY[e.pos][e.stack] || []).filter(x => spotKey(x) !== spotKey(e));
  const p3 = p2.length >= 2 ? p2 : RINDEX.filter(x => x.pos === e.pos && spotKey(x) !== spotKey(e));
  const spotOpts = shuffle([spotLabel(e), ...[...new Set(shuffle(p3.slice()).map(spotLabel))].filter(l => l !== spotLabel(e)).slice(0, 2)]);
  const ans = {};
  area.append(h(`<p class="muted" style="margin:0 0 10px">Look at the range and name the spot.</p>
    <div class="frame" id="gframe"><img id="gimg" alt=""><div class="cover" id="gcover">?</div></div>
    <div class="qgroup"><h3>Position</h3><div class="chips" id="q-pos"></div></div>
    <div class="qgroup"><h3>Stack</h3><div class="chips" id="q-stack"></div></div>
    <div class="qgroup"><h3>Situation</h3><div class="chips" id="q-spot"></div></div>
    <div class="row" style="margin-top:16px"><button class="btn" id="check" disabled>Check</button><button class="btn" id="nq" style="display:none">Next →</button></div>
    <div id="res"></div>`));
  setImg($('#gimg'), e.file);
  let done = false;
  const grp = (id, opts, lab, k) => { const c = $('#' + id); opts.forEach(o => { const b = h(`<button class="opt">${esc(lab(o))}</button>`); b._v = o;
    b.onclick = () => { if (done) return; ans[k] = o; c.querySelectorAll('.opt').forEach(x => x.classList.toggle('on', x === b)); $('#check').disabled = !(ans.pos && ans.stack && ans.spot); }; c.append(b); }); };
  grp('q-pos', posOpts, x => POS_LABEL[x], 'pos'); grp('q-stack', stackOpts, x => x + 'bb', 'stack'); grp('q-spot', spotOpts, x => x, 'spot');
  $('#check').onclick = () => {
    done = true; const right = { pos: e.pos, stack: e.stack, spot: spotLabel(e) }; let hits = 0;
    [['q-pos', 'pos'], ['q-stack', 'stack'], ['q-spot', 'spot']].forEach(([id, k]) => { $('#' + id).querySelectorAll('.opt').forEach(b => { b.classList.remove('on'); if (b._v === right[k]) b.classList.add('right'); else if (b._v === ans[k]) b.classList.add('wrong'); }); if (ans[k] === right[k]) hits++; });
    const ok = hits === 3; ok ? ses.ok++ : (ses.bad++, ses.wrong.push(e.file));
    $('#gcover').remove(); $('#gimg').onclick = () => openLightbox(e);
    $('#res').append(h(`<div class="fb ${ok ? 'ok' : 'ko'}">${ok ? '✓ Correct!' : `✗ ${hits}/3 — it was ${esc(fullLabel(e))}`}</div>`));
    $('#check').style.display = 'none'; $('#nq').style.display = '';
  };
  $('#nq').onclick = nextQ;
}
function trFlash(area, pool) {
  const e = weightedPick(pool); const box = (SRS[e.file] || { box: -1 }).box;
  area.append(h(`<p class="muted" style="margin:0">Picture the range before you look: what do you open, call, fold?</p>
    <div class="prompt">${esc(POS_LABEL[e.pos])} · ${e.stack}bb<br>${esc(spotLabel(e))}</div>
    <p class="muted" style="font-size:13px">${box < 0 ? 'New' : 'Level ' + box + ' of 4'}</p>
    <button class="btn" id="reveal">Show range</button>
    <div id="ans" style="display:none;margin-top:14px"><div class="frame"><img id="fimg" alt=""></div>
      <p style="font-weight:700;margin:14px 0 8px">How did you do?</p>
      <div class="row"><button class="btn bad" data-g="0">Wrong</button><button class="btn mid" data-g="1">So-so</button><button class="btn" data-g="2">Right</button></div></div>`));
  $('#reveal').onclick = () => { $('#reveal').style.display = 'none'; $('#ans').style.display = ''; setImg($('#fimg'), e.file); };
  $('#fimg').onclick = () => openLightbox(e);
  area.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
    const g = Number(b.dataset.g); const s = SRS[e.file] || { box: 0 };
    s.box = g === 0 ? 0 : g === 1 ? Math.max(0, s.box) : Math.min(4, s.box + 1); SRS[e.file] = s; store.set('srs', SRS);
    if (g === 2) ses.ok++; else if (g === 1) ses.mid++; else { ses.bad++; ses.wrong.push(e.file); }
    nextQ();
  });
}

// ================= AJUSTES =================
async function viewSettings(m) {
  const imported = await getMeta('importedAt').catch(() => null);
  let persisted = false, usage = '';
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) {}
  try { if (navigator.storage && navigator.storage.estimate) { const est = await navigator.storage.estimate(); usage = (est.usage / 1048576).toFixed(0) + ' MB used'; } } catch (e) {}
  const dark = document.body.classList.contains('dark');
  m.append(h(`<div class="card"><h2>Settings</h2>
    ${ready() ? `<p><b>${FICHAS.length}</b> lessons · <b>${Object.keys(RULE).length}</b> rules · <b>${RINDEX.length}</b> ranges${imported ? ' · imported on ' + new Date(imported).toLocaleDateString('en-GB') : ''}.</p>
    <p class="muted">Data built: ${esc(MAN && MAN.built || '')} · Playbook: ${PB ? pbItems().length + ' tips' : 'not in this zip'} · App v${VERSION}</p>` : '<p>No data imported yet.</p>'}
    <p class="muted">${usage}${usage ? ' · ' : ''}${persisted ? 'Storage protected ✓' : 'Add the app to your Home Screen so the iPad does not delete the data.'}</p>
    <div class="row" style="margin-top:14px">
      <button class="btn" id="s-imp">${ready() ? 'Re-import data' : 'Import data'}</button>
      <button class="btn ghost" id="s-dark">${dark ? '☀️ Light mode' : '🌙 Dark mode'}</button>
    </div>
    <h3>Progress</h3>
    <div class="row">
      <button class="btn ghost" id="s-k">Reset mastered rules (${KNOWN.size})</button>
      <button class="btn ghost" id="s-t">Reset trainer and history</button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:18px">Poker Masterclass Coach · v${VERSION}</p></div>`));
  $('#s-imp').onclick = runImport;
  $('#s-dark').onclick = () => { setDark(!dark); rerender(); };
  $('#s-k').onclick = () => { if (confirm('Clear all rules marked as mastered?')) { KNOWN.clear(); saveKnown(); rerender(); } };
  $('#s-t').onclick = () => { if (confirm('Clear trainer progress and history?')) { for (const k in SRS) delete SRS[k]; store.set('srs', SRS); store.set('hist', []); rerender(); } };
}

// ---------- arranque ----------
async function boot() {
  setDark(store.get('dark', false));
  $('#lb-close').onclick = () => $('#lightbox').classList.add('hidden');
  $('#lb-zoom-in').onclick = () => zoomLB(0.5);
  $('#lb-zoom-out').onclick = () => zoomLB(-0.5);
  try { const d = await getMeta('data'); if (d && d.principles) loadData(d); } catch (e) { console.warn(e); }
  window.addEventListener('hashchange', route);
  route();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
