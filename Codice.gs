/**
 * ============================================================
 *  TRIPHUB — Backend API (Google Apps Script)  · v4
 * ============================================================
 *  Espone il Google Sheet come API JSON.
 *  - doGet  : lettura (action=list)
 *  - doPost : scrittura (action=create|update|delete|...)
 *
 *  ------------------------------------------------------------
 *  SICUREZZA — DUE LIVELLI (novità v4)
 *  ------------------------------------------------------------
 *  1) CODICE MASTER (amministratore)
 *     Sta nelle Script Properties, proprietà  API_TOKEN.
 *     Chi lo possiede vede e modifica TUTTO: crea/elimina viaggi,
 *     gestisce la rubrica, fa backup e import.
 *
 *  2) CODICE DEL SINGOLO VIAGGIO (partecipanti)
 *     Ogni riga di "Viaggi" ha ora una colonna  codice.
 *     Chi entra con quel codice vede ED È AUTORIZZATO A MODIFICARE
 *     soltanto i viaggi che hanno quel codice. Non può:
 *       - vedere gli altri viaggi (nemmeno l'elenco)
 *       - creare o eliminare viaggi
 *       - cambiare il codice di accesso
 *       - leggere la rubrica, esportare o importare
 *     Più viaggi possono condividere lo stesso codice: utile per un
 *     gruppo stabile di amici che viaggia insieme più volte.
 *
 *  Il controllo NON è cosmetico: ogni azione verifica lato server
 *  a quale viaggio appartiene la riga toccata.
 *
 *  ------------------------------------------------------------
 *  NOVITÀ SCHEMA v4 (colonne AGGIUNTE IN CODA, dati intatti)
 *  ------------------------------------------------------------
 *  - Viaggi.codice          → codice di accesso del viaggio
 *  - Voli.costo_bagaglio    → costo bagagli separato dal costo volo
 *  - Voli.pnr               → codice di prenotazione
 *  - Alloggi.mappa_link     → link "condividi" di Google Maps
 *  - Alloggi.pnr            → codice di prenotazione
 *  - NUOVO TAB "Rubrica"    → anagrafica viaggiatori riutilizzabile
 *
 *  ⚠️ DOPO IL DEPLOY: esegui una volta  setupSheets()  dall'editor.
 *  Aggiunge SOLO le colonne mancanti in fondo e crea il tab Rubrica.
 *  Non tocca né sposta i dati esistenti.
 * ============================================================
 */

// ---- CONFIG ----
// Le colonne NUOVE vanno sempre aggiunte IN FONDO all'array:
// il foglio esistente mantiene le posizioni originali.
const SCHEMA = {
  Viaggi:      ['id','nome','destinazione','paese','data_inizio','data_fine','n_persone','stato','note','codice'],
  Partecipanti:['id','viaggio_id','nome','cognome','data_nascita','luogo_nascita','tipo_doc','scadenza_doc','nazionalita','telefono','email','note'],
  Alloggi:     ['id','viaggio_id','struttura','checkin','ora_checkin','checkout','ora_checkout','notti','persone','prezzo_notte','extra','totale','prezzo_testa','prezzo_testa_notte','link','indirizzo','posizione','valutazione','scelto','note','mappa_link','pnr','pagato_da','scadenza_pag'],
  Voli:        ['id','viaggio_id','gruppo_id','opzione','direzione','tratta','persone','paganti','compagnia','n_volo','da','a','data_part','ora_part','data_arr','ora_arr','scalo','totale','prezzo_testa','bagaglio','scelto','note','costo_bagaglio','pnr','pagato_da','scadenza_pag'],
  Spese:       ['id','viaggio_id','data','descrizione','categoria','paganti','persone','totale','prezzo_testa','note','pagato_da'],
  CoseDaFare:  ['id','viaggio_id','data','ora','tipo','attivita','posizione','durata','persone','costo','prezzo_testa','prenotazione_req','quando','link','note','confermata'],
  CosaPortare: ['id','viaggio_id','categoria','cosa','qta','chi','spuntato','priorita','note'],
  Contatti:    ['id','viaggio_id','categoria','nome','telefono','link','indirizzo','note','email','mappa_link'],
  InfoDest:    ['id','viaggio_id','sezione','chiave','valore','link'],
  // Movimenti di denaro veri, separati dai COSTI (che stanno su Voli/Alloggi/Spese):
  //  tipo 'anticipo' → chi ha tirato fuori i soldi, diviso fra `paganti`
  //  tipo 'rimborso' → chi restituisce a chi (nessuna divisione)
  Pagamenti:   ['id','viaggio_id','data','tipo','chi','verso','importo','riferimento','paganti','note'],
  // Anagrafica globale, NON legata a un viaggio: solo l'amministratore la vede.
  Rubrica:     ['id','nome','cognome','data_nascita','luogo_nascita','tipo_doc','scadenza_doc','nazionalita','telefono','email','note']
};

// Tab che non hanno (e non devono avere) una colonna viaggio_id
const GLOBAL_SHEETS = ['Viaggi','Rubrica'];

// Colonne che ESISTEVANO e non devono più circolare: numeri di documento e
// codici fiscali. L'app usa solo la scadenza del documento (per l'avviso
// "scade prima del rientro"); il numero non serviva a niente e in un foglio
// condiviso con un codice che gira su WhatsApp era un rischio inutile.
// listRows() le salta anche se nel foglio ci sono ancora; sanitize() le
// scarta in scrittura perché non stanno più in SCHEMA. Per svuotare quello
// che c'è già: esegui una volta purgeDroppedColumns() dall'editor.
const DROPPED_COLS = ['num_doc','cod_fiscale'];

// Colonne che devono restare NUMERO puro (evita auto-conversione in data/ora da parte di Sheets)
const NUM_COLS = ['totale','prezzo_notte','prezzo_testa','prezzo_testa_notte','extra','costo','notti','persone','qta','valutazione','n_persone','tratta','opzione','costo_bagaglio','importo'];

// Colonne che devono restare TESTO esatto (date, ore, codici alfanumerici):
// mai oggetti Date né numeri, altrimenti Sheets sfasa il giorno o mangia gli zeri iniziali.
const TEXT_COLS = ['data_inizio','data_fine','checkin','checkout','data_part','data_arr','ora_part','ora_arr','data','ora','data_nascita','scadenza_doc','ora_checkin','ora_checkout','codice','pnr',
                   // numeri di telefono e documenti: il "+" iniziale verrebbe letto come formula,
                   // e gli zeri iniziali (0165..., 00358...) verrebbero mangiati.
                   'telefono','n_volo','scadenza_pag'];

// Azioni che modificano i dati (protette da LockService)
const WRITE_ACTIONS = ['create','update','delete','create_many','update_many','delete_group','replace_group',
                       'import','delete_trip','set_scelta','merge_groups','set_flags'];

// ============================================================
//  ENTRY POINTS
// ============================================================

function doGet(e)  { return handle(e, 'GET');  }
function doPost(e) { return handle(e, 'POST'); }

function handle(e, method) {
  var lock = null;
  try {
    var params = (e && e.parameter) ? e.parameter : {};
    var body = {};
    if (method === 'POST' && e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var req = Object.assign({}, params, body);

    // --- Auth: ricava ruolo e viaggi consentiti dal codice ricevuto ---
    var ctx = authContext(req.token);
    if (!ctx) return json({ ok: false, error: 'unauthorized' });

    var action = req.action;
    var sheet  = req.sheet;

    // --- Lock sulle scritture: evita corse tra utenti concorrenti ---
    if (WRITE_ACTIONS.indexOf(action) >= 0) {
      lock = LockService.getScriptLock();
      if (!lock.tryLock(20000)) {
        return json({ ok: false, error: 'server occupato, riprova tra qualche secondo' });
      }
    }

    var out;
    if      (action === 'auth')          out = authInfo(ctx);
    else if (action === 'list')          out = listFiltered(ctx, sheet, req.viaggio_id);
    else if (action === 'all')           out = listAll(req.viaggio_id, ctx);
    else if (action === 'create')        out = createGuarded(ctx, sheet, req.record);
    else if (action === 'update')        out = updateGuarded(ctx, sheet, req.record);
    else if (action === 'delete')        out = deleteGuarded(ctx, sheet, req.id);
    else if (action === 'create_many')   out = createManyGuarded(ctx, sheet, req.records);
    else if (action === 'update_many')   out = updateManyGuarded(ctx, sheet, req.records);
    else if (action === 'delete_group')  out = deleteGroup(sheet, req.gruppo_id, req.ids, ctx);
    else if (action === 'replace_group') out = replaceGroupGuarded(ctx, sheet, req.gruppo_id, req.records, req.ids);
    else if (action === 'set_scelta')    out = setSceltaGuarded(ctx, req.viaggio_id, req.gruppo_id, req.on);
    else if (action === 'merge_groups')  out = mergeGroupsGuarded(ctx, req.viaggio_id, req.gruppo_id, req.source_id);
    else if (action === 'set_flags')     out = setFlags(sheet, req.field, req.values, ctx);
    else if (action === 'delete_trip')   { adminOnly(ctx); out = deleteTrip(req.id); }
    else if (action === 'export')        { adminOnly(ctx); out = exportAll(); }
    else if (action === 'import')        { adminOnly(ctx); out = importAll(req.payload, req.mode); }
    else return json({ ok: false, error: 'unknown action: ' + action });

    return json({ ok: true, data: out });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

// ============================================================
//  AUTH & AUTORIZZAZIONI
// ============================================================

/**
 * Trasforma il codice ricevuto in un "contesto":
 *   { role:'admin', trips:null }              → può tutto
 *   { role:'trip',  trips:{ id:true, ... } }  → solo quei viaggi
 *   null                                      → codice non valido
 */
/**
 * Il risultato viene messo in CacheService: senza cache OGNI chiamata
 * dell'app rileggeva l'intero foglio Viaggi solo per capire chi sei, e
 * una lettura di foglio costa piu' di tutto il resto della richiesta.
 *
 * La cache e' "namespaced": ogni scrittura sui Viaggi incrementa AUTH_NS,
 * quindi le vecchie voci diventano irraggiungibili all'istante. Cosi' un
 * codice cambiato o un viaggio eliminato hanno effetto subito, senza
 * aspettare la scadenza.
 */
var AUTH_TTL = 600;   // 10 minuti: oltre, si rilegge comunque

function authCacheKey(ns, token) {
  var raw = 'a1|' + ns + '|' + token;
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  var out = '';
  for (var i = 0; i < d.length; i++) out += ('0' + (d[i] & 0xFF).toString(16)).slice(-2);
  return 'auth_' + out;
}

function bumpAuthNs() {
  try {
    var props = PropertiesService.getScriptProperties();
    var n = Number(props.getProperty('AUTH_NS') || '0') || 0;
    props.setProperty('AUTH_NS', String((n + 1) % 1000000));
  } catch (ignore) {}
}

function authContext(token) {
  token = String(token == null ? '' : token).trim();
  if (!token) return null;

  // una sola chiamata a Properties per master token + namespace della cache
  var props  = PropertiesService.getScriptProperties().getProperties() || {};
  var master = props.API_TOKEN;
  if (master && token === String(master).trim()) return { role: 'admin', trips: null };

  var ns    = props.AUTH_NS || '0';
  var cache = null, key = null;
  try {
    cache = CacheService.getScriptCache();
    key   = authCacheKey(ns, token);
    var hit = cache.get(key);
    if (hit) {
      var v = JSON.parse(hit);
      return v.ok ? { role: 'trip', trips: v.trips } : null;
    }
  } catch (ignore) { cache = null; }

  // codice di viaggio: confronto senza distinzione fra maiuscole e minuscole
  var wanted = token.toLowerCase();
  var trips = {};
  var found = 0;
  listRows('Viaggi').forEach(function (v) {
    var c = String(v.codice == null ? '' : v.codice).trim().toLowerCase();
    if (c && c === wanted) { trips[String(v.id)] = true; found++; }
  });

  if (cache && key) {
    // anche il "codice sbagliato" va in cache, con vita breve: evita che
    // un tentativo ripetuto rilegga il foglio a ogni colpo
    try { cache.put(key, JSON.stringify({ ok: !!found, trips: trips }), found ? AUTH_TTL : 60); }
    catch (ignore) {}
  }
  return found ? { role: 'trip', trips: trips } : null;
}

function authInfo(ctx) {
  return {
    role: ctx.role,
    viaggi: ctx.role === 'admin' ? null : Object.keys(ctx.trips)
  };
}

function adminOnly(ctx) {
  if (ctx.role !== 'admin') throw 'forbidden: serve il codice amministratore';
}

function allowTrip(ctx, viaggioId) {
  if (ctx.role === 'admin') return true;
  if (!viaggioId) return false;
  return ctx.trips[String(viaggioId)] === true;
}

function guardTrip(ctx, viaggioId) {
  if (!allowTrip(ctx, viaggioId)) throw 'forbidden: viaggio non accessibile con questo codice';
}

// Ricava il viaggio di appartenenza di una riga a partire dal suo id
function rowTripId(name, id) {
  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var iId = hdr.indexOf('id');
  var iV  = hdr.indexOf('viaggio_id');
  if (iId < 0 || iV < 0) return null;
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][iId]) === String(id)) return String(vals[i][iV]);
  }
  return null;
}

function guardRow(ctx, name, id) {
  if (ctx.role === 'admin') return;
  if (GLOBAL_SHEETS.indexOf(name) >= 0) throw 'forbidden';
  guardTrip(ctx, rowTripId(name, id));
}

// Toglie il codice di accesso dalle risposte destinate ai non amministratori
function stripCode(v) {
  var o = {};
  Object.keys(v).forEach(function (k) { if (k !== 'codice') o[k] = v[k]; });
  return o;
}

// ============================================================
//  DATA HELPERS
// ============================================================

// Cache entro la singola richiesta: apre lo spreadsheet e ogni foglio una volta sola.
var _SS = null;
var _SHEETS = {};

function ss() {
  if (!_SS) _SS = SpreadsheetApp.getActiveSpreadsheet();
  return _SS;
}

function getSheet(name) {
  if (!SCHEMA[name]) throw 'sheet non valido: ' + name;
  if (_SHEETS[name]) return _SHEETS[name];
  var sh = ss().getSheetByName(name);
  if (!sh) {                            // crea il tab se manca, con header
    sh = ss().insertSheet(name);
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
    sh.setFrozenRows(1);
  }
  _SHEETS[name] = sh;
  return sh;
}

/**
 * Header reali del foglio + creazione automatica delle colonne mancanti.
 * Le nuove colonne di schema vengono APPESE in fondo: le posizioni delle
 * colonne già esistenti non si spostano mai, quindi i dati restano allineati.
 */
function headers(sh, name) {
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) {                  // foglio vuoto → scrivi header
    sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]);
    sh.setFrozenRows(1);
    return SCHEMA[name].slice();
  }
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = SCHEMA[name].filter(function (c) { return hdr.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, hdr.length + 1, 1, missing.length).setValues([missing]);
    hdr = hdr.concat(missing);
  }
  return hdr;
}

// Tiene del record solo le chiavi previste dallo schema del tab.
function sanitize(name, record) {
  var allowed = SCHEMA[name];
  var out = {};
  Object.keys(record || {}).forEach(function (k) {
    if (allowed.indexOf(k) >= 0) out[k] = record[k];
  });
  return out;
}

function listRows(name, viaggioId) {
  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var obj = {};
    var empty = true;
    for (var c = 0; c < hdr.length; c++) {
      if (DROPPED_COLS.indexOf(hdr[c]) >= 0) continue;
      var val = values[i][c];
      // Se una cella data/ora è finita come Date (dati vecchi), riportala a stringa
      // nel fuso orario di Roma, così non torna sfasata in UTC.
      if (val instanceof Date && TEXT_COLS.indexOf(hdr[c]) >= 0) {
        var isTime = hdr[c].indexOf('ora') === 0;
        val = Utilities.formatDate(val, 'Europe/Rome', isTime ? 'HH:mm' : 'yyyy-MM-dd');
      }
      obj[hdr[c]] = val;
      if (val !== '' && val !== null) empty = false;
    }
    if (empty) continue;
    if (viaggioId && String(obj.viaggio_id) !== String(viaggioId)) continue;
    rows.push(obj);
  }
  return rows;
}

// Elenco filtrato in base al ruolo di chi chiede
function listFiltered(ctx, name, viaggioId) {
  if (name === 'Rubrica') { adminOnly(ctx); return listRows('Rubrica'); }
  if (name === 'Viaggi') {
    var rows = listRows('Viaggi');
    if (ctx.role === 'admin') return rows;
    return rows.filter(function (v) { return ctx.trips[String(v.id)] === true; }).map(stripCode);
  }
  guardTrip(ctx, viaggioId);
  return listRows(name, viaggioId);
}

// Ritorna tutti i tab collegati a un viaggio in una sola chiamata
function listAll(viaggioId, ctx) {
  if (ctx) guardTrip(ctx, viaggioId);
  var out = {};
  Object.keys(SCHEMA).forEach(function (name) {
    if (name === 'Rubrica') return;                 // mai dentro il payload di un viaggio
    if (name === 'Viaggi') {
      out.Viaggi = listRows('Viaggi').filter(function (v) {
        return !viaggioId || String(v.id) === String(viaggioId);
      });
      if (ctx && ctx.role !== 'admin') out.Viaggi = out.Viaggi.map(stripCode);
    } else {
      out[name] = listRows(name, viaggioId);
    }
  });
  return out;
}

// ---- SCRITTURE ----

// Converte un record nella riga (array) allineata agli header,
// con i valori già nel tipo giusto (Number per numeri, String per date/ore).
function toRowValues(hdr, record) {
  return hdr.map(function (h) {
    var v = (h in record && record[h] != null) ? record[h] : '';
    if (v === '') return '';
    if (NUM_COLS.indexOf(h) >= 0)  return Number(v);
    if (TEXT_COLS.indexOf(h) >= 0) return String(v);
    return v;
  });
}

// Applica i formati corretti a un blocco di righe appena scritte:
// numeri → 0.00, date/ore/codici → testo (@).
function applyFormats(sh, startRow, nRows, hdr) {
  if (nRows < 1) return;
  for (var c = 0; c < hdr.length; c++) {
    var name = hdr[c];
    var fmt = null;
    if (NUM_COLS.indexOf(name) >= 0)       fmt = '0.00';
    else if (TEXT_COLS.indexOf(name) >= 0) fmt = '@';
    if (fmt) sh.getRange(startRow, c + 1, nRows, 1).setNumberFormat(fmt);
  }
}

function createRow(name, record) {
  return createMany(name, [record])[0];
}

// Crea più righe in una volta con un UNICO setValues (batch).
function createMany(name, records) {
  records = records || [];
  if (!records.length) return [];
  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var clean = records.map(function (r) {
    r = sanitize(name, r);
    if (!r.id) r.id = genId();
    return r;
  });
  var startRow = sh.getLastRow() + 1;
  // IMPORTANTE: formatta PRIMA di scrivere, così Sheets non auto-converte
  // le stringhe data/ora in oggetti Date al momento dell'inserimento.
  applyFormats(sh, startRow, clean.length, hdr);
  var values = clean.map(function (r) { return toRowValues(hdr, r); });
  sh.getRange(startRow, 1, clean.length, hdr.length).setValues(values);
  return clean;
}

function updateRow(name, record) {
  record = sanitize(name, record);
  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var idCol = hdr.indexOf('id');
  if (idCol < 0) throw 'nessuna colonna id';
  var last = sh.getLastRow();
  var ids = sh.getRange(2, idCol + 1, Math.max(last - 1, 0), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(record.id)) {
      var rowNum = i + 2;
      var current = sh.getRange(rowNum, 1, 1, hdr.length).getValues()[0];
      applyFormats(sh, rowNum, 1, hdr);
      var updated = hdr.map(function (h, c) {
        if (!(h in record)) return current[c];
        var v = record[h];
        if (v === '' || v == null) return '';
        if (NUM_COLS.indexOf(h) >= 0)  return Number(v);
        if (TEXT_COLS.indexOf(h) >= 0) return String(v);
        return v;
      });
      sh.getRange(rowNum, 1, 1, hdr.length).setValues([updated]);
      return record;
    }
  }
  throw 'id non trovato: ' + record.id;
}

/**
 * Aggiorna PIU' righe con una sola lettura e una sola scrittura.
 * Serve alle operazioni in blocco (es. "pianifica tutte le idee"): farle
 * con N chiamate 'update' significa N invocazioni dello script, N lock e
 * N riletture del foglio, cioe' diversi secondi di attesa per l'utente.
 *
 * Come 'update', i campi assenti dal record restano quelli che c'erano.
 * viaggio_id non e' modificabile da qui: spostare una riga in un altro
 * viaggio aggirerebbe il controllo di accesso fatto sulla riga di partenza.
 */
function updateMany(name, records, ctx) {
  records = records || [];
  if (!records.length) return [];
  var sh  = getSheet(name);
  var hdr = headers(sh, name);
  var iId = hdr.indexOf('id');
  var iV  = hdr.indexOf('viaggio_id');
  if (iId < 0) throw 'nessuna colonna id';

  var last = sh.getLastRow();
  if (last < 2) return [];

  var wanted = {};
  records.forEach(function (r) {
    r = sanitize(name, r || {});
    if (r.id === '' || r.id == null) return;
    delete r.viaggio_id;
    wanted[String(r.id)] = r;
  });

  var values = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var first = -1, lastChanged = -1;
  var applied = [];

  for (var i = 0; i < values.length; i++) {
    var rec = wanted[String(values[i][iId])];
    if (!rec) continue;
    // stesso controllo di accesso di updateGuarded, ma sulla riga gia' letta
    if (ctx && ctx.role !== 'admin' && iV >= 0 && !allowTrip(ctx, values[i][iV])) continue;
    for (var c = 0; c < hdr.length; c++) {
      var h = hdr[c];
      if (!(h in rec)) continue;
      var v = rec[h];
      if (v === '' || v == null)          values[i][c] = '';
      else if (NUM_COLS.indexOf(h) >= 0)  values[i][c] = Number(v);
      else if (TEXT_COLS.indexOf(h) >= 0) values[i][c] = String(v);
      else                                values[i][c] = v;
    }
    if (first < 0) first = i;
    lastChanged = i;
    applied.push(rec);
  }
  if (first < 0) return [];

  // riscrivo solo il blocco che ho toccato, non tutto il foglio
  var nRows = lastChanged - first + 1;
  var block = values.slice(first, lastChanged + 1);
  applyFormats(sh, first + 2, nRows, hdr);
  sh.getRange(first + 2, 1, nRows, hdr.length).setValues(block);
  return applied;
}

function updateManyGuarded(ctx, name, records) {
  if (name === 'Rubrica' || name === 'Viaggi') adminOnly(ctx);
  return updateMany(name, records, ctx);
}

function deleteRow(name, id) {
  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var idCol = hdr.indexOf('id');
  var last = sh.getLastRow();
  var ids = sh.getRange(2, idCol + 1, Math.max(last - 1, 0), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) {
      sh.deleteRow(i + 2);
      return { id: id, deleted: true };
    }
  }
  throw 'id non trovato: ' + id;
}

// ---- SCRITTURE CON CONTROLLO DI ACCESSO ----

function createGuarded(ctx, name, record) {
  record = record || {};
  if (name === 'Rubrica') { adminOnly(ctx); return createRow(name, record); }
  if (name === 'Viaggi') {
    adminOnly(ctx);
    if (!String(record.codice == null ? '' : record.codice).trim()) record.codice = genCode();
    var createdTrip = createRow(name, record);
    bumpAuthNs();
    return createdTrip;
  }
  guardTrip(ctx, record.viaggio_id);
  return createRow(name, record);
}

function updateGuarded(ctx, name, record) {
  record = record || {};
  if (name === 'Rubrica') { adminOnly(ctx); return updateRow(name, record); }
  if (name === 'Viaggi') {
    guardTrip(ctx, record.id);
    // solo l'amministratore può cambiare il codice di accesso
    if (ctx.role !== 'admin' && 'codice' in record) delete record.codice;
    var updatedTrip = updateRow(name, record);
    bumpAuthNs();
    return updatedTrip;
  }
  guardRow(ctx, name, record.id);
  return updateRow(name, record);
}

function deleteGuarded(ctx, name, id) {
  if (name === 'Viaggi' || name === 'Rubrica') adminOnly(ctx);
  else guardRow(ctx, name, id);
  var res = deleteRow(name, id);
  if (name === 'Viaggi') bumpAuthNs();
  return res;
}

function createManyGuarded(ctx, name, records) {
  records = records || [];
  if (name === 'Rubrica') { adminOnly(ctx); return createMany(name, records); }
  if (name === 'Viaggi') { adminOnly(ctx); return createMany(name, records); }
  records.forEach(function (r) { guardTrip(ctx, r && r.viaggio_id); });
  return createMany(name, records);
}

/**
 * Elimina tutte le righe che appartengono a un gruppo OPPURE il cui id
 * compare nella lista passata.
 * La lista di id serve per le righe storiche con gruppo_id vuoto: senza
 * di essa un replace_group non troverebbe nulla da cancellare e
 * duplicherebbe le tratte.
 */
function deleteGroup(name, gruppoId, ids, ctx) {
  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var gCol = hdr.indexOf('gruppo_id');
  var iCol = hdr.indexOf('id');
  var vCol = hdr.indexOf('viaggio_id');
  var last = sh.getLastRow();
  if (last < 2) return { gruppo_id: gruppoId, deleted: 0 };

  var idSet = {};
  (ids || []).forEach(function (x) { if (x !== '' && x != null) idSet[String(x)] = true; });

  var vals = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var count = 0;
  for (var i = vals.length - 1; i >= 0; i--) {
    var g = gCol >= 0 ? String(vals[i][gCol]) : '';
    var rid = iCol >= 0 ? String(vals[i][iCol]) : '';
    var hit = (gruppoId && g !== '' && g === String(gruppoId)) || idSet[rid] === true;
    if (!hit) continue;
    // non si cancellano righe di viaggi non autorizzati
    if (ctx && ctx.role !== 'admin' && vCol >= 0 && !allowTrip(ctx, vals[i][vCol])) continue;
    sh.deleteRow(i + 2);
    count++;
  }
  return { gruppo_id: gruppoId, deleted: count };
}

// Sostituisce un intero gruppo: elimina le righe vecchie e reinserisce quelle nuove
function replaceGroup(name, gruppoId, records, ids, ctx) {
  deleteGroup(name, gruppoId, ids, ctx);
  return createMany(name, records);
}

function replaceGroupGuarded(ctx, name, gruppoId, records, ids) {
  (records || []).forEach(function (r) { guardTrip(ctx, r && r.viaggio_id); });
  return replaceGroup(name, gruppoId, records, ids, ctx);
}

/**
 * Spunta (o de-spunta) un'opzione di volo.
 * Con on=true tutte le altre opzioni dello stesso viaggio che coprono
 * almeno una delle stesse direzioni vengono deselezionate: così il
 * riepilogo non può mai contare due andate insieme.
 * Una sola lettura e una sola scrittura sulla colonna "scelto".
 */
function setScelta(viaggioId, gruppoId, on) {
  var sh = getSheet('Voli');
  var hdr = headers(sh, 'Voli');
  var last = sh.getLastRow();
  if (last < 2) return { changed: 0 };

  var iId = hdr.indexOf('id');
  var iG  = hdr.indexOf('gruppo_id');
  var iV  = hdr.indexOf('viaggio_id');
  var iD  = hdr.indexOf('direzione');
  var iS  = hdr.indexOf('scelto');
  if (iS < 0) throw 'colonna "scelto" mancante nel tab Voli';

  var vals = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var key = function (row) {
    var g = iG >= 0 ? String(row[iG]) : '';
    return g !== '' ? g : (iId >= 0 ? String(row[iId]) : '');
  };
  var sameTrip = function (row) {
    return (iV < 0) || !viaggioId || String(row[iV]) === String(viaggioId);
  };

  // direzioni coperte dal gruppo target
  var dirs = {};
  var r;
  for (r = 0; r < vals.length; r++) {
    if (key(vals[r]) === String(gruppoId) && sameTrip(vals[r])) dirs[dirKey(vals[r][iD])] = true;
  }

  var col = [];
  var changed = 0;
  for (r = 0; r < vals.length; r++) {
    var cur = vals[r][iS];
    var next = cur;
    if (key(vals[r]) === String(gruppoId) && sameTrip(vals[r])) {
      next = on ? 'Sì' : '';
    } else if (on && sameTrip(vals[r]) && dirs[dirKey(vals[r][iD])]) {
      next = '';
    }
    if (String(next) !== String(cur)) changed++;
    col.push([next]);
  }
  sh.getRange(2, iS + 1, col.length, 1).setValues(col);
  return { gruppo_id: gruppoId, on: !!on, changed: changed };
}

function setSceltaGuarded(ctx, viaggioId, gruppoId, on) {
  guardTrip(ctx, viaggioId);
  if (!viaggioId) throw 'viaggio_id mancante';
  return setScelta(viaggioId, gruppoId, on);
}

function dirKey(d) {
  return String(d || '').toLowerCase().indexOf('rit') === 0 ? 'R' : 'A';
}

/**
 * Aggiorna UNA sola colonna su più righe in un colpo solo.
 * values = [{id: '...', value: 'Sì'}, {id: '...', value: ''}, ...]
 * Serve per le spunte rapide (scelto, spuntato, confermata…) e per
 * l'esclusività degli alloggi: una lettura, una scrittura, niente
 * chiamate multiple dal client.
 */
function setFlags(name, field, values, ctx) {
  if (!SCHEMA[name]) throw 'sheet non valido: ' + name;
  if (SCHEMA[name].indexOf(field) < 0) throw 'colonna non valida: ' + field;
  if (ctx && GLOBAL_SHEETS.indexOf(name) >= 0) adminOnly(ctx);
  values = values || [];
  if (!values.length) return { changed: 0 };

  var sh = getSheet(name);
  var hdr = headers(sh, name);
  var iId = hdr.indexOf('id');
  var iF  = hdr.indexOf(field);
  var iV  = hdr.indexOf('viaggio_id');
  if (iId < 0 || iF < 0) throw 'colonne id/' + field + ' non trovate';

  var last = sh.getLastRow();
  if (last < 2) return { changed: 0 };

  var wanted = {};
  values.forEach(function (v) {
    if (v && v.id !== '' && v.id != null) wanted[String(v.id)] = (v.value == null ? '' : v.value);
  });

  var rows = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var out = [], changed = 0;
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i][iId]);
    var cur = rows[i][iF];
    var ok = Object.prototype.hasOwnProperty.call(wanted, k);
    if (ok && ctx && ctx.role !== 'admin' && iV >= 0 && !allowTrip(ctx, rows[i][iV])) ok = false;
    if (ok) {
      out.push([wanted[k]]);
      if (String(wanted[k]) !== String(cur)) changed++;
    } else {
      out.push([cur]);
    }
  }
  sh.getRange(2, iF + 1, out.length, 1).setValues(out);
  return { sheet: name, field: field, changed: changed };
}

/**
 * Unisce due opzioni in una sola: le righe del gruppo "source" passano
 * al gruppo "target" e ne ereditano il numero di opzione.
 * Nessuna riga viene eliminata o riscritta nei suoi dati di volo.
 */
function mergeGroups(targetId, sourceId, viaggioId) {
  if (!targetId || !sourceId) throw 'gruppi mancanti';
  var sh = getSheet('Voli');
  var hdr = headers(sh, 'Voli');
  var last = sh.getLastRow();
  if (last < 2) return { merged: 0 };

  var iId = hdr.indexOf('id');
  var iG  = hdr.indexOf('gruppo_id');
  var iO  = hdr.indexOf('opzione');
  var iV  = hdr.indexOf('viaggio_id');
  if (iG < 0) throw 'colonna gruppo_id mancante';

  var vals = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var key = function (row) {
    var g = String(row[iG]);
    return g !== '' ? g : (iId >= 0 ? String(row[iId]) : '');
  };
  var sameTrip = function (row) {
    return (iV < 0) || !viaggioId || String(row[iV]) === String(viaggioId);
  };

  // numero di opzione del target (se presente)
  var opz = '';
  var r;
  for (r = 0; r < vals.length; r++) {
    if (key(vals[r]) === String(targetId) && sameTrip(vals[r])) { opz = iO >= 0 ? vals[r][iO] : ''; break; }
  }

  var gcol = [], ocol = [], merged = 0;
  for (r = 0; r < vals.length; r++) {
    var k = key(vals[r]);
    if (sameTrip(vals[r]) && (k === String(sourceId) || k === String(targetId))) {
      gcol.push([String(targetId)]);
      ocol.push([opz === '' || opz == null ? '' : Number(opz)]);
      if (k === String(sourceId)) merged++;
    } else {
      gcol.push([vals[r][iG]]);
      ocol.push([iO >= 0 ? vals[r][iO] : '']);
    }
  }
  sh.getRange(2, iG + 1, gcol.length, 1).setValues(gcol);
  if (iO >= 0) sh.getRange(2, iO + 1, ocol.length, 1).setValues(ocol);
  return { gruppo_id: targetId, merged: merged };
}

function mergeGroupsGuarded(ctx, viaggioId, targetId, sourceId) {
  guardTrip(ctx, viaggioId);
  return mergeGroups(targetId, sourceId, viaggioId);
}

// Elimina un viaggio E tutte le righe collegate negli altri tab (a cascata).
function deleteTrip(viaggioId) {
  if (!viaggioId) throw 'id viaggio mancante';
  var report = {};
  Object.keys(SCHEMA).forEach(function (name) {
    if (GLOBAL_SHEETS.indexOf(name) >= 0) return;
    var sh = getSheet(name);
    var hdr = headers(sh, name);
    var vCol = hdr.indexOf('viaggio_id');
    if (vCol < 0) { report[name] = 0; return; }
    var last = sh.getLastRow();
    if (last < 2) { report[name] = 0; return; }
    var vals = sh.getRange(2, vCol + 1, last - 1, 1).getValues();
    var count = 0;
    for (var i = vals.length - 1; i >= 0; i--) {
      if (String(vals[i][0]) === String(viaggioId)) { sh.deleteRow(i + 2); count++; }
    }
    report[name] = count;
  });
  deleteRow('Viaggi', viaggioId);
  report.Viaggi = 1;
  bumpAuthNs();
  return { id: viaggioId, deleted: report };
}

// ---- BACKUP / RESTORE ----

// Esporta tutti i tab in un unico oggetto { tab: [righe...] }
function exportAll() {
  var out = { _meta: { exported_at: new Date().toISOString(), version: 4 } };
  Object.keys(SCHEMA).forEach(function (name) {
    out[name] = listRows(name);
  });
  return out;
}

// Ripristina i dati da un backup.
// mode 'replace' (default) svuota i tab e reinserisce; mode 'merge' aggiunge soltanto.
function importAll(payload, mode) {
  if (!payload) throw 'nessun payload';
  mode = mode || 'replace';
  var report = {};
  Object.keys(SCHEMA).forEach(function (name) {
    var rows = payload[name];
    var sh = getSheet(name);
    if (mode === 'replace') {
      var last = sh.getLastRow();
      if (last > 1) sh.deleteRows(2, last - 1);   // svuota mantenendo l'header
    }
    if (!rows || !rows.length) { report[name] = 0; return; }
    report[name] = createMany(name, rows).length;
  });
  bumpAuthNs();
  return report;
}

// ============================================================
//  UTIL
// ============================================================

function genId() {
  return Utilities.getUuid().slice(0, 8);
}

// Codice di accesso leggibile: niente 0/O/1/I per evitare equivoci a voce
function genCode() {
  var alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < 8; i++) s += alpha.charAt(Math.floor(Math.random() * alpha.length));
  return s;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ESEGUI UNA VOLTA dall'editor dopo aver aggiornato il codice.
 * Crea i tab mancanti e AGGIUNGE IN FONDO le colonne nuove.
 * Non riordina, non sovrascrive e non cancella nulla di esistente.
 */
/**
 * Svuota nel foglio le colonne di DROPPED_COLS (numeri di documento, codici
 * fiscali). Lascia le intestazioni al loro posto così nulla si sposta.
 * Va lanciata A MANO, una volta: non viene mai chiamata dall'app.
 */
function purgeDroppedColumns() {
  var report = [];
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss().getSheetByName(name);
    if (!sh) return;
    var lastCol = sh.getLastColumn(), lastRow = sh.getLastRow();
    if (lastCol < 1 || lastRow < 2) return;
    var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    DROPPED_COLS.forEach(function (col) {
      var i = hdr.indexOf(col);
      if (i < 0) return;
      sh.getRange(2, i + 1, lastRow - 1, 1).clearContent();
      report.push(name + '.' + col + ' (' + (lastRow - 1) + ' righe)');
    });
  });
  var msg = report.length ? 'svuotate: ' + report.join(' · ') : 'niente da svuotare';
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'TripHub · colonne sensibili', 10);
  return msg;
}

function setupSheets() {
  var added = [];
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = getSheet(name);
    var before = sh.getLastColumn();
    var hdr = headers(sh, name);          // headers() aggiunge da sé le colonne mancanti
    if (hdr.length > before && before > 0) {
      added.push(name + ': +' + (hdr.length - before) + ' colonne');
    }
    formatWholeColumns(sh, hdr);
    sh.setFrozenRows(1);
  });
  var msg = (added.length ? added.join(' · ') : 'nessuna colonna aggiunta')
          + ' · formati colonna applicati';
  SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'TripHub · schema aggiornato ✓', 10);
  return msg;
}

/**
 * Formatta l'INTERA colonna, non solo le righe già scritte.
 * Serve per chi incolla i dati a mano nel foglio: senza questo, un numero
 * come "+358 600 14000" finisce in una cella in formato "automatico" e
 * Sheets lo interpreta come formula (#ERROR!), mentre "0165..." perde lo zero.
 */
function formatWholeColumns(sh, hdr) {
  var last = sh.getMaxRows();
  if (last < 2) return;
  for (var c = 0; c < hdr.length; c++) {
    var name = hdr[c], fmt = null;
    if (NUM_COLS.indexOf(name) >= 0)       fmt = '0.00';
    else if (TEXT_COLS.indexOf(name) >= 0) fmt = '@';
    if (fmt) sh.getRange(2, c + 1, last - 1, 1).setNumberFormat(fmt);
  }
}

/**
 * Controlla che la riga 1 di ogni tab corrisponda allo schema.
 * Segnala colonne senza nome, doppioni e nomi sconosciuti: sono la causa
 * tipica dei dati incollati a mano che finiscono nella colonna sbagliata.
 * Esegui e leggi il risultato in Visualizza > Log di esecuzione.
 */
function verificaIntestazioni() {
  var out = [];
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = getSheet(name);
    var n = sh.getLastColumn();
    if (n < 1) return;
    var hdr = sh.getRange(1, 1, 1, n).getValues()[0].map(function (h) {
      return String(h == null ? '' : h).trim();
    });
    var problemi = [];
    var visti = {};
    for (var i = 0; i < hdr.length; i++) {
      var col = colonnaLettera(i + 1), h = hdr[i];
      if (!h) { problemi.push(col + ': intestazione VUOTA'); continue; }
      if (visti[h]) problemi.push(col + ': "' + h + '" duplicata (già in ' + visti[h] + ')');
      else visti[h] = col;
      if (SCHEMA[name].indexOf(h) < 0) problemi.push(col + ': "' + h + '" non è dello schema');
    }
    SCHEMA[name].forEach(function (want) {
      if (hdr.indexOf(want) < 0) problemi.push('manca la colonna "' + want + '"');
    });
    out.push(problemi.length
      ? '⚠️ ' + name + '\n   ' + problemi.join('\n   ')
      : '✓ ' + name + ' — ' + hdr.length + ' colonne, tutto in ordine');
  });
  var msg = out.join('\n');
  Logger.log(msg);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    out.filter(function (r) { return r.charAt(0) === '\u26a0'; }).length
      ? 'Trovati disallineamenti — vedi il Log' : 'Tutte le intestazioni sono corrette',
    'TripHub · verifica intestazioni', 10);
  return msg;
}

function colonnaLettera(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
}

/**
 * Utility comoda: assegna un codice di accesso a tutti i viaggi che non ce l'hanno
 * e ti stampa l'elenco nel Log (Visualizza > Log di esecuzione).
 */
function generaCodiciMancanti() {
  var sh = getSheet('Viaggi');
  var hdr = headers(sh, 'Viaggi');
  var iC = hdr.indexOf('codice');
  var iN = hdr.indexOf('destinazione');
  var last = sh.getLastRow();
  if (last < 2) return 'nessun viaggio';
  applyFormats(sh, 2, last - 1, hdr);
  var vals = sh.getRange(2, 1, last - 1, hdr.length).getValues();
  var col = [], out = [];
  for (var i = 0; i < vals.length; i++) {
    var c = String(vals[i][iC] == null ? '' : vals[i][iC]).trim();
    if (!c && String(vals[i][0]).trim()) c = genCode();
    col.push([c]);
    if (c) out.push((vals[i][iN] || '(senza nome)') + ' → ' + c);
  }
  sh.getRange(2, iC + 1, col.length, 1).setValues(col);
  Logger.log(out.join('\n'));
  return out.join('\n');
}


// ============================================================
//  PROMEMORIA SETTIMANALE VIA EMAIL
// ------------------------------------------------------------
//  Una volta a settimana, per ogni viaggio non ancora concluso, manda ai
//  partecipanti (e a chi possiede lo script) quello che manca: opzioni da
//  scegliere, cose da prenotare, documenti e pagamenti in scadenza, idee
//  senza data, e chi deve quanto a chi. Se non c'è niente da dire, tace.
//
//  Per attivarlo: esegui una volta installDigestTrigger() dall'editor.
//  Per vedere cosa manderebbe senza inviare nulla: previewDigest().
//
//  I conti sono un porting fedele di computeSettlement() del frontend:
//  stessi movimenti, stessa semplificazione, stessi numeri.
// ============================================================

var DIGEST_FUNC = 'sendWeeklyDigest';

function installDigestTrigger() {
  removeDigestTrigger();
  ScriptApp.newTrigger(DIGEST_FUNC).timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone('Europe/Rome').create();
  return 'promemoria attivo: ogni lunedì alle 8';
}
function removeDigestTrigger() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DIGEST_FUNC) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n ? 'rimossi ' + n + ' trigger' : 'nessun trigger da rimuovere';
}

/** Manda i promemoria. Torna un riassunto di cosa ha fatto. */
function sendWeeklyDigest() {
  var esito = [];
  dgTripsAttivi().forEach(function (trip) {
    var all = listAll(trip.id, null);
    var msg = dgBuild(trip, all);
    if (!msg) { esito.push(trip.destinazione + ': niente da segnalare'); return; }
    var to = dgRecipients(all);
    if (!to.length) { esito.push(trip.destinazione + ': nessun destinatario'); return; }
    MailApp.sendEmail({ to: to.join(','), subject: msg.subject, body: msg.text, htmlBody: msg.html, name: 'TripHub' });
    esito.push(trip.destinazione + ': inviato a ' + to.length);
  });
  var out = esito.length ? esito.join(' · ') : 'nessun viaggio in programma';
  Logger.log(out);
  return out;
}

/** Prova a secco: scrive nel log cosa manderebbe, senza inviare. */
function previewDigest() {
  var out = [];
  dgTripsAttivi().forEach(function (trip) {
    var msg = dgBuild(trip, listAll(trip.id, null));
    out.push('=== ' + trip.destinazione + ' → ' + (msg ? dgRecipients(listAll(trip.id, null)).join(', ') || '(nessun destinatario)' : 'niente da dire'));
    if (msg) out.push(msg.text);
  });
  var txt = out.join('\n') || 'nessun viaggio in programma';
  Logger.log(txt);
  return txt;
}

// ---- selezione viaggi e destinatari ----
function dgTripsAttivi() {
  var oggi = dgToday();
  return listRows('Viaggi').filter(function (v) {
    if (/annull/i.test(String(v.stato || ''))) return false;
    var a = dgIso(v.data_inizio), b = dgIso(v.data_fine);
    if (b) return b >= oggi;
    return a ? a >= oggi : false;
  });
}
function dgRecipients(all) {
  var seen = {}, out = [];
  var add = function (e) {
    e = String(e || '').trim().toLowerCase();
    if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !seen[e]) { seen[e] = true; out.push(e); }
  };
  (all.Partecipanti || []).forEach(function (p) { add(p.email); });
  try { add(Session.getEffectiveUser().getEmail()); } catch (ignore) {}
  return out;
}

// ---- il contenuto ----
function dgBuild(trip, all) {
  var oggi = dgToday();
  var inizio = dgIso(trip.data_inizio), fine = dgIso(trip.data_fine);
  var giorni = inizio ? dgDays(oggi, inizio) : null;
  var nome = trip.destinazione || trip.nome || 'Viaggio';
  var voci = dgChecklist(trip, all, oggi);
  var conti = dgConti(all);

  var vicino = giorni !== null && giorni >= 0 && giorni <= 14;
  var soldi = conti && (conti.trasferimenti.length > 0 || conti.daPagare > 0.005);
  if (!voci.length && !vicino && !soldi) return null;

  var quando = giorni === null ? ''
    : giorni < 0 ? 'in viaggio' + (fine ? ', rientro il ' + dgIt(fine) : '')
    : giorni === 0 ? 'si parte oggi'
    : giorni === 1 ? 'si parte domani'
    : 'mancano ' + giorni + ' giorni';

  var T = [], H = [];
  var h = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  T.push(nome + (quando ? ' — ' + quando : ''));
  H.push('<h2 style="margin:0 0 4px;font-size:20px">' + h(nome) + '</h2>');
  if (quando) H.push('<div style="color:#7a6f5a;margin-bottom:14px">' + h(quando) + '</div>');

  if (voci.length) {
    T.push(''); T.push('Da fare:');
    H.push('<h3 style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#d1622a;margin:16px 0 6px">Da fare</h3><ul style="padding-left:18px;margin:0">');
    voci.forEach(function (v) {
      T.push((v.grave ? '! ' : '- ') + v.testo);
      H.push('<li style="margin:3px 0' + (v.grave ? ';font-weight:600' : '') + '">' + h(v.testo) + '</li>');
    });
    H.push('</ul>');
  }

  if (conti) {
    T.push(''); T.push('Soldi: costa ' + dgEur(conti.costo) + ' · usciti ' + dgEur(conti.uscito) + ' · da pagare ' + dgEur(conti.daPagare));
    H.push('<h3 style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#d1622a;margin:16px 0 6px">Soldi</h3>');
    H.push('<div>Il viaggio costa <b>' + dgEur(conti.costo) + '</b> · già usciti ' + dgEur(conti.uscito) + ' · ancora da pagare <b>' + dgEur(conti.daPagare) + '</b></div>');
    if (conti.trasferimenti.length) {
      T.push('Per pareggiare:');
      H.push('<div style="margin-top:6px">Per pareggiare:</div><ul style="padding-left:18px;margin:0">');
      conti.trasferimenti.forEach(function (t) {
        T.push('- ' + t.da + ' → ' + t.a + ': ' + dgEur(t.importo));
        H.push('<li>' + h(t.da) + ' → ' + h(t.a) + ': <b>' + dgEur(t.importo) + '</b></li>');
      });
      H.push('</ul>');
    } else if (conti.uscito > 0.005) {
      T.push('Siete in pari.');
      H.push('<div style="color:#3f7d5c">Siete in pari ✓</div>');
    }
  }

  T.push(''); T.push('— TripHub, promemoria automatico del lunedì');
  var html = '<div style="font-family:system-ui,sans-serif;max-width:560px;color:#17324d;background:#f2ede1;padding:20px;border-radius:12px">'
    + H.join('') + '<div style="margin-top:18px;font-size:11px;color:#7a6f5a">TripHub · promemoria automatico del lunedì</div></div>';

  return { subject: '✈️ ' + nome + (quando ? ' · ' + quando : ''), text: T.join('\n'), html: html };
}

/** Le stesse voci del riquadro "Prima di partire" dell'app. */
function dgChecklist(trip, all, oggi) {
  var out = [];
  var add = function (grave, testo) { out.push({ grave: grave, testo: testo }); };
  var fine = dgIso(trip.data_fine);

  var g = dgGroups(all.Voli || []);
  var keys = Object.keys(g);
  if (keys.length && !keys.some(function (k) { return dgChosen(g[k]); }))
    add(true, keys.length + ' opzion' + (keys.length === 1 ? 'e' : 'i') + ' di volo, nessuna scelta');
  var alg = all.Alloggi || [];
  if (alg.length && !alg.some(function (a) { return dgTruthy(a.scelto); }))
    add(true, alg.length + ' opzion' + (alg.length === 1 ? 'e' : 'i') + ' di alloggio, nessuna scelta');

  var daPren = (all.CoseDaFare || []).filter(function (r) { return dgTruthy(r.prenotazione_req) && !dgTruthy(r.confermata); });
  if (daPren.length)
    add(true, daPren.length + ' attività da prenotare: ' + daPren.slice(0, 4).map(function (r) { return r.attivita; }).filter(Boolean).join(', ') + (daPren.length > 4 ? '…' : ''));

  var scad = (all.Partecipanti || []).filter(function (p) { var s = dgIso(p.scadenza_doc); return s && fine && s < fine; });
  if (scad.length)
    add(true, 'documento in scadenza prima del rientro: ' + scad.map(dgName).join(', '));

  var scadenze = [];
  alg.filter(function (a) { return dgTruthy(a.scelto) && dgIso(a.scadenza_pag); })
    .forEach(function (a) { scadenze.push({ nome: a.struttura || 'Alloggio', quando: dgIso(a.scadenza_pag) }); });
  keys.filter(function (k) { return dgChosen(g[k]) && dgIso(g[k][0].scadenza_pag); })
    .forEach(function (k) { scadenze.push({ nome: 'Volo ' + dgRoute(g[k]), quando: dgIso(g[k][0].scadenza_pag) }); });
  scadenze.sort(function (a, b) { return a.quando < b.quando ? -1 : 1; }).forEach(function (x) {
    var d = dgDays(oggi, x.quando);
    if (d < 0) add(true, x.nome + ': il pagamento era da fare entro il ' + dgIt(x.quando));
    else if (d <= 30) add(d <= 7, x.nome + ': da pagare entro il ' + dgIt(x.quando) + ' (' + (d === 0 ? 'oggi' : d + ' giorni') + ')');
  });

  var idee = (all.CoseDaFare || []).filter(function (r) { return !dgIso(r.data); }).length;
  if (idee) add(false, idee + ' ide' + (idee === 1 ? 'a' : 'e') + ' ancora senza data');

  return out;
}

// ---- porting dei conti (deve dare gli stessi numeri del frontend) ----
function dgConti(all) {
  var nomi = dgPeople(all);
  if (!nomi.length) return null;
  var bal = {}; nomi.forEach(function (n) { bal[n] = 0; });
  var uscito = 0, ignoti = [];

  dgMovimenti(all).forEach(function (m) {
    if (!m.valido) { [m.chi, m.verso].forEach(function (n) { if (n && nomi.indexOf(n) < 0 && ignoti.indexOf(n) < 0) ignoti.push(n); }); return; }
    if (m.tipo === 'rimborso') { bal[m.chi] += m.importo; bal[m.verso] -= m.importo; return; }
    bal[m.chi] += m.importo;
    uscito += m.importo;
    var fra = dgPayers(m.paganti, nomi).filter(function (n) { return n in bal; });
    var set = fra.length ? fra : nomi;
    var q = m.importo / set.length;
    set.forEach(function (n) { bal[n] -= q; });
  });

  var righe = nomi.map(function (n) { return { nome: n, saldo: dgRound2(bal[n]) }; });
  var costo = 0;
  (all.Alloggi || []).forEach(function (a) { if (dgTruthy(a.scelto)) costo += dgNum(a.totale); });
  (all.Voli || []).forEach(function (v) { if (dgTruthy(v.scelto)) costo += dgNum(v.totale) + dgNum(v.costo_bagaglio); });
  (all.Spese || []).forEach(function (x) { costo += dgNum(x.totale); });

  return {
    righe: righe, ignoti: ignoti,
    trasferimenti: dgSimplify(righe),
    costo: dgRound2(costo), uscito: dgRound2(uscito),
    daPagare: dgRound2(Math.max(0, costo - uscito))
  };
}

function dgMovimenti(all) {
  var nomi = dgPeople(all);
  var noto = function (n) { return nomi.indexOf(String(n || '').trim()) >= 0; };
  var out = [];
  (all.Spese || []).forEach(function (x) {
    var q = dgNum(x.totale), chi = String(x.pagato_da || '').trim();
    if (!q || !chi) return;
    out.push({ tipo: 'anticipo', chi: chi, verso: '', importo: q, valido: noto(chi), paganti: x.paganti || '' });
  });
  (all.Pagamenti || []).forEach(function (p) {
    var q = dgNum(p.importo);
    if (!q) return;
    var tipo = String(p.tipo || '').toLowerCase() === 'rimborso' ? 'rimborso' : 'anticipo';
    var chi = String(p.chi || '').trim(), verso = String(p.verso || '').trim();
    out.push({ tipo: tipo, chi: chi, verso: verso, importo: q, paganti: p.paganti || '',
      valido: noto(chi) && (tipo === 'anticipo' || noto(verso)) });
  });
  (all.Alloggi || []).forEach(function (a) {
    var chi = String(a.pagato_da || '').trim(), q = dgNum(a.totale);
    if (dgTruthy(a.scelto) && chi && q) out.push({ tipo: 'anticipo', chi: chi, verso: '', importo: q, valido: noto(chi), paganti: '' });
  });
  (all.Voli || []).forEach(function (v) {
    var chi = String(v.pagato_da || '').trim(), q = dgNum(v.totale) + dgNum(v.costo_bagaglio);
    if (dgTruthy(v.scelto) && chi && q) out.push({ tipo: 'anticipo', chi: chi, verso: '', importo: q, valido: noto(chi), paganti: v.paganti || '' });
  });
  return out;
}

function dgSimplify(righe) {
  var eps = 0.005;
  var cred = righe.filter(function (r) { return r.saldo > eps; }).map(function (r) { return { nome: r.nome, v: r.saldo }; });
  var debt = righe.filter(function (r) { return r.saldo < -eps; }).map(function (r) { return { nome: r.nome, v: -r.saldo }; });
  var bySize = function (a, b) { return (b.v - a.v) || a.nome.localeCompare(b.nome, 'it'); };
  cred.sort(bySize); debt.sort(bySize);
  var out = [], i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    var q = Math.min(debt[i].v, cred[j].v);
    if (q > eps) out.push({ da: debt[i].nome, a: cred[j].nome, importo: dgRound2(q) });
    debt[i].v -= q; cred[j].v -= q;
    if (debt[i].v <= eps) i++;
    if (cred[j].v <= eps) j++;
  }
  return out;
}

// ---- piccoli helper, stessi criteri del frontend ----
function dgTruthy(v) { var s = String(v == null ? '' : v).toLowerCase().trim(); return ['sì', 'si', 'true', '1', 'x', 'yes', '✓'].indexOf(s) >= 0; }
function dgNum(v) { return Number(String(v == null ? '' : v).replace(/[^\d.-]/g, '')) || 0; }
function dgRound2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function dgEur(n) { return '€ ' + (Number(n) || 0).toFixed(2).replace('.', ','); }
function dgName(p) { return [p.nome, p.cognome].filter(Boolean).join(' ').trim() || '(senza nome)'; }
function dgPeople(all) {
  return (all.Partecipanti || []).map(dgName).sort(function (a, b) { return a.localeCompare(b, 'it'); });
}
function dgPayers(paganti, nomi) {
  var s = String(paganti || '').trim();
  if (!s || s.toLowerCase() === 'tutti') return nomi.slice();
  return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
}
function dgGroups(voli) {
  var g = {};
  voli.forEach(function (r) { var k = r.gruppo_id || r.id; (g[k] = g[k] || []).push(r); });
  Object.keys(g).forEach(function (k) {
    g[k].sort(function (a, b) {
      var d = (dgRit(a) ? 1 : 0) - (dgRit(b) ? 1 : 0);
      return d || dgNum(a.tratta) - dgNum(b.tratta);
    });
  });
  return g;
}
function dgRit(r) { return String(r.direzione || '').toLowerCase().indexOf('rit') === 0; }
function dgChosen(legs) { return legs.some(function (l) { return dgTruthy(l.scelto); }); }
function dgRoute(legs) {
  var iata = function (v) { var m = String(v || '').trim().toUpperCase().match(/^([A-Z]{3})\b/); return m ? m[1] : String(v || ''); };
  return legs.map(function (l) { return iata(l.da); }).concat(iata(legs[legs.length - 1].a)).join(' → ');
}
function dgIso(raw) {
  if (!raw) return '';
  if (raw instanceof Date) return Utilities.formatDate(raw, 'Europe/Rome', 'yyyy-MM-dd');
  var s = String(raw).trim(), m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[1] + '-' + m[2] + '-' + m[3];
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) {
    var y = m[3]; if (y.length === 2) y = '20' + y;
    return y + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  }
  return '';
}
function dgIt(iso) { var p = String(iso).split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0].slice(2) : iso; }
function dgToday() { return Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd'); }
function dgDays(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
