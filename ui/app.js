'use strict';
/* PhotoCleaner UI. No build step: plain JS talking to the Rust core through window.__TAURI__. */

const TAURI = window.__TAURI__;
const { invoke, Channel, convertFileSrc } = TAURI.core;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- i18n ----------
const I18N = {
  uk: {
    pick: 'Додати папки…', recursive: 'З підпапками', rescan: 'Пересканувати', cancel: 'Скасувати',
    permanent: 'Видалити назавжди (без кошика)', del: 'Видалити ({0})',
    tabOver: 'Засвічені', tabUnder: 'Темні', tabBlur: 'Розмиті', tabSeries: 'Серії', tabDups: 'Дублікати', tabLow: 'Мала роздільність',
    thrLow: 'Менше ніж (Мп)', noDups: 'Точних дублікатів не знайдено.', dupTitle: 'Дублікат {0}', zoomSize: 'Розмір',
    selectAll: 'Позначити всі ({0})', clearAll: 'Зняти позначки', invert: 'Інвертувати',
    thrOver: 'Засвіт: середня яскравість ≥', thrUnder: 'Темрява: середня яскравість ≤', thrBlur: 'Розмитість: різкість ≤',
    gap: 'Інтервал між кадрами', sim: 'Різниця до', keepN: 'Лишати найкращих', autoMark: 'Лишити найкращі в усіх серіях',
    unmarkSeries: 'Зняти всі позначки серій',
    seriesStats: '{0} серій · {1} фото · зайвих: {2}',
    emptyHint: 'Додайте папки з фотографіями — програма просканує їх, знайде засвічені, темні, розмиті кадри та серії схожих знімків.',
    emptyCat: 'У цій категорії нічого не знайдено. Спробуйте змінити поріг.',
    noSeries: 'Серій схожих знімків не знайдено. Збільште інтервал або допустиму різницю.',
    scanning: 'Аналіз {0} / {1} — результати з’являються одразу', scanFound: 'Пошук файлів…', scanDone: 'Проскановано {0} фото{1}.', failedN: ', не вдалося прочитати: {0}',
    marked: 'До видалення: <b>{0}</b> · {1}', nothing: 'Нічого не позначено',
    confirmTrash: 'Перемістити {0} файл(ів) ({1}) у кошик?', confirmPerm: 'НАЗАВЖДИ видалити {0} файл(ів) ({1})? Це незворотно!',
    deletedN: 'Видалено: {0} ({1})', errorsN: ', помилок: {0}',
    seriesTitle: 'Серія {0}', photosN: '{0} фото', onlyBest: 'Лишити найкраще', keepAll: 'Лишити всі',
    best: '★ найкраще', sharp: 'різкість', bright: 'яскр.', mark: 'Позначити на видалення', unmark: 'Зняти позначку',
    zoom: 'Переглянути', pickFailed: 'Не вдалося відкрити діалог вибору папки',
  },
  en: {
    pick: 'Add folders…', recursive: 'Include subfolders', rescan: 'Rescan', cancel: 'Cancel',
    permanent: 'Delete permanently (skip trash)', del: 'Delete ({0})',
    tabOver: 'Overexposed', tabUnder: 'Underexposed', tabBlur: 'Blurry', tabSeries: 'Series', tabDups: 'Duplicates', tabLow: 'Low resolution',
    thrLow: 'Smaller than (MP)', noDups: 'No exact duplicates found.', dupTitle: 'Duplicate {0}', zoomSize: 'Size',
    selectAll: 'Select all ({0})', clearAll: 'Clear selection', invert: 'Invert',
    thrOver: 'Overexposed: mean brightness ≥', thrUnder: 'Underexposed: mean brightness ≤', thrBlur: 'Blur: sharpness ≤',
    gap: 'Max gap between shots', sim: 'Max difference', keepN: 'Keep best', autoMark: 'Keep best in all series',
    unmarkSeries: 'Clear all series marks',
    seriesStats: '{0} series · {1} photos · redundant: {2}',
    emptyHint: 'Add folders with photos — the app will scan them and find overexposed, dark and blurry shots, plus series of near-identical photos.',
    emptyCat: 'Nothing found in this category. Try adjusting the threshold.',
    noSeries: 'No series of similar photos found. Increase the time gap or allowed difference.',
    scanning: 'Analyzing {0} / {1} — results appear as they come', scanFound: 'Looking for files…', scanDone: 'Scanned {0} photos{1}.', failedN: ', unreadable: {0}',
    marked: 'Marked for deletion: <b>{0}</b> · {1}', nothing: 'Nothing marked',
    confirmTrash: 'Move {0} file(s) ({1}) to the trash?', confirmPerm: 'PERMANENTLY delete {0} file(s) ({1})? This cannot be undone!',
    deletedN: 'Deleted: {0} ({1})', errorsN: ', errors: {0}',
    seriesTitle: 'Series {0}', photosN: '{0} photos', onlyBest: 'Keep best only', keepAll: 'Keep all',
    best: '★ best', sharp: 'sharpness', bright: 'bright', mark: 'Mark for deletion', unmark: 'Unmark',
    zoom: 'Preview', pickFailed: 'Could not open the folder dialog',
  },
};
const LANG = (navigator.language || 'en').toLowerCase().startsWith('uk') ? 'uk' : 'en';
const t = (k, ...a) => (I18N[LANG][k] ?? k).replace(/\{(\d+)\}/g, (_, i) => a[i]);
document.documentElement.lang = LANG;
document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));

// ---------- state ----------
const DEFAULT_CFG = { overMean: 185, underMean: 60, blur: 60, gapSec: 30, simPct: 20, keepN: 1, lowMp: 0.8, card: 170 };
const S = {
  folders: [], photos: [], byPath: new Map(), marked: new Set(), series: [], dups: [],
  tab: 'over', cfg: { ...DEFAULT_CFG }, scanning: false, view: [], modalIdx: -1,
};
try {
  Object.assign(S.cfg, JSON.parse(localStorage.getItem('pc.cfg') || '{}'));
  S.folders = JSON.parse(localStorage.getItem('pc.folders') || '[]');
  $('#recursive').checked = localStorage.getItem('pc.recursive') !== '0';
} catch { /* storage unavailable */ }
const save = () => { try {
  localStorage.setItem('pc.cfg', JSON.stringify(S.cfg));
  localStorage.setItem('pc.folders', JSON.stringify(S.folders));
  localStorage.setItem('pc.recursive', $('#recursive').checked ? '1' : '0');
} catch { /* ignore */ } };

// ---------- helpers ----------
const fmtSize = (b) => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const fmtTime = (ms) => new Date(ms).toISOString().slice(11, 19);
const thumbSrc = (p) => convertFileSrc(p.thumb);
const POP = new Uint8Array(256).map((_, i) => { let c = 0, v = i; while (v) { c += v & 1; v >>= 1; } return c; });
const hashBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += POP[a[i] ^ b[i]]; return d; };
const blurFromPos = (pos) => Math.round(Math.exp(Math.log(3) + (pos / 100) * (Math.log(1500) - Math.log(3))));
const blurToPos = (v) => ((Math.log(v) - Math.log(3)) / (Math.log(1500) - Math.log(3))) * 100;

function toast(msg, ms = 4500) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms);
}

// ---------- classification ----------
const isOver = (p) => p.mean >= S.cfg.overMean || p.bright >= 0.4;
const isUnder = (p) => p.mean <= S.cfg.underMean || p.dark >= 0.65;
const isLow = (p) => p.width * p.height < S.cfg.lowMp * 1e6;
const isBlur = (p) => p.sharp <= S.cfg.blur && !isOver(p) && !isUnder(p);

function list(tab) {
  const ps = S.photos;
  if (tab === 'over') return ps.filter(isOver).sort((a, b) => b.mean - a.mean);
  if (tab === 'under') return ps.filter(isUnder).sort((a, b) => a.mean - b.mean);
  if (tab === 'blur') return ps.filter(isBlur).sort((a, b) => a.sharp - b.sharp);
  if (tab === 'low') return ps.filter(isLow).sort((a, b) => a.width * a.height - b.width * b.height);
  return groupsOf(tab).flatMap((g) => g.items);
}
const groupsOf = (tab) => (tab === 'dups' ? S.dups : S.series);
const isGroupTab = (tab) => tab === 'series' || tab === 'dups';

// ---------- series ----------
const exposureQuality = (p) => 1 - Math.min(1, Math.abs(p.mean - 120) / 120) * 0.5 - Math.min(1, (p.bright + p.dark) * 1.5) * 0.5;

function buildSeries() {
  const ps = [...S.photos].sort((a, b) => a.takenMs - b.takenMs || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const maxBits = Math.round((256 * S.cfg.simPct) / 100);
  const gapMs = S.cfg.gapSec * 1000;
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length >= 2) groups.push(cur); cur = []; };
  for (const p of ps) {
    p._h ||= hashBytes(p.hash);
    const prev = cur[cur.length - 1];
    if (prev && p.takenMs - prev.takenMs <= gapMs && hamming(prev._h, p._h) <= maxBits) cur.push(p);
    else { flush(); cur = [p]; }
  }
  flush();
  S.series = groups.map((items, i) => {
    const maxSharp = Math.max(...items.map((p) => p.sharp), 1);
    const maxPx = Math.max(...items.map((p) => p.width * p.height), 1);
    const scored = items.map((p) => ({
      p, score: 0.65 * (Math.log1p(p.sharp) / Math.log1p(maxSharp)) + 0.25 * exposureQuality(p) + 0.1 * ((p.width * p.height) / maxPx),
    }));
    const ranked = [...scored].sort((a, b) => b.score - a.score).map((x) => x.p);
    return { id: i, items, ranked };
  });
}

function buildDups() {
  const m = new Map();
  for (const p of S.photos) { const k = p.hash + ':' + p.size; (m.get(k) || m.set(k, []).get(k)).push(p); }
  S.dups = [...m.values()].filter((g) => g.length > 1).map((items, i) => {
    items = items.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return { id: i, items, ranked: items };
  });
}
const rebuild = () => { buildSeries(); buildDups(); };

function markSeries(g, keep) {
  const keepSet = new Set(g.ranked.slice(0, keep).map((p) => p.path));
  for (const p of g.items) keepSet.has(p.path) ? S.marked.delete(p.path) : S.marked.add(p.path);
}

// ---------- rendering ----------
function renderTabs() {
  const defs = [['over', t('tabOver'), list('over').length], ['under', t('tabUnder'), list('under').length],
    ['blur', t('tabBlur'), list('blur').length], ['series', t('tabSeries'), S.series.length],
    ['dups', t('tabDups'), S.dups.length], ['low', t('tabLow'), list('low').length]];
  $('#tabs').innerHTML = S.photos.length
    ? defs.map(([k, label, n]) => `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${label}<span class="n">${n}</span></button>`).join('')
    : '';
}

function sliderHtml(id, label, min, max, value, shown) {
  return `<label class="slider">${label} <input type="range" id="${id}" min="${min}" max="${max}" value="${value}"><output id="${id}Out">${shown}</output></label>`;
}

function renderToolbar() {
  const el = $('#toolbar');
  if (!S.photos.length) { el.innerHTML = ''; return; }
  const c = S.cfg;
  let h = '';
  if (S.tab === 'over') h += sliderHtml('thr', t('thrOver'), 140, 250, c.overMean, c.overMean);
  else if (S.tab === 'under') h += sliderHtml('thr', t('thrUnder'), 5, 120, c.underMean, c.underMean);
  else if (S.tab === 'blur') h += sliderHtml('thr', t('thrBlur'), 0, 100, blurToPos(c.blur), c.blur);
  else if (S.tab === 'low') h += sliderHtml('thr', t('thrLow'), 1, 40, Math.round(c.lowMp * 10), c.lowMp.toFixed(1));
  else if (S.tab === 'dups') h += '';
  else {
    h += sliderHtml('gap', t('gap'), 1, 300, c.gapSec, c.gapSec + 's');
    h += sliderHtml('sim', t('sim'), 3, 45, c.simPct, c.simPct + '%');
  }
  if (isGroupTab(S.tab)) {
    h += `<label class="slider">${t('keepN')} <select id="keepN">${[1, 2, 3, 4].map((n) => `<option ${n === c.keepN ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  }
  h += '<span class="spacer"></span>';
  if (isGroupTab(S.tab)) {
    h += `<button class="primary" data-act="autoMark">${t('autoMark')}</button><button data-act="unmarkAll">${t('unmarkSeries')}</button>`;
  } else {
    h += `<button data-act="selectAll" id="btnSelAll"></button><button data-act="clearView">${t('clearAll')}</button><button data-act="invertView">${t('invert')}</button>`;
  }
  el.innerHTML = h;
  updateToolbarCounts();
}

function updateToolbarCounts() {
  const b = $('#btnSelAll');
  if (b) b.textContent = t('selectAll', S.view.length);
}

function cardHtml(p, extra, badge) {
  return `<div class="card${S.marked.has(p.path) ? ' marked' : ''}" data-path="${esc(p.path)}" title="${esc(p.name)}">
    <img loading="lazy" decoding="async" src="${esc(thumbSrc(p))}" alt="">
    <span class="tick"></span><button class="zoom" data-act="zoom" title="${t('zoom')}">⤢</button>${badge ? `<span class="badge">${badge}</span>` : ''}
    <div class="cap"><b>${esc(p.name)}</b><small>${extra}</small></div></div>`;
}

function categoryExtra(p) {
  if (S.tab === 'low') return `${p.width}×${p.height} · ${fmtSize(p.size)}`;
  if (S.tab === 'blur') return `${t('sharp')} ${p.sharp.toFixed(0)} · ${fmtSize(p.size)}`;
  const pct = Math.round((S.tab === 'over' ? p.bright : p.dark) * 100);
  return `${p.mean.toFixed(0)}/255 · ${pct}% · ${fmtSize(p.size)}`;
}

function renderContent() {
  const el = $('#content');
  const top = el.scrollTop;
  S.view = list(S.tab);
  if (!S.photos.length) {
    el.innerHTML = `<div class="empty"><div class="big">🖼️</div><p>${t('emptyHint')}</p></div>`;
  } else if (isGroupTab(S.tab)) {
    const groups = groupsOf(S.tab), isDup = S.tab === 'dups';
    if (!groups.length) el.innerHTML = `<div class="empty"><p>${t(isDup ? 'noDups' : 'noSeries')}</p></div>`;
    else el.innerHTML = groups.map((g) => {
      const best = new Set(g.ranked.slice(0, S.cfg.keepN).map((p) => p.path));
      const first = g.items[0].takenMs, last = g.items[g.items.length - 1].takenMs;
      const sub = isDup ? `${t('photosN', g.items.length)} · ${fmtSize(g.items[0].size)}` : `${t('photosN', g.items.length)} · ${fmtDate(first).slice(0, 10)} ${fmtTime(first)}–${fmtTime(last)}`;
      return `<div class="series" data-sid="${g.id}">
        <div class="series-head"><h3>${t(isDup ? 'dupTitle' : 'seriesTitle', g.id + 1)}</h3>
          <span class="sub">${sub}</span>
          <button data-act="onlyBest">${t('onlyBest')}</button><button data-act="keepAll">${t('keepAll')}</button></div>
        <div class="row">${g.items.map((p) => cardHtml(p, isDup ? esc(p.path.split(/[\\/]/).slice(-2, -1)[0] || '') : `${fmtTime(p.takenMs)} · ${t('sharp')} ${p.sharp.toFixed(0)}`, best.has(p.path) ? t('best') : '')).join('')}</div></div>`;
    }).join('');
  } else if (!S.view.length) {
    el.innerHTML = `<div class="empty"><p>${t('emptyCat')}</p></div>`;
  } else {
    el.innerHTML = `<div class="grid">${S.view.map((p) => cardHtml(p, categoryExtra(p))).join('')}</div>`;
  }
  el.scrollTop = top;
  updateToolbarCounts();
}

function renderFooter() {
  let size = 0;
  for (const path of S.marked) size += S.byPath.get(path)?.size || 0;
  $('#summary').innerHTML = S.marked.size ? t('marked', S.marked.size, fmtSize(size)) : t('nothing');
  const b = $('#btnDelete');
  b.textContent = t('del', S.marked.size);
  b.disabled = !S.marked.size || S.scanning;
}

function refresh() { renderTabs(); renderToolbar(); renderContent(); renderFooter(); }

function renderFolders() {
  $('#folders').innerHTML = S.folders.map((f, i) => `<div class="chip" title="${esc(f)}"><span>${esc(f)}</span><b data-rm="${i}">✕</b></div>`).join('');
  $('#btnScan').disabled = !S.folders.length || S.scanning;
}

// ---------- marking ----------
function setCardState(path) {
  const m = S.marked.has(path);
  document.querySelectorAll('.card').forEach((c) => { if (c.dataset.path === path) c.classList.toggle('marked', m); });
}
function toggle(path) {
  S.marked.has(path) ? S.marked.delete(path) : S.marked.add(path);
  setCardState(path); renderFooter(); if (S.modalIdx >= 0) renderModal();
}

// ---------- modal ----------
function renderModal() {
  const p = S.byPath.get(S.view[S.modalIdx]?.path);
  if (!p) return;
  const img = $('#modalImg');
  img.onerror = () => { img.onerror = null; img.src = thumbSrc(p); };
  img.src = convertFileSrc(p.path);
  $('#modalInfo').innerHTML = `${esc(p.name)}<small>${fmtDate(p.takenMs)} · ${p.width}×${p.height} · ${fmtSize(p.size)} · ${t('sharp')} ${p.sharp.toFixed(0)} · ${t('bright')} ${p.mean.toFixed(0)}</small><small>${esc(p.path)}</small>`;
  const m = S.marked.has(p.path), b = $('#modalMark');
  b.textContent = m ? t('unmark') : t('mark'); b.classList.toggle('on', m);
}
function openModal(path) {
  S.modalIdx = Math.max(0, S.view.findIndex((p) => p.path === path));
  $('#modal').hidden = false; renderModal();
}
function stepModal(d) {
  if (!S.view.length) return;
  S.modalIdx = (S.modalIdx + d + S.view.length) % S.view.length; renderModal();
}
function closeModal() { $('#modal').hidden = true; S.modalIdx = -1; $('#modalImg').removeAttribute('src'); }

// ---------- scanning ----------
async function pickFolders() {
  try {
    const r = await TAURI.dialog.open({ directory: true, multiple: true });
    if (!r) return;
    for (const f of [].concat(r)) if (!S.folders.includes(f)) S.folders.push(f);
    save(); renderFolders(); scan();
  } catch (e) { toast(t('pickFailed') + ': ' + e); }
}

async function scan() {
  if (S.scanning || !S.folders.length) return;
  S.scanning = true; S.marked.clear();
  $('#btnCancel').hidden = false; $('#btnPick').disabled = true; renderFolders(); renderFooter();
  const prog = $('#progress'); prog.hidden = false;
  const bar = prog.querySelector('i'), label = prog.querySelector('span');
  bar.style.width = '0'; label.textContent = t('scanFound');
  S.photos = []; S.byPath = new Map(); S.series = []; S.dups = [];
  let timer = null;
  const live = () => { // throttled re-render while photos stream in
    if (timer) return;
    timer = setTimeout(() => { timer = null; rebuild(); renderTabs(); renderContent(); renderFooter(); }, 900);
  };
  const ch = new Channel();
  ch.onmessage = (m) => {
    if (m.event === 'progress') { bar.style.width = (m.data.done / Math.max(1, m.data.total)) * 100 + '%'; label.textContent = t('scanning', m.data.done, m.data.total); }
    else if (m.event === 'photos') {
      for (const p of m.data.items) { S.photos.push(p); S.byPath.set(p.path, p); }
      live();
    }
  };
  refresh();
  try {
    const r = await invoke('scan', { folders: S.folders, recursive: $('#recursive').checked, onEvent: ch });
    clearTimeout(timer); timer = null;
    rebuild();
    if (!list(S.tab).length) S.tab = ['over', 'under', 'blur', 'series', 'dups', 'low'].find((k) => list(k).length) || 'over';
    toast(t('scanDone', S.photos.length, r.failed.length ? t('failedN', r.failed.length) : ''));
  } catch (e) { toast(String(e), 8000); }
  S.scanning = false; prog.hidden = true; $('#btnCancel').hidden = true; $('#btnPick').disabled = false;
  renderFolders(); refresh();
}

// ---------- deleting ----------
async function askConfirm(msg) {
  try { return await TAURI.dialog.ask(msg, { title: 'PhotoCleaner', kind: 'warning' }); } catch { return window.confirm(msg); }
}
async function doDelete() {
  const paths = [...S.marked];
  if (!paths.length) return;
  const permanent = $('#permanent').checked;
  let size = 0; for (const p of paths) size += S.byPath.get(p)?.size || 0;
  if (!(await askConfirm(t(permanent ? 'confirmPerm' : 'confirmTrash', paths.length, fmtSize(size))))) return;
  $('#btnDelete').disabled = true;
  try {
    const r = await invoke('delete_files', { paths, permanent });
    const gone = new Set(r.deleted);
    let freed = 0; for (const p of gone) freed += S.byPath.get(p)?.size || 0;
    S.photos = S.photos.filter((p) => !gone.has(p.path));
    S.byPath = new Map(S.photos.map((p) => [p.path, p]));
    for (const p of gone) S.marked.delete(p);
    rebuild(); refresh();
    toast(t('deletedN', gone.size, fmtSize(freed)) + (r.errors.length ? t('errorsN', r.errors.length) : ''), 6000);
    if (r.errors.length) console.warn(r.errors);
  } catch (e) { toast(String(e), 8000); renderFooter(); }
}

// ---------- events ----------
$('#btnPick').onclick = pickFolders;
$('#btnScan').onclick = scan;
$('#btnCancel').onclick = () => invoke('cancel_scan');
$('#btnDelete').onclick = doDelete;
$('#recursive').onchange = save;

$('#folders').addEventListener('click', (e) => {
  const i = e.target.dataset.rm; if (i === undefined) return;
  S.folders.splice(+i, 1); save(); renderFolders();
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  S.tab = b.dataset.tab; refresh();
});

$('#toolbar').addEventListener('input', (e) => {
  const c = S.cfg, v = +e.target.value, out = $('#' + e.target.id + 'Out');
  switch (e.target.id) {
    case 'thr':
      if (S.tab === 'over') c.overMean = v; else if (S.tab === 'under') c.underMean = v; else if (S.tab === 'low') c.lowMp = v / 10; else c.blur = blurFromPos(v);
      out.textContent = S.tab === 'blur' ? c.blur : S.tab === 'low' ? c.lowMp.toFixed(1) : v; renderTabs(); renderContent(); break;
    case 'gap': c.gapSec = v; out.textContent = v + 's'; buildSeries(); renderTabs(); renderContent(); break;
    case 'sim': c.simPct = v; out.textContent = v + '%'; buildSeries(); renderTabs(); renderContent(); break;
    case 'keepN': c.keepN = v; renderContent(); break;
  }
  save();
});

$('#toolbar').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  if (act === 'selectAll') S.view.forEach((p) => S.marked.add(p.path));
  else if (act === 'clearView') S.view.forEach((p) => S.marked.delete(p.path));
  else if (act === 'invertView') S.view.forEach((p) => (S.marked.has(p.path) ? S.marked.delete(p.path) : S.marked.add(p.path)));
  else if (act === 'autoMark') groupsOf(S.tab).forEach((g) => markSeries(g, S.cfg.keepN));
  else if (act === 'unmarkAll') groupsOf(S.tab).forEach((g) => g.items.forEach((p) => S.marked.delete(p.path)));
  renderContent(); renderFooter();
});

$('#content').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (card && act === 'zoom') return openModal(card.dataset.path);
  if (card) return toggle(card.dataset.path);
  const sid = e.target.closest('.series')?.dataset.sid;
  if (sid !== undefined && act) {
    const g = groupsOf(S.tab)[+sid];
    if (act === 'onlyBest') markSeries(g, S.cfg.keepN); else if (act === 'keepAll') g.items.forEach((p) => S.marked.delete(p.path));
    renderContent(); renderFooter();
  }
});
$('#content').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.card'); if (card) openModal(card.dataset.path);
});

$('#modal').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') closeModal(); else if (act === 'prev') stepModal(-1); else if (act === 'next') stepModal(1);
});
$('#modalMark').onclick = () => toggle(S.view[S.modalIdx].path);
document.addEventListener('keydown', (e) => {
  if (S.modalIdx < 0) return;
  if (e.key === 'Escape') closeModal();
  else if (e.key === 'ArrowLeft') stepModal(-1);
  else if (e.key === 'ArrowRight') stepModal(1);
  else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(S.view[S.modalIdx].path); }
});

const applyCard = () => document.documentElement.style.setProperty('--card', S.cfg.card + 'px');
$('#cardSize').value = S.cfg.card; applyCard();
$('#cardSize').addEventListener('input', (e) => { S.cfg.card = +e.target.value; applyCard(); save(); });
renderFolders(); refresh();
