// Funzioni di formattazione e conversione condivise.

export const APP_VERSION = '6.0.0'; // tenere allineato con VERSION in sw.js

export const STATUS = { ATTIVO: 'Attivo', CHIUSO: 'Chiuso', ANNULLATO: 'Annullato' };

const fmtEUR = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const fmtQty = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 3 });

export const eur = (n) => fmtEUR.format(Number(n) || 0);
export const qtyStr = (n) => fmtQty.format(Number(n) || 0);
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// "2,5" -> 2.5 ; "" -> null ; "abc" -> NaN
export function parseNum(raw) {
  let s = String(raw ?? '').trim().replace(/[\s€]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// numero -> testo per un campo di input ("2.5" -> "2,5")
export const numInput = (n, decimals = null) =>
  (decimals == null ? String(Number(n) || 0) : (Number(n) || 0).toFixed(decimals)).replace('.', ',');

export const pad2 = (n) => String(n).padStart(2, '0');

export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

// timestamp locale nel formato della v5: "AAAA-MM-GG HH:MM:SS"
export function stamp(ms = Date.now()) {
  const d = new Date(ms);
  return `${isoDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function stampToMs(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

const WD_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const WD_LONG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

function parseIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

// "oggi", "domani", "mer 24/12"
export function fmtDay(iso) {
  const d = parseIso(iso);
  if (!d) return '';
  if (iso === isoDate()) return 'oggi';
  if (iso === addDays(1)) return 'domani';
  if (iso === addDays(-1)) return 'ieri';
  const y = d.getFullYear() !== new Date().getFullYear() ? '/' + d.getFullYear() : '';
  return `${WD_SHORT[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}${y}`;
}

// "mercoledì 24/12/2026"
export function fmtDateLong(iso) {
  const d = parseIso(iso);
  if (!d) return '-';
  return `${WD_LONG[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// "2026-12-24 10:05:00" -> "24/12/2026 10:05"
export function fmtDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : (s || '-');
}

export const productKey = (name) => String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const phoneKey = (phone) => String(phone ?? '').replace(/[^\d+]/g, '');
