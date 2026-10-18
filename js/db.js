// Archivio dati sul telefono (IndexedDB).
// Tutta l'app passa da qui: in futuro, per gli ordini dei clienti via web,
// basterà sostituire queste funzioni con chiamate a un server.

import { stamp, productKey, phoneKey, round2 } from './util.js';

const DB_NAME = 'ordini-pescheria';
const DB_VERSION = 1;
export const BACKUP_FORMAT = 'ordini-pescheria-backup';
const STATUSES = ['ATTIVO', 'CHIUSO', 'ANNULLATO'];

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB non disponibile'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('orders')) {
        const s = db.createObjectStore('orders', { keyPath: 'id', autoIncrement: true });
        s.createIndex('status', 'status');
        s.createIndex('delivery_date', 'delivery_date');
      }
      if (!db.objectStoreNames.contains('catalog')) db.createObjectStore('catalog', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('customers')) db.createObjectStore('customers', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("Database bloccato: chiudi le altre finestre dell'app"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Esegue fn dentro una transazione; risolve al commit con il valore restituito da fn.
async function withTx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Operazione annullata'));
    Promise.resolve()
      .then(() => fn(tx))
      .then((r) => { result = r; })
      .catch((err) => {
        try { tx.abort(); } catch { /* già chiusa */ }
        reject(err);
      });
  });
}

/* ---------------- ordini ---------------- */

export async function listOrders() {
  const all = await withTx(['orders'], 'readonly', (tx) => reqP(tx.objectStore('orders').getAll()));
  return all.sort((a, b) => b.id - a.id);
}

export const getOrder = (id) =>
  withTx(['orders'], 'readonly', (tx) => reqP(tx.objectStore('orders').get(Number(id)))).then((o) => o || null);

// Crea (senza id) o aggiorna (con id) un ordine.
// Aggiorna anche la rubrica clienti e aggiunge al catalogo gli articoli nuovi, come nella v5.
export async function saveOrder(input) {
  const now = stamp();
  const items = input.items.map((it) => ({
    product: String(it.product).trim(),
    qty: Number(it.qty),
    price: round2(it.price),
    subtotal: round2(Number(it.qty) * round2(it.price)),
  }));
  const fields = {
    phone: input.phone.trim(),
    name: input.name.trim(),
    address: (input.address || '').trim(),
    delivery_date: input.delivery_date || '',
    note: (input.note || '').trim(),
    status: STATUSES.includes(input.status) ? input.status : 'ATTIVO',
    items,
    total: round2(items.reduce((s, it) => s + it.subtotal, 0)),
  };

  return withTx(['orders', 'catalog', 'customers'], 'readwrite', async (tx) => {
    const os = tx.objectStore('orders');
    let order;
    if (input.id) {
      const existing = await reqP(os.get(Number(input.id)));
      if (!existing) throw new Error(`Ordine #${input.id} non trovato`);
      order = { ...existing, ...fields, updated_at: now, revision: (existing.revision || 0) + 1 };
    } else {
      order = { ...fields, created_at: now, updated_at: now, revision: 0 };
    }
    order.id = await reqP(os.put(order));

    const cs = tx.objectStore('catalog');
    for (const it of items) {
      const key = productKey(it.product);
      if (!key) continue;
      const found = await reqP(cs.get(key));
      if (!found) cs.put({ key, name: it.product, price: it.price });
    }

    const ckey = phoneKey(fields.phone);
    if (ckey) {
      tx.objectStore('customers').put({
        key: ckey, phone: fields.phone, name: fields.name, address: fields.address, updated_at: now,
      });
    }
    return order;
  });
}

export const setStatus = (id, status) => withTx(['orders'], 'readwrite', async (tx) => {
  if (!STATUSES.includes(status)) throw new Error('Stato non valido');
  const os = tx.objectStore('orders');
  const o = await reqP(os.get(Number(id)));
  if (!o) throw new Error(`Ordine #${id} non trovato`);
  o.status = status;
  o.updated_at = stamp();
  os.put(o);
  return o;
});

export const deleteOrder = (id) =>
  withTx(['orders'], 'readwrite', (tx) => { tx.objectStore('orders').delete(Number(id)); });

/* ---------------- catalogo ---------------- */

export async function listCatalog() {
  const all = await withTx(['catalog'], 'readonly', (tx) => reqP(tx.objectStore('catalog').getAll()));
  return all.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
}

// Inserisce o aggiorna un articolo. oldKey serve quando si rinomina.
export const upsertProduct = (name, price, oldKey = null) =>
  withTx(['catalog'], 'readwrite', async (tx) => {
    const cs = tx.objectStore('catalog');
    const clean = String(name).trim().replace(/\s+/g, ' ');
    const key = productKey(clean);
    if (!key) throw new Error('Nome articolo obbligatorio');
    if (oldKey && oldKey !== key) {
      const clash = await reqP(cs.get(key));
      if (clash) throw new Error(`Esiste già un articolo "${clash.name}"`);
      cs.delete(oldKey);
    }
    const existed = !!(await reqP(cs.get(key)));
    cs.put({ key, name: clean, price: round2(price) });
    return { key, existed };
  });

export const deleteProduct = (key) =>
  withTx(['catalog'], 'readwrite', (tx) => { tx.objectStore('catalog').delete(key); });

/* ---------------- clienti ---------------- */

export async function listCustomers() {
  const all = await withTx(['customers'], 'readonly', (tx) => reqP(tx.objectStore('customers').getAll()));
  return all.sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
}

/* ---------------- impostazioni / meta ---------------- */

export const getMeta = (key) =>
  withTx(['meta'], 'readonly', (tx) => reqP(tx.objectStore('meta').get(key))).then((r) => (r ? r.value : null));

export const setMeta = (key, value) =>
  withTx(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').put({ key, value }); });

export const deleteMeta = (key) =>
  withTx(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').delete(key); });

export const counts = () => withTx(['orders', 'catalog', 'customers'], 'readonly', async (tx) => ({
  orders: await reqP(tx.objectStore('orders').count()),
  catalog: await reqP(tx.objectStore('catalog').count()),
  customers: await reqP(tx.objectStore('customers').count()),
}));

/* ---------------- backup ---------------- */

export async function exportAll() {
  const [orders, catalog, customers, pdfHeader] = await Promise.all([
    listOrders(), listCatalog(), listCustomers(), getMeta('pdfHeader'),
  ]);
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exported_at: stamp(),
    orders: orders.sort((a, b) => a.id - b.id),
    catalog: catalog.map(({ name, price }) => ({ name, price })),
    customers: customers.map(({ phone, name, address }) => ({ phone, name, address })),
    settings: { pdfHeader: pdfHeader || '' },
  };
}

const str = (v) => (v == null ? '' : String(v));
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Controlla e normalizza un file di backup (anche quello creato dallo script di conversione v5).
export function normalizeBackup(data) {
  if (!data || typeof data !== 'object' || data.format !== BACKUP_FORMAT) {
    throw new Error('Il file non è un backup di Gestione Ordini');
  }
  const seen = new Set();
  const orders = (Array.isArray(data.orders) ? data.orders : []).map((o, i) => {
    const id = Number(o.id);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`Ordine n. ${i + 1}: numero non valido`);
    if (seen.has(id)) throw new Error(`Ordine #${id} presente due volte`);
    seen.add(id);
    const items = (Array.isArray(o.items) ? o.items : []).map((it) => ({
      product: str(it.product).trim(),
      qty: num(it.qty),
      price: round2(num(it.price)),
      subtotal: round2(it.subtotal != null ? num(it.subtotal) : num(it.qty) * num(it.price)),
    })).filter((it) => it.product);
    const created = str(o.created_at) || stamp();
    return {
      id,
      created_at: created,
      updated_at: str(o.updated_at) || created,
      revision: Number.isInteger(o.revision) ? o.revision : 0,
      delivery_date: /^\d{4}-\d{2}-\d{2}$/.test(str(o.delivery_date)) ? str(o.delivery_date) : '',
      phone: str(o.phone).trim(),
      name: str(o.name).trim(),
      address: str(o.address).trim(),
      note: str(o.note).trim(),
      status: STATUSES.includes(o.status) ? o.status : 'ATTIVO',
      items,
      total: round2(o.total != null ? num(o.total) : items.reduce((s, it) => s + it.subtotal, 0)),
    };
  });
  const catalog = new Map();
  (Array.isArray(data.catalog) ? data.catalog : []).forEach((p) => {
    const name = str(p.name).trim().replace(/\s+/g, ' ');
    const key = productKey(name);
    if (key) catalog.set(key, { key, name, price: round2(num(p.price)) });
  });
  const customers = new Map();
  (Array.isArray(data.customers) ? data.customers : []).forEach((c) => {
    const key = phoneKey(c.phone);
    if (key) {
      customers.set(key, {
        key, phone: str(c.phone).trim(), name: str(c.name).trim(), address: str(c.address).trim(), updated_at: stamp(),
      });
    }
  });
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  return {
    orders,
    catalog: [...catalog.values()],
    customers: [...customers.values()],
    settings: { pdfHeader: str(settings.pdfHeader) },
  };
}

// Sostituisce TUTTI i dati con quelli del backup.
export async function importAll(data) {
  const b = normalizeBackup(data);
  await withTx(['orders', 'catalog', 'customers', 'meta'], 'readwrite', (tx) => {
    ['orders', 'catalog', 'customers'].forEach((s) => tx.objectStore(s).clear());
    b.orders.forEach((o) => tx.objectStore('orders').put(o));
    b.catalog.forEach((p) => tx.objectStore('catalog').put(p));
    b.customers.forEach((c) => tx.objectStore('customers').put(c));
    tx.objectStore('meta').put({ key: 'pdfHeader', value: b.settings.pdfHeader });
    tx.objectStore('meta').delete('draft');
  });
  return { orders: b.orders.length, catalog: b.catalog.length, customers: b.customers.length };
}
