// PDF dell'ordine generato direttamente sul telefono (libreria pdf-lib, inclusa in vendor/).
// Stesso contenuto e stesso nome file della v5: <id>_<nome>_gg_mm_aaaa[_mod].pdf

import { STATUS, eur, qtyStr, fmtDateLong, fmtDateTime, pad2, stamp } from './util.js';

let pdfLibPromise = null;

export function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (!pdfLibPromise) {
    pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../vendor/pdf-lib.min.js', import.meta.url).href;
      s.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error('Libreria PDF non valida')));
      s.onerror = () => {
        pdfLibPromise = null;
        s.remove();
        reject(new Error('Libreria PDF non caricata'));
      };
      document.head.appendChild(s);
    });
  }
  return pdfLibPromise;
}

// I font standard dei PDF usano la codifica WinAnsi: i caratteri fuori set diventano "?"
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function pdfSafe(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[   \t]/g, ' ')
    .replace(/\r/g, '')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/gu, (ch) => (WIN_ANSI_EXTRA.includes(ch) ? ch : '?'));
}

function sanitizeFilenamePart(s, maxLen = 60) {
  const t = String(s || '').trim().replace(/[\\/?*[\]:"<>|]+/g, '-').replace(/\s+/g, '_');
  return t ? t.slice(0, maxLen) : 'CLIENTE';
}

export function orderPdfFilename(order, when = new Date()) {
  const suffix = order.revision ? '_mod' : '';
  return `${order.id}_${sanitizeFilenamePart(order.name)}_${pad2(when.getDate())}_${pad2(when.getMonth() + 1)}_${when.getFullYear()}${suffix}.pdf`;
}

export async function buildOrderPdf(order, header = '') {
  const { PDFDocument, StandardFonts, rgb } = await loadPdfLib();
  const doc = await PDFDocument.create();
  doc.setTitle(`Ordine ${order.id} - ${pdfSafe(order.name)}`);
  doc.setCreator('Gestione Ordini');
  doc.setProducer('Gestione Ordini');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const MM = 72 / 25.4;
  const W = 595.28;
  const H = 841.89;
  const X0 = 15 * MM;
  const X1 = W - 15 * MM;
  const INK = rgb(0.08, 0.1, 0.12);
  const GREY = rgb(0.42, 0.45, 0.5);
  const LINE = rgb(0.78, 0.8, 0.83);
  const BOTTOM = 22 * MM;

  const pages = [];
  let page;
  let y;
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = H - 18 * MM;
  };

  const draw = (s, x, size = 10, f = font, color = INK) => {
    page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  };
  const drawRight = (s, xr, size = 10, f = font, color = INK) => {
    const t = pdfSafe(s);
    page.drawText(t, { x: xr - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };
  const hline = (yy, thickness = 0.5, color = LINE) => {
    page.drawLine({ start: { x: X0, y: yy }, end: { x: X1, y: yy }, thickness, color });
  };
  // a capo automatico entro maxW punti
  const wrap = (s, f, size, maxW) => {
    const out = [];
    pdfSafe(s).split('\n').forEach((para) => {
      let line = '';
      para.split(/ +/).forEach((word) => {
        let w = word;
        // parole più lunghe della riga: spezzate a forza
        while (f.widthOfTextAtSize(w, size) > maxW) {
          let cut = w.length - 1;
          while (cut > 1 && f.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
          if (line) { out.push(line); line = ''; }
          out.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        const tryLine = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(tryLine, size) <= maxW) line = tryLine;
        else { out.push(line); line = w; }
      });
      out.push(line);
    });
    return out.length ? out : [''];
  };

  newPage();

  // intestazione del negozio (facoltativa)
  const headLines = String(header || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (headLines.length) {
    headLines.forEach((l, i) => {
      draw(l, X0, i === 0 ? 13 : 9.5, i === 0 ? bold : font, i === 0 ? INK : GREY);
      y -= (i === 0 ? 5.5 : 4.4) * MM;
    });
    y -= 1 * MM;
    hline(y + 2.5 * MM, 0.8, INK);
    y -= 7 * MM;
  }

  draw(`Ordine #${order.id}`, X0, 15, bold);
  drawRight(`Stato: ${STATUS[order.status] || order.status}`, X1, 10, bold, GREY);
  y -= 9 * MM;

  const LABEL_W = 30 * MM;
  const info = [
    ['Data ordine', fmtDateTime(order.created_at)],
    ['Data richiesta', order.delivery_date ? fmtDateLong(order.delivery_date) : '-'],
    ['Cliente', `${order.name} - ${order.phone}`],
    ['Indirizzo', order.address || '-'],
    ['Note', order.note || '-'],
  ];
  info.forEach(([label, value]) => {
    draw(`${label}:`, X0, 10, bold);
    wrap(value, font, 10, X1 - X0 - LABEL_W).forEach((l, i) => {
      if (i > 0) y -= 4.8 * MM;
      draw(l, X0 + LABEL_W, 10);
    });
    y -= 6 * MM;
  });
  y -= 4 * MM;

  // tabella articoli
  const COL_PROD_W = 92 * MM;
  const X_QTY = X0 + 117 * MM;
  const X_PRICE = X0 + 148 * MM;
  const drawTableHeader = () => {
    draw('Prodotto', X0, 10, bold);
    drawRight('Q.tà', X_QTY, 10, bold);
    drawRight('Prezzo', X_PRICE, 10, bold);
    drawRight('Subtotale', X1, 10, bold);
    y -= 3 * MM;
    hline(y, 0.9, INK);
    y -= 5.5 * MM;
  };
  drawTableHeader();

  order.items.forEach((it) => {
    const lines = wrap(it.product, font, 10, COL_PROD_W);
    const needed = (lines.length - 1) * 4.8 * MM + 8.5 * MM;
    if (y - needed < BOTTOM) {
      newPage();
      drawTableHeader();
    }
    draw(lines[0], X0, 10);
    drawRight(qtyStr(it.qty), X_QTY, 10);
    drawRight(eur(it.price), X_PRICE, 10);
    drawRight(eur(it.subtotal), X1, 10);
    for (let i = 1; i < lines.length; i++) {
      y -= 4.8 * MM;
      draw(lines[i], X0, 10);
    }
    y -= 3 * MM;
    hline(y);
    y -= 5.5 * MM;
  });

  if (y - 10 * MM < BOTTOM) newPage();
  y -= 2 * MM;
  drawRight(`Totale: ${eur(order.total)}`, X1, 13, bold);

  // piè di pagina
  const generated = `Generato il ${fmtDateTime(stamp())}`;
  pages.forEach((p, i) => {
    p.drawText(pdfSafe(generated), { x: X0, y: 10 * MM, size: 8, font, color: GREY });
    const pn = `Pagina ${i + 1} di ${pages.length}`;
    p.drawText(pn, { x: X1 - font.widthOfTextAtSize(pn, 8), y: 10 * MM, size: 8, font, color: GREY });
  });

  return doc.save();
}
