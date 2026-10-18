// Gestione Ordini v6 — app web che funziona tutta sul telefono.
import * as db from './db.js';
import { buildOrderPdf, orderPdfFilename, loadPdfLib } from './pdf.js';
import {
  APP_VERSION, STATUS, eur, qtyStr, esc, parseNum, numInput, round2, round3,
  isoDate, addDays, stamp, stampToMs, fmtDay, fmtDateLong, fmtDateTime, productKey, phoneKey,
} from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const view = $('#view');

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* =========================================================
   Componenti di interfaccia
   ========================================================= */

let toastTimer = 0;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, kind === 'err' ? 4000 : 2400);
}

function openSheet(html) {
  const dlg = $('#sheet');
  dlg.innerHTML = `<div class="sheet-body">${html}</div>`;
  if (typeof dlg.showModal === 'function') {
    if (!dlg.open) dlg.showModal();
  } else {
    dlg.setAttribute('open', '');
  }
  return dlg;
}

function closeSheet() {
  const dlg = $('#sheet');
  if (dlg.open) {
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }
  dlg.innerHTML = '';
}

function page(title, body, { left = '', right = '' } = {}) {
  return `<header class="topbar"><div class="tb-inner">${left}<h1>${esc(title)}</h1>${right}</div></header>
    <div class="content">${body}</div>`;
}

function statusSeg(current, id = '') {
  return `<div class="seg status" ${id ? `id="${id}"` : ''} role="radiogroup" aria-label="Stato ordine">${
    Object.entries(STATUS).map(([k, label]) => `<button type="button" role="radio" data-v="${k}"
      class="${k === current ? 'on' : ''}" aria-checked="${k === current}">${label}</button>`).join('')
  }</div>`;
}

function setSeg(seg, value) {
  $$('button', seg).forEach((b) => {
    const on = b.dataset.v === value;
    b.classList.toggle('on', on);
    if (b.hasAttribute('role')) b.setAttribute('aria-checked', String(on));
  });
}

// Suggerimenti sotto un campo (clienti, articoli)
function renderSuggest(box, entries) {
  box._entries = entries;
  if (!entries.length) {
    box.classList.remove('show');
    box.innerHTML = '';
    return;
  }
  box.innerHTML = entries.map((e, i) => `<button type="button" data-i="${i}">${e.html}</button>`).join('');
  box.classList.add('show');
}
const hideSuggest = (box) => box && box.classList.remove('show');

/* =========================================================
   Condivisione file (PDF, backup)
   ========================================================= */

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return 'downloaded';
}

// Restituisce 'shared' | 'downloaded' | 'cancelled'
async function shareFile(bytes, filename, mime) {
  const file = new File([bytes], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
      // il permesso del tocco è scaduto mentre preparavamo il file: si chiede un secondo tocco
      if (err.name === 'NotAllowedError') return shareSheet(file);
      console.warn('Condivisione non riuscita, scarico il file', err);
    }
  }
  return downloadFile(file);
}

function shareSheet(file) {
  return new Promise((resolve) => {
    const dlg = openSheet(`
      <h2>File pronto</h2>
      <p class="muted">${esc(file.name)}</p>
      <div class="btns">
        <button class="btn primary" type="button" data-a="share">Condividi…</button>
        <button class="btn" type="button" data-a="open">Apri / salva</button>
        <button class="btn ghost" type="button" data-a="close">Chiudi</button>
      </div>`);
    dlg.onclick = async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      dlg.onclick = null;
      if (a === 'share') {
        try {
          await navigator.share({ files: [file] });
          resolve('shared');
        } catch (err) {
          resolve(err.name === 'AbortError' ? 'cancelled' : downloadFile(file));
        }
      } else if (a === 'open') {
        resolve(downloadFile(file));
      } else {
        resolve('cancelled');
      }
      closeSheet();
    };
  });
}

/* =========================================================
   Router
   ========================================================= */

let navToken = 0;
const teardown = [];
const onLeave = (fn) => teardown.push(fn);

const ROUTES = [
  [/^#\/nuovo$/, (m, alive) => viewForm(null, alive), 'nuovo'],
  [/^#\/modifica\/(\d+)$/, (m, alive) => viewForm(Number(m[1]), alive), 'ordini'],
  [/^#\/ordini$/, (m, alive) => viewOrders(alive), 'ordini'],
  [/^#\/ordine\/(\d+)$/, (m, alive) => viewDetail(Number(m[1]), alive), 'ordini'],
  [/^#\/catalogo$/, (m, alive) => viewCatalog(alive), 'catalogo'],
  [/^#\/altro$/, (m, alive) => viewSettings(alive), 'altro'],
];

async function route() {
  const hash = location.hash || '#/nuovo';
  teardown.splice(0).forEach((fn) => {
    try { fn(); } catch (err) { console.error(err); }
  });
  closeSheet();
  const token = ++navToken;
  const alive = () => token === navToken;
  for (const [re, fn, tab] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
    try {
      await fn(m, alive);
      if (alive()) window.scrollTo(0, 0);
    } catch (err) {
      console.error(err);
      if (alive()) view.innerHTML = page('Errore', `<div class="card">${esc(err.message || err)}</div>`);
    }
    return;
  }
  location.replace('#/nuovo');
}

function notFound(id) {
  view.innerHTML = page('Ordine non trovato', `<div class="empty">L'ordine #${id} non esiste.<br><br>
    <a class="btn" href="#/ordini">Torna agli ordini</a></div>`);
}

/* =========================================================
   Nuovo / modifica ordine
   ========================================================= */

const emptyItem = () => ({ product: '', qty: '1', price: '' });
const emptyForm = () => ({
  phone: '', name: '', address: '', delivery_date: '', note: '', status: 'ATTIVO', items: [],
});
const formHasContent = (f) => !!(f && (f.phone || f.name || f.address || f.note || f.delivery_date
  || (f.items || []).some((it) => it.product)));

function orderToForm(o) {
  return {
    phone: o.phone,
    name: o.name,
    address: o.address || '',
    delivery_date: o.delivery_date || '',
    note: o.note || '',
    status: o.status || 'ATTIVO',
    items: o.items.map((it) => ({ product: it.product, qty: numInput(it.qty), price: numInput(it.price, 2) })),
  };
}

function itemHtml(it) {
  return `<div class="item">
    <div class="item-top">
      <input class="prod" placeholder="Articolo: scrivi o scegli" autocomplete="off" autocorrect="off"
        autocapitalize="sentences" enterkeyhint="next" value="${esc(it.product)}" aria-label="Articolo">
      <button type="button" class="icon-btn del" aria-label="Rimuovi articolo">×</button>
    </div>
    <div class="suggest"></div>
    <div class="item-nums">
      <label><span>Quantità</span><input class="qty" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${esc(it.qty)}"></label>
      <label><span>Prezzo €</span><input class="price" inputmode="decimal" autocomplete="off" enterkeyhint="next" value="${esc(it.price)}" placeholder="0,00"></label>
      <div class="sub" aria-label="Subtotale">${eur(0)}</div>
    </div>
  </div>`;
}

async function viewForm(id, alive) {
  const [catalog, customers, draft, order] = await Promise.all([
    db.listCatalog(), db.listCustomers(), db.getMeta('draft'), id ? db.getOrder(id) : Promise.resolve(null),
  ]);
  if (!alive()) return;
  if (id && !order) return notFound(id);

  const mode = id ? 'edit' : 'new';
  let data = id ? orderToForm(order) : emptyForm();
  let restored = false;
  if (draft && draft.mode === mode && (mode === 'new' || draft.id === id) && formHasContent(draft.form)
      && (mode === 'new' || draft.ts > stampToMs(order.updated_at))) {
    data = { ...emptyForm(), ...draft.form };
    restored = true;
  }
  let currentStatus = data.status || 'ATTIVO';
  const catByKey = new Map(catalog.map((p) => [p.key, p]));

  const right = id
    ? '<button class="tb-btn" type="button" data-act="cancel">Annulla</button>'
    : '<button class="tb-btn" type="button" data-act="clear">Svuota</button>';

  view.innerHTML = page(id ? `Modifica ordine #${id}` : 'Nuovo ordine', `
    ${restored ? `<div class="notice info">${mode === 'new'
    ? 'Bozza ripristinata: continua da dove eri rimasto.'
    : 'Modifiche non salvate ripristinate.'}</div>` : ''}
    <form id="orderForm" novalidate autocomplete="off">
      <section class="card">
        <label class="field"><span>Telefono</span>
          <input name="phone" type="tel" inputmode="tel" autocomplete="off" enterkeyhint="next"
            value="${esc(data.phone)}" placeholder="Numero del cliente"></label>
        <div class="suggest" data-for="phone"></div>
        <label class="field"><span>Nome</span>
          <input name="name" autocapitalize="words" autocomplete="off" autocorrect="off" enterkeyhint="next"
            value="${esc(data.name)}" placeholder="Nome e cognome"></label>
        <div class="suggest" data-for="name"></div>
        <label class="field"><span>Indirizzo <em>facoltativo</em></span>
          <input name="address" autocomplete="off" enterkeyhint="next" value="${esc(data.address)}"></label>
        <div class="field"><span>Data richiesta</span>
          <input name="delivery_date" type="date" value="${esc(data.delivery_date)}">
          <div class="chips" data-date-chips>
            <button type="button" class="chip" data-d="${isoDate()}">Oggi</button>
            <button type="button" class="chip" data-d="${addDays(1)}">Domani</button>
            <button type="button" class="chip" data-d="${addDays(2)}">Dopodomani</button>
            <button type="button" class="chip" data-d="">Nessuna</button>
          </div>
        </div>
        <label class="field"><span>Note <em>facoltative</em></span>
          <textarea name="note" rows="2">${esc(data.note)}</textarea></label>
        ${id ? `<div class="field"><span>Stato</span>${statusSeg(currentStatus)}</div>` : ''}
      </section>
      <h2 class="section-title">Articoli</h2>
      <div id="items"></div>
      <div class="savebar">
        <div class="tot"><small>Totale</small><strong id="total">${eur(0)}</strong></div>
        <button class="btn primary" type="submit">${id ? 'Salva modifiche' : 'Salva ordine'}</button>
      </div>
    </form>`, { right });

  const form = $('#orderForm');
  const itemsEl = $('#items');
  const phoneBox = $('.suggest[data-for=phone]', form);
  const nameBox = $('.suggest[data-for=name]', form);
  const el = (n) => form.elements[n];

  const addItem = (it = emptyItem()) => itemsEl.insertAdjacentHTML('beforeend', itemHtml(it));

  function ensureTrailing() {
    let rows = $$('.item', itemsEl);
    const last = rows[rows.length - 1];
    if (!last || $('.prod', last).value.trim()) addItem();
    rows = $$('.item', itemsEl);
    rows.forEach((r, i) => r.classList.toggle('empty', i === rows.length - 1 && !$('.prod', r).value.trim()));
  }

  function recalc() {
    let total = 0;
    $$('.item', itemsEl).forEach((r) => {
      const q = parseNum($('.qty', r).value);
      const p = parseNum($('.price', r).value) ?? 0;
      const ok = $('.prod', r).value.trim() && q > 0 && p >= 0;
      const sub = ok ? round2(q * round2(p)) : 0;
      $('.sub', r).textContent = eur(sub);
      total += sub;
    });
    $('#total').textContent = eur(round2(total));
  }

  function updateDateChips() {
    const v = el('delivery_date').value;
    $$('[data-date-chips] .chip', form).forEach((c) => c.classList.toggle('on', c.dataset.d === v));
  }

  function collect() {
    return {
      phone: el('phone').value.trim(),
      name: el('name').value.trim(),
      address: el('address').value.trim(),
      delivery_date: el('delivery_date').value,
      note: el('note').value.trim(),
      status: currentStatus,
      items: $$('.item', itemsEl)
        .map((r) => ({ product: $('.prod', r).value.trim(), qty: $('.qty', r).value.trim(), price: $('.price', r).value.trim() }))
        .filter((it) => it.product),
    };
  }

  data.items.forEach((it) => addItem(it));
  ensureTrailing();
  recalc();
  updateDateChips();

  /* --- bozza: salvata mentre si scrive, così una telefonata o la chiusura dell'app non fanno perdere niente --- */
  let dirty = false;
  let draftTimer = 0;
  const saveDraft = async () => {
    clearTimeout(draftTimer);
    if (!dirty) return;
    dirty = false;
    const f = collect();
    try {
      if (formHasContent(f)) await db.setMeta('draft', { mode, id, form: f, ts: Date.now() });
      else await db.deleteMeta('draft');
    } catch (err) {
      console.warn('Bozza non salvata', err);
    }
  };
  const markDirty = () => {
    dirty = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  };
  const onVisibility = () => { if (document.visibilityState === 'hidden') saveDraft(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', saveDraft);
  onLeave(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', saveDraft);
    saveDraft();
  });

  /* --- suggerimenti clienti --- */
  function fillCustomer(c) {
    el('phone').value = c.phone;
    el('name').value = c.name;
    el('address').value = c.address || '';
    markDirty();
  }
  const customerEntry = (c) => ({
    html: `<span><b>${esc(c.name)}</b><small>${esc(c.phone)}${c.address ? ` · ${esc(c.address)}` : ''}</small></span>`,
    pick: () => { fillCustomer(c); el('delivery_date').focus({ preventScroll: true }); },
  });
  function suggestCustomers(source) {
    const pk = phoneKey(el('phone').value);
    const nv = el('name').value.trim().toLowerCase();
    let list = [];
    if (source === 'phone' && pk.length >= 3) list = customers.filter((c) => c.key.includes(pk));
    if (source === 'name' && nv.length >= 2) list = customers.filter((c) => c.name.toLowerCase().includes(nv));
    list = list.filter((c) => !(c.key === pk && c.name === el('name').value.trim())).slice(0, 6);
    renderSuggest(source === 'phone' ? phoneBox : nameBox, list.map(customerEntry));
  }
  function autoCustomer() {
    const pk = phoneKey(el('phone').value);
    if (!pk || el('name').value.trim()) return;
    const c = customers.find((x) => x.key === pk);
    if (c) {
      fillCustomer(c);
      toast(`Cliente trovato: ${c.name}`);
    }
  }

  /* --- suggerimenti articoli --- */
  function autoPrice(row, force) {
    const p = catByKey.get(productKey($('.prod', row).value));
    const price = $('.price', row);
    if (p && (force || !price.value.trim())) price.value = numInput(p.price, 2);
  }
  function suggestProducts(row) {
    const box = $('.suggest', row);
    const q = productKey($('.prod', row).value);
    let list;
    if (!q) {
      list = catalog.slice(0, 8);
    } else {
      const starts = [];
      const contains = [];
      catalog.forEach((p) => {
        if (p.key === q) return;
        if (p.key.startsWith(q)) starts.push(p);
        else if (p.key.includes(q)) contains.push(p);
      });
      list = starts.concat(contains).slice(0, 8);
    }
    renderSuggest(box, list.map((p) => ({
      html: `<span>${esc(p.name)}</span><small>${eur(p.price)}</small>`,
      pick: () => {
        $('.prod', row).value = p.name;
        autoPrice(row, true);
        ensureTrailing();
        recalc();
        markDirty();
        const qty = $('.qty', row);
        qty.focus({ preventScroll: true });
        qty.select();
      },
    })));
  }

  /* --- eventi --- */
  form.addEventListener('input', (e) => {
    const t = e.target;
    t.classList.remove('bad');
    markDirty();
    if (t.classList.contains('prod')) {
      const row = t.closest('.item');
      autoPrice(row, false);
      suggestProducts(row);
      ensureTrailing();
    } else if (t.name === 'phone') {
      suggestCustomers('phone');
    } else if (t.name === 'name') {
      suggestCustomers('name');
    } else if (t.name === 'delivery_date') {
      updateDateChips();
    }
    recalc();
  });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'delivery_date') {
      updateDateChips();
      markDirty();
    }
  });
  form.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('prod')) suggestProducts(e.target.closest('.item'));
  });
  form.addEventListener('focusout', (e) => {
    const t = e.target;
    let box = null;
    if (t.classList.contains('prod')) {
      box = $('.suggest', t.closest('.item'));
      // "vongole veraci" scritto a mano diventa "Vongole veraci" come nel catalogo
      const p = catByKey.get(productKey(t.value));
      if (p && t.value !== p.name) {
        t.value = p.name;
        markDirty();
      }
    } else if (t.name === 'phone') box = phoneBox;
    else if (t.name === 'name') box = nameBox;
    if (box) setTimeout(() => hideSuggest(box), 250);
    if (t.name === 'phone') autoCustomer();
    if (t.classList.contains('qty') || t.classList.contains('price')) {
      const n = parseNum(t.value);
      t.classList.toggle('bad', Number.isNaN(n) || (n != null && n < 0));
    }
  });
  // Invio sulla tastiera = campo successivo (non salva l'ordine per sbaglio)
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    const fields = $$('input, textarea', form).filter((f) => f.offsetParent !== null && f.type !== 'date');
    const next = fields[fields.indexOf(e.target) + 1];
    if (next) next.focus();
    else e.target.blur();
  });
  form.addEventListener('click', (e) => {
    const del = e.target.closest('.del');
    if (del) {
      del.closest('.item').remove();
      ensureTrailing();
      recalc();
      markDirty();
      return;
    }
    const chip = e.target.closest('[data-date-chips] .chip');
    if (chip) {
      el('delivery_date').value = chip.dataset.d;
      updateDateChips();
      markDirty();
      return;
    }
    const sb = e.target.closest('.seg.status button');
    if (sb) {
      currentStatus = sb.dataset.v;
      setSeg(sb.parentElement, currentStatus);
      markDirty();
    }
  });

  $('[data-act=clear]', view)?.addEventListener('click', async () => {
    if (formHasContent(collect()) && !confirm('Svuotare il modulo? I dati non salvati andranno persi.')) return;
    dirty = false;
    await db.deleteMeta('draft');
    route();
  });
  $('[data-act=cancel]', view)?.addEventListener('click', async () => {
    dirty = false;
    await db.deleteMeta('draft');
    location.hash = `#/ordine/${id}`;
  });

  let saving = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving) return;
    const fail = (msg, input) => {
      toast(msg, 'err');
      if (input) {
        input.classList.add('bad');
        input.focus();
      }
    };
    const f = collect();
    if (!f.phone) return fail('Inserisci il telefono del cliente', el('phone'));
    if (!f.name) return fail('Inserisci il nome del cliente', el('name'));
    const rows = $$('.item', itemsEl).filter((r) => $('.prod', r).value.trim());
    if (!rows.length) return fail('Aggiungi almeno un articolo', $('.prod', $$('.item', itemsEl).pop()));
    const items = [];
    for (const r of rows) {
      const product = $('.prod', r).value.trim();
      const qty = parseNum($('.qty', r).value);
      const price = parseNum($('.price', r).value) ?? 0;
      if (!(qty > 0)) return fail(`Quantità non valida per "${product}"`, $('.qty', r));
      if (Number.isNaN(price) || price < 0) return fail(`Prezzo non valido per "${product}"`, $('.price', r));
      items.push({ product, qty: round3(qty), price: round2(price) });
    }
    saving = true;
    const btn = $('[type=submit]', form);
    btn.disabled = true;
    try {
      const saved = await db.saveOrder({
        id, phone: f.phone, name: f.name, address: f.address, delivery_date: f.delivery_date,
        note: f.note, status: currentStatus, items,
      });
      dirty = false;
      clearTimeout(draftTimer);
      await db.deleteMeta('draft');
      toast(`Ordine #${saved.id} salvato`);
      location.hash = `#/ordine/${saved.id}`;
    } catch (err) {
      console.error(err);
      toast(`Errore nel salvataggio: ${err.message}`, 'err');
      btn.disabled = false;
      saving = false;
    }
  });
}

/* =========================================================
   Lista ordini
   ========================================================= */

const listState = { q: '', status: 'ATTIVO', date: '', limit: 100, summaryOpen: false };

function orderCard(o) {
  const n = o.items.length;
  const today = isoDate();
  let when = '<span class="oc-when">senza data</span>';
  if (o.delivery_date) {
    const cls = o.delivery_date === today ? 'today' : (o.delivery_date < today && o.status === 'ATTIVO' ? 'late' : '');
    when = `<span class="oc-when ${cls}">per ${esc(fmtDay(o.delivery_date))}</span>`;
  }
  return `<a class="order-card st-row-${o.status}" href="#/ordine/${o.id}">
    <div class="oc-top"><span class="oc-id">#${o.id}</span><span class="oc-name">${esc(o.name)}</span>
      <span class="pill st-${o.status}">${STATUS[o.status] || esc(o.status)}</span></div>
    <div class="oc-mid">${when} · ${n} ${n === 1 ? 'articolo' : 'articoli'}${o.note ? ` · <span class="oc-note">${esc(o.note)}</span>` : ''}</div>
    <div class="oc-bottom"><span class="muted">${esc(o.phone)}</span><strong>${eur(o.total)}</strong></div>
  </a>`;
}

async function viewOrders(alive) {
  const [orders, lastBackup] = await Promise.all([db.listOrders(), db.getMeta('lastBackup')]);
  if (!alive()) return;
  const days = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400000) : null;
  const needBackup = orders.length > 0 && (days === null || days >= 7);

  view.innerHTML = page('Ordini', `
    ${needBackup ? `<div class="notice"><span>${days === null ? 'Non hai ancora fatto un backup dei dati.'
    : `Ultimo backup ${days} giorni fa.`}</span><a class="btn small" href="#/altro">Fai backup</a></div>` : ''}
    <input class="search" id="q" type="search" placeholder="Cerca numero, nome o telefono"
      value="${esc(listState.q)}" enterkeyhint="search" autocomplete="off">
    <div class="seg" id="stFilter">${[['ATTIVO', 'Attivi'], ['CHIUSO', 'Chiusi'], ['ANNULLATO', 'Annullati'], ['', 'Tutti']]
    .map(([v, l]) => `<button type="button" data-v="${v}" class="${listState.status === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="chips" id="dateChips"></div>
    <div id="summary"></div>
    <div id="list"></div>`, { right: '<a class="tb-btn" href="#/nuovo">+ Nuovo</a>' });

  function filtered() {
    const q = listState.q.trim().toLowerCase().replace(/^#/, '');
    const qd = phoneKey(q);
    const base = orders.filter((o) => !listState.status || o.status === listState.status)
      .filter((o) => !q || String(o.id) === q || o.name.toLowerCase().includes(q)
        || (qd.length >= 3 && phoneKey(o.phone).includes(qd)));
    return { base, list: base.filter((o) => !listState.date || o.delivery_date === listState.date) };
  }

  function renderChips(base) {
    const today = isoDate();
    const tomorrow = addDays(1);
    const counts = new Map();
    base.forEach((o) => { if (o.delivery_date) counts.set(o.delivery_date, (counts.get(o.delivery_date) || 0) + 1); });
    const upcoming = [...counts.keys()].filter((d) => d > tomorrow).sort().slice(0, 4);
    const n = (d) => (counts.get(d) ? ` <b>${counts.get(d)}</b>` : '');
    const chip = (d, label) => `<button type="button" class="chip ${listState.date === d ? 'on' : ''}" data-d="${d}">${label}</button>`;
    const custom = listState.date && ![today, tomorrow, ...upcoming].includes(listState.date);
    $('#dateChips').innerHTML = chip('', 'Tutte le date') + chip(today, `Oggi${n(today)}`) + chip(tomorrow, `Domani${n(tomorrow)}`)
      + upcoming.map((d) => chip(d, esc(fmtDay(d)) + n(d))).join('')
      + `<label class="chip datechip ${custom ? 'on' : ''}">${custom ? esc(fmtDay(listState.date)) : 'Altra data…'}
          <input type="date" aria-label="Scegli data" value="${custom ? listState.date : ''}"></label>`;
  }

  function renderSummary(list) {
    const active = list.filter((o) => o.status !== 'ANNULLATO');
    if (!active.length) {
      $('#summary').innerHTML = '';
      return;
    }
    const agg = new Map();
    active.forEach((o) => o.items.forEach((it) => {
      const k = productKey(it.product);
      const a = agg.get(k) || { name: it.product, qty: 0 };
      a.qty += Number(it.qty) || 0;
      agg.set(k, a);
    }));
    const rows = [...agg.values()].sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
    const total = active.reduce((s, o) => s + (Number(o.total) || 0), 0);
    $('#summary').innerHTML = `<details class="card summary" ${listState.summaryOpen ? 'open' : ''}>
      <summary><span>Riepilogo articoli</span><span class="muted">${active.length} ${active.length === 1 ? 'ordine' : 'ordini'} · ${eur(total)}</span></summary>
      <table class="sumtable">${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="n">${qtyStr(round3(r.qty))}</td></tr>`).join('')}</table>
    </details>`;
    $('#summary details').addEventListener('toggle', (e) => { listState.summaryOpen = e.target.open; });
  }

  function renderList(list) {
    if (!list.length) {
      $('#list').innerHTML = `<div class="empty">${orders.length ? 'Nessun ordine con questi filtri.'
        : 'Ancora nessun ordine.<br><br><a class="btn primary" href="#/nuovo">Inserisci il primo ordine</a>'}</div>`;
      return;
    }
    const shown = list.slice(0, listState.limit);
    $('#list').innerHTML = shown.map(orderCard).join('')
      + (list.length > shown.length ? `<button class="btn block" type="button" id="more">Mostra altri (${list.length - shown.length})</button>` : '');
  }

  function apply() {
    const { base, list } = filtered();
    renderChips(base);
    renderSummary(list);
    renderList(list);
  }
  apply();

  $('#q').addEventListener('input', (e) => {
    listState.q = e.target.value;
    apply();
  });
  $('#stFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    listState.status = b.dataset.v;
    setSeg($('#stFilter'), listState.status);
    apply();
  });
  $('#dateChips').addEventListener('click', (e) => {
    const b = e.target.closest('button.chip');
    if (!b) return;
    listState.date = b.dataset.d;
    apply();
  });
  $('#dateChips').addEventListener('change', (e) => {
    if (e.target.type !== 'date') return;
    listState.date = e.target.value || '';
    apply();
  });
  $('#list').addEventListener('click', (e) => {
    if (e.target.id !== 'more') return;
    listState.limit += 100;
    apply();
  });
}

/* =========================================================
   Dettaglio ordine
   ========================================================= */

async function viewDetail(id, alive) {
  const o = await db.getOrder(id);
  if (!alive()) return;
  if (!o) return notFound(id);

  view.innerHTML = page(`Ordine #${o.id}`, `
    <section class="card">
      ${statusSeg(o.status, 'stSeg')}
      <dl class="kv">
        <dt>Cliente</dt><dd><b>${esc(o.name)}</b></dd>
        <dt>Telefono</dt><dd><a href="tel:${esc(phoneKey(o.phone))}">${esc(o.phone)}</a></dd>
        ${o.address ? `<dt>Indirizzo</dt><dd>${esc(o.address)}</dd>` : ''}
        <dt>Data richiesta</dt><dd>${o.delivery_date ? esc(fmtDateLong(o.delivery_date)) : '-'}</dd>
        ${o.note ? `<dt>Note</dt><dd class="pre">${esc(o.note)}</dd>` : ''}
        <dt>Inserito</dt><dd>${esc(fmtDateTime(o.created_at))}${o.revision
    ? `<small class="muted">modificato il ${esc(fmtDateTime(o.updated_at))}</small>` : ''}</dd>
      </dl>
    </section>
    <section class="card">
      <ul class="lines">${o.items.map((it) => `<li>
        <div><div class="p">${esc(it.product)}</div><div class="q">${qtyStr(it.qty)} × ${eur(it.price)}</div></div>
        <div class="s">${eur(it.subtotal)}</div></li>`).join('')}</ul>
      <div class="total-row"><span>Totale</span><span>${eur(o.total)}</span></div>
    </section>
    <div class="actions">
      <a class="btn" href="#/modifica/${o.id}">Modifica</a>
      <button class="btn primary" type="button" id="pdfBtn">Condividi PDF</button>
    </div>
    <button class="btn danger block" type="button" id="delBtn">Elimina ordine</button>`,
  { left: '<a class="tb-btn back" href="#/ordini" aria-label="Torna agli ordini">‹ Ordini</a>' });

  $('#stSeg').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.dataset.v === o.status) return;
    try {
      const upd = await db.setStatus(o.id, b.dataset.v);
      o.status = upd.status;
      setSeg($('#stSeg'), o.status);
      toast(`Ordine #${o.id}: ${STATUS[o.status]}`);
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#pdfBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const header = (await db.getMeta('pdfHeader')) || '';
      const bytes = await buildOrderPdf(o, header);
      await shareFile(bytes, orderPdfFilename(o), 'application/pdf');
    } catch (err) {
      console.error(err);
      toast(`Errore PDF: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#delBtn').addEventListener('click', async () => {
    if (!confirm(`Eliminare definitivamente l'ordine #${o.id} di ${o.name}?`)) return;
    await db.deleteOrder(o.id);
    toast(`Ordine #${o.id} eliminato`);
    location.hash = '#/ordini';
  });
}

/* =========================================================
   Catalogo
   ========================================================= */

async function viewCatalog(alive) {
  let items = await db.listCatalog();
  if (!alive()) return;
  let filter = '';

  view.innerHTML = page('Catalogo', `
    <form class="card add-row" id="addForm" autocomplete="off" novalidate>
      <input name="name" placeholder="Nuovo articolo" autocapitalize="sentences" autocorrect="off" enterkeyhint="next" aria-label="Nome articolo">
      <input name="price" inputmode="decimal" placeholder="Prezzo €" enterkeyhint="done" aria-label="Prezzo">
      <button class="btn primary" type="submit">Aggiungi</button>
    </form>
    <input class="search" id="catQ" type="search" placeholder="Cerca nel catalogo" autocomplete="off">
    <ul class="plist" id="plist"></ul>
    <p class="hint">Gli articoli scritti a mano in un ordine finiscono qui da soli. Tocca un articolo per cambiare nome o prezzo, o per eliminarlo.</p>`);

  function render() {
    if (!alive()) return; // l'utente ha già cambiato sezione
    const q = productKey(filter);
    const list = q ? items.filter((p) => p.key.includes(q)) : items;
    $('#plist').innerHTML = list.length
      ? list.map((p) => `<li><button type="button" data-k="${esc(p.key)}"><span>${esc(p.name)}</span><b>${eur(p.price)}</b></button></li>`).join('')
      : `<li class="empty">${items.length ? 'Nessun articolo trovato.' : 'Catalogo vuoto.'}</li>`;
  }
  const reload = async () => {
    items = await db.listCatalog();
    render();
  };
  render();

  const addForm = $('#addForm');
  addForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.name === 'name') {
      e.preventDefault();
      addForm.elements.price.focus();
    }
  });
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = addForm.elements.name.value.trim();
    const price = parseNum(addForm.elements.price.value);
    if (!name) return toast('Scrivi il nome dell\'articolo', 'err');
    if (price == null || Number.isNaN(price) || price < 0) return toast('Prezzo non valido', 'err');
    try {
      const { existed } = await db.upsertProduct(name, price);
      toast(existed ? `Prezzo aggiornato: ${name}` : `Aggiunto: ${name}`);
      if (!alive()) return;
      addForm.reset();
      await reload();
      if (alive()) addForm.elements.name.focus();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  $('#catQ').addEventListener('input', (e) => {
    filter = e.target.value;
    render();
  });
  $('#plist').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const p = items.find((x) => x.key === b.dataset.k);
    if (p) editProduct(p);
  });

  function editProduct(p) {
    const dlg = openSheet(`
      <h2>Modifica articolo</h2>
      <form id="editForm" novalidate autocomplete="off">
        <label class="field"><span>Nome</span><input name="name" value="${esc(p.name)}" autocapitalize="sentences"></label>
        <label class="field"><span>Prezzo €</span><input name="price" inputmode="decimal" value="${esc(numInput(p.price, 2))}"></label>
        <div class="btns">
          <button class="btn primary" type="submit">Salva</button>
          <button class="btn danger" type="button" data-a="del">Elimina articolo</button>
          <button class="btn ghost" type="button" data-a="close">Annulla</button>
        </div>
      </form>`);
    const f = $('#editForm', dlg);
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const price = parseNum(f.elements.price.value);
      if (price == null || Number.isNaN(price) || price < 0) return toast('Prezzo non valido', 'err');
      try {
        await db.upsertProduct(f.elements.name.value, price, p.key);
        closeSheet();
        toast('Articolo salvato');
        await reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    f.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') closeSheet();
      if (a === 'del') {
        if (!confirm(`Eliminare "${p.name}" dal catalogo? Gli ordini già fatti non cambiano.`)) return;
        await db.deleteProduct(p.key);
        closeSheet();
        toast('Articolo eliminato');
        await reload();
      }
    });
  }
}

/* =========================================================
   Altro: backup, intestazione PDF, info
   ========================================================= */

const fmtBytes = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);

function installHelpHtml() {
  return isIOS
    ? `<ol class="steps">
        <li>Apri questa pagina con <b>Safari</b>.</li>
        <li>Tocca <b>Condividi</b> (il quadrato con la freccia in su).</li>
        <li>Scegli <b>Aggiungi alla schermata Home</b> e poi <b>Aggiungi</b>.</li>
      </ol>`
    : '<p>Dal menu del browser scegli <b>Installa app</b> oppure <b>Aggiungi a schermata Home</b>.</p>';
}

async function viewSettings(alive) {
  const [header, lastBackup, counts, persisted, estimate] = await Promise.all([
    db.getMeta('pdfHeader'),
    db.getMeta('lastBackup'),
    db.counts(),
    navigator.storage?.persisted ? navigator.storage.persisted().catch(() => null) : null,
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : null,
  ]);
  if (!alive()) return;

  view.innerHTML = page('Altro', `
    ${!isStandalone() ? `<section class="card warn-card">
      <h2>Installa l'app</h2>
      ${installHelpHtml()}
      <p class="muted">Usa sempre l'icona sulla schermata Home: i dati inseriti qui nel browser restano separati da quelli dell'app installata.</p>
    </section>` : ''}
    <section class="card">
      <h2>Backup</h2>
      <p class="muted">I dati sono salvati solo su questo telefono. Esporta un backup almeno una volta a settimana e conservalo su iCloud Drive, per email o su WhatsApp.</p>
      <p>Ultimo backup: <b>${lastBackup ? esc(fmtDateTime(stamp(lastBackup))) : 'mai'}</b></p>
      <div class="btns two">
        <button class="btn primary" type="button" id="expBtn">Esporta backup</button>
        <label class="btn" for="impFile">Importa backup</label>
      </div>
      <input class="vh" type="file" id="impFile" accept=".json,application/json,text/plain">
    </section>
    <section class="card">
      <h2>Intestazione dei PDF</h2>
      <textarea id="pdfHeader" rows="3" placeholder="Nome della pescheria&#10;Indirizzo&#10;Telefono">${esc(header || '')}</textarea>
      <p class="hint">Compare in alto su ogni PDF; la prima riga è in grassetto.</p>
    </section>
    <section class="card">
      <h2>Dati su questo telefono</h2>
      <dl class="kv">
        <dt>Ordini</dt><dd>${counts.orders}</dd>
        <dt>Clienti</dt><dd>${counts.customers}</dd>
        <dt>Articoli</dt><dd>${counts.catalog}</dd>
        <dt>Memoria</dt><dd>${persisted === true ? 'protetta' : persisted === false ? 'standard' : 'n.d.'}${
  estimate && estimate.usage != null ? ` · ${fmtBytes(estimate.usage)} usati` : ''}</dd>
      </dl>
    </section>
    <p class="hint center">Gestione Ordini v${APP_VERSION}</p>`);

  $('#expBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const data = await db.exportAll();
      const bytes = new TextEncoder().encode(JSON.stringify(data, null, 1));
      const outcome = await shareFile(bytes, `ordini-backup-${isoDate()}.json`, 'application/json');
      if (outcome !== 'cancelled') {
        await db.setMeta('lastBackup', Date.now());
        toast('Backup esportato');
        if (alive()) route();
      }
    } catch (err) {
      console.error(err);
      toast(`Errore backup: ${err.message}`, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#impFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const b = db.normalizeBackup(data);
      const now = await db.counts();
      const msg = `Importare ${b.orders.length} ordini, ${b.customers.length} clienti e ${b.catalog.length} articoli?`
        + (now.orders || now.catalog || now.customers
          ? `\n\nATTENZIONE: i dati attuali (${now.orders} ordini) verranno sostituiti.` : '');
      if (!confirm(msg)) return;
      const r = await db.importAll(data);
      toast(`Importati ${r.orders} ordini`);
      route();
    } catch (err) {
      console.warn(err);
      toast(err instanceof SyntaxError ? 'Il file non è un backup valido' : err.message, 'err');
    }
  });

  const ta = $('#pdfHeader');
  let t = 0;
  const saveHeader = async () => {
    clearTimeout(t);
    await db.setMeta('pdfHeader', ta.value.trim());
  };
  ta.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(saveHeader, 500);
  });
  ta.addEventListener('change', async () => {
    await saveHeader();
    toast('Intestazione salvata');
  });
  onLeave(() => { if (t) saveHeader(); });
}

/* =========================================================
   Avvio, aggiornamenti, installazione
   ========================================================= */

let updateRequested = false;

function showUpdateBar(worker) {
  let bar = $('#updateBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.className = 'update-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = '<span>Nuova versione disponibile</span><button class="btn small primary" type="button">Aggiorna</button>';
  $('button', bar).onclick = () => {
    updateRequested = true;
    // chiude la vista corrente (salva la bozza) prima di ricaricare
    teardown.splice(0).forEach((fn) => { try { fn(); } catch { /* */ } });
    worker.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(() => location.reload(), 1500);
  };
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(w);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch((err) => console.warn('Service worker non registrato', err));
}

async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* non supportato */ }
}

function maybeInstallHint() {
  if (!isIOS || isStandalone()) return;
  try {
    if (sessionStorage.getItem('installHint')) return;
    sessionStorage.setItem('installHint', '1');
  } catch { /* storage non disponibile */ }
  const dlg = openSheet(`
    <h2>Installa l'app sul telefono</h2>
    ${installHelpHtml()}
    <p class="muted">Poi apri sempre l'app dall'icona "Ordini": funziona anche senza internet. I dati inseriti qui dentro Safari restano separati da quelli dell'app installata.</p>
    <div class="btns"><button class="btn primary" type="button" data-a="ok">Ho capito</button></div>`);
  $('[data-a=ok]', dlg).onclick = closeSheet;
}

async function init() {
  const dlg = $('#sheet');
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(); });

  // tocco su un suggerimento
  document.addEventListener('mousedown', (e) => { if (e.target.closest('.suggest button')) e.preventDefault(); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.suggest button');
    if (!b) return;
    const box = b.parentElement;
    const entry = box._entries && box._entries[Number(b.dataset.i)];
    hideSuggest(box);
    if (entry) entry.pick();
  });

  // con la tastiera aperta la barra in basso si nasconde
  if (window.matchMedia('(pointer: coarse)').matches) {
    document.addEventListener('focusin', (e) => {
      if (e.target.matches('input:not([type=file]):not([type=date]), textarea')) document.body.classList.add('typing');
    });
    document.addEventListener('focusout', () => setTimeout(() => {
      const a = document.activeElement;
      if (!a || !a.matches('input:not([type=file]):not([type=date]), textarea')) document.body.classList.remove('typing');
    }, 60));
  }

  try {
    await db.open();
  } catch (err) {
    view.innerHTML = page('Errore', `<div class="card">Impossibile aprire l'archivio del telefono: ${esc(err.message)}.
      <br><br>Se stai usando la navigazione privata, disattivala.</div>`);
    return;
  }

  window.addEventListener('hashchange', route);
  await route();
  requestPersistence();
  registerServiceWorker();
  maybeInstallHint();
  setTimeout(() => loadPdfLib().catch(() => {}), 2000);
}

init();
