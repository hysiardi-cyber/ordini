# Gestione Ordini v6 — app per iPhone senza App Store

App web installabile (PWA) che gira **tutta sul telefono**:

- i dati (ordini, clienti, catalogo) restano nella memoria dell'iPhone (IndexedDB);
- il PDF dell'ordine si crea sul telefono e si condivide (WhatsApp, stampa AirPrint, File);
- dopo la prima apertura funziona **anche senza internet**;
- nessun server, nessun login, nessun account sviluppatore Apple.

Il sito su cui la pubblichi contiene solo i file del programma, **mai i dati**.

---

## Contenuto della cartella

| File | A cosa serve |
|---|---|
| `index.html` | pagina dell'app |
| `css/app.css` | grafica (anche tema scuro) |
| `js/app.js` | schermate: Nuovo, Ordini, Dettaglio, Catalogo, Altro |
| `js/db.js` | archivio dati sul telefono (unico file che legge e scrive i dati) |
| `js/pdf.js` | PDF dell'ordine (stesso nome file della v5: `id_nome_gg_mm_aaaa[_mod].pdf`) |
| `js/util.js` | formati di date, prezzi, numero di versione |
| `sw.js` | service worker: tiene l'app sul telefono per l'uso offline |
| `manifest.webmanifest`, `icons/` | nome e icona sulla schermata Home |
| `vendor/pdf-lib.min.js` | libreria PDF (licenza MIT, in `vendor/pdf-lib-LICENSE.md`) |
| `tools/converti_db_v5.py` | converte il database della versione PC in un backup da importare |

---

## 1. Provarla subito sul PC (1 minuto)

Dal Prompt dei comandi, dentro questa cartella:

```
python -m http.server 8000
```

Poi apri `http://localhost:8000` in Chrome o Edge. Con F12 e l'icona del telefono
(“Toggle device toolbar”) la vedi con le dimensioni di un iPhone.
I dati che inserisci qui restano nel browser del PC.

## 2. Pubblicarla gratis su GitHub Pages (5 minuti, senza git)

1. Su github.com: **New repository**, nome per esempio `ordini`, **Public**, *Create repository*.
2. Nella pagina del repository: **uploading an existing file**. Trascina **il contenuto** di questa
   cartella (i file e le sottocartelle, non la cartella stessa), poi **Commit changes**.
3. **Settings → Pages**. In *Build and deployment* scegli *Deploy from a branch*,
   branch **main**, cartella **/(root)**, *Save*.
4. Dopo 1–2 minuti l'app è su `https://<tuo-utente>.github.io/ordini/`.

> **Mai caricare file di backup `.json` nel repository**: contengono nomi, telefoni e indirizzi dei clienti.

Con il repository pubblico si vede solo il codice. Se lo vuoi privato, GitHub Pages richiede
un piano a pagamento; in alternativa Cloudflare Pages o Netlify pubblicano gratis anche da repository privati.

## 3. Installarla sull'iPhone del gestore

1. Apri il link in **Safari** (serve internet solo questa prima volta).
2. Tocca **Condividi** (quadrato con la freccia) → **Aggiungi alla schermata Home** → **Aggiungi**.
3. Da ora si apre dall'icona **Ordini**, a schermo intero, anche offline.

Importante: Safari e l'app installata hanno **memorie separate**. Gli ordini veri vanno inseriti
solo dall'icona sulla Home. Se la pagina è aperta in Safari, l'app lo ricorda con un avviso.

## 4. Portare gli ordini dalla versione PC

Sul PC del cliente (il database della v5 è in `%APPDATA%\Ordini\ordini.db`):

```
python tools\converti_db_v5.py
```

oppure, con un percorso diverso:

```
python tools\converti_db_v5.py "C:\percorso\ordini.db"
```

Lo script legge il database senza modificarlo e crea `ordini-backup-da-pc-AAAA-MM-GG.json`.
Mandalo al telefono (email, WhatsApp o iCloud Drive) e importalo da **Altro → Importa backup**.
I numeri degli ordini restano gli stessi; i nuovi ordini continuano dalla numerazione successiva.
Funziona anche con i database delle versioni più vecchie (colonna `closed`).

## 5. Backup

I dati esistono solo su quel telefono: se cancella l'icona dalla Home, o cambia o perde l'iPhone, si perdono.

- **Altro → Esporta backup** crea un file `.json` da salvare su iCloud Drive o mandare via email o WhatsApp.
- **Altro → Importa backup** lo ripristina. Sostituisce tutti i dati presenti, dopo una conferma.
- Se l'ultimo backup ha più di 7 giorni, la lista ordini mostra un promemoria.

## 6. Pubblicare una nuova versione

1. Modifica i file.
2. Aumenta il numero di versione **in due punti, con lo stesso valore**:
   - `VERSION` in `sw.js`
   - `APP_VERSION` in `js/util.js`
3. Carica i file modificati su GitHub (Add file → Upload files).
4. Sul telefono, alla prossima apertura con internet, compare **“Nuova versione disponibile → Aggiorna”**.
   I dati restano.

Se non cambi `VERSION` in `sw.js`, il telefono continua a usare i file vecchi che ha in memoria.

---

## Cosa fa (rispetto alla v5)

Uguale alla v5: inserimento e modifica ordini, righe con prezzo preso dal catalogo,
articoli nuovi aggiunti al catalogo in automatico, stati Attivo/Chiuso/Annullato,
ricerca per numero, nome o telefono, PDF dell'ordine.

Nuovo:

- **Cliente dal numero**: scrivendo le prime cifre del telefono o del nome compaiono i clienti già
  serviti; un tocco compila nome e indirizzo.
- **Tastiere giuste**: tastierino telefonico sul telefono, numerico con virgola su quantità e prezzo.
- **Bozza automatica**: se l'app si chiude durante una telefonata, l'ordine in corso viene ripristinato.
- **Lista ordini a schede** con filtri per stato e per data (Oggi, Domani, prossime date con ordini)
  e **riepilogo articoli** (es. tutti i kg di orata da preparare per domani).
- Ordini con data passata e ancora attivi evidenziati in arancione.
- Telefono del cliente cliccabile per chiamarlo.
- **Intestazione dei PDF** configurabile (nome, indirizzo e telefono della pescheria) e PDF su più pagine.
- Invio sulla tastiera passa al campo successivo, così l'ordine non si salva per sbaglio.

## Limiti da conoscere

- I dati sono su **un solo dispositivo**: se si usa anche un iPad o il PC, ognuno ha i suoi dati,
  non sincronizzati.
- Nei PDF le emoji e i caratteri non latini diventano `?` (limite dei font standard dei PDF).
- Se si usa la navigazione privata di Safari, i dati non vengono salvati.

## Verso gli ordini online dei clienti

Tutto l'accesso ai dati passa da `js/db.js`. Quando servirà un server, per esempio per una pagina
dove i clienti ordinano da soli:

- basterà sostituire le funzioni di `db.js` con chiamate al server;
- il formato del backup (`ordini-pescheria-backup`, versione 1) si può importare direttamente
  nel database del server;
- le schermate restano le stesse.
