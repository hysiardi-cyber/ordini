"""
Converte il database della versione PC (v1-v5, SQLite) nel file di backup
da importare nell'app sul telefono (Altro > Importa backup).

Uso (serve solo Python 3, nessuna libreria da installare):

    python converti_db_v5.py
        legge il database standard della v5: %APPDATA%\\Ordini\\ordini.db

    python converti_db_v5.py "C:\\percorso\\ordini.db"
    python converti_db_v5.py "C:\\percorso\\ordini.db" "backup.json"

Il file .json creato va mandato al telefono (email, WhatsApp, iCloud Drive)
e importato dall'app. Il database originale viene solo letto, mai modificato.
"""

import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

BACKUP_FORMAT = "ordini-pescheria-backup"


def default_db_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "Ordini" / "ordini.db"
    return Path.home() / ".ordini" / "ordini.db"


def phone_key(phone: str) -> str:
    return "".join(ch for ch in (phone or "") if ch.isdigit() or ch == "+")


def columns(con, table):
    try:
        return {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else default_db_path()
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.cwd() / f"ordini-backup-da-pc-{datetime.now():%Y-%m-%d}.json"

    if not src.exists():
        sys.exit(f"Database non trovato: {src}")

    con = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    order_cols = columns(con, "orders")
    if not order_cols:
        sys.exit("Il file non contiene la tabella 'orders': non sembra un database di Gestione Ordini.")

    items_by_order = {}
    for it in con.execute("SELECT * FROM order_items ORDER BY order_id, id"):
        items_by_order.setdefault(it["order_id"], []).append({
            "product": (it["product"] or "").strip(),
            "qty": float(it["qty"] or 0),
            "price": round(float(it["price"] or 0), 2),
            "subtotal": round(float(it["subtotal"] or 0), 2),
        })

    orders = []
    for o in con.execute("SELECT * FROM orders ORDER BY id"):
        status = (o["status"] if "status" in order_cols else "") or "ATTIVO"
        status = status.strip().upper()
        # versioni vecchie: colonna "closed" (1 = chiuso)
        if "closed" in order_cols and o["closed"] and status == "ATTIVO":
            status = "CHIUSO"
        if status not in ("ATTIVO", "CHIUSO", "ANNULLATO"):
            status = "ATTIVO"
        items = [it for it in items_by_order.get(o["id"], []) if it["product"]]
        orders.append({
            "id": o["id"],
            "created_at": o["created_at"] or "",
            "updated_at": o["created_at"] or "",
            "revision": 0,
            "delivery_date": o["delivery_date"] or "",
            "phone": o["phone"] or "",
            "name": o["name"] or "",
            "address": o["address"] or "",
            "note": (o["note"] if "note" in order_cols else "") or "",
            "status": status,
            "items": items,
            "total": round(float(o["total"] or 0), 2),
        })

    catalog = []
    if columns(con, "catalog"):
        for p in con.execute("SELECT name, price FROM catalog ORDER BY name"):
            if (p["name"] or "").strip():
                catalog.append({"name": p["name"].strip(), "price": round(float(p["price"] or 0), 2)})

    customers = {}
    if columns(con, "customers"):
        for c in con.execute("SELECT phone, name, address FROM customers"):
            if phone_key(c["phone"]):
                customers[phone_key(c["phone"])] = {"phone": c["phone"], "name": c["name"] or "", "address": c["address"] or ""}
    # clienti presenti solo negli ordini (versioni senza rubrica)
    for o in orders:
        k = phone_key(o["phone"])
        if k and k not in customers:
            customers[k] = {"phone": o["phone"], "name": o["name"], "address": o["address"]}

    con.close()

    data = {
        "format": BACKUP_FORMAT,
        "version": 1,
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": f"database PC: {src.name}",
        "orders": orders,
        "catalog": catalog,
        "customers": list(customers.values()),
        "settings": {},
    }
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"Letto:   {src}")
    print(f"Creato:  {out}")
    print(f"Ordini {len(orders)}, clienti {len(customers)}, articoli {len(catalog)}")
    print("Manda il file al telefono e importalo da: Altro > Importa backup")


if __name__ == "__main__":
    main()
