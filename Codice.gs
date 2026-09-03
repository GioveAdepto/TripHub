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
  Partecipanti:['id','viaggio_id','nome','cognome','data_nascita','luogo_nascita','tipo_doc','num_doc','scadenza_doc','nazionalita','cod_fiscale','telefono','email','note'],
  Alloggi:     ['id','viaggio_id','struttura','checkin','ora_checkin','checkout','ora_checkout','notti','persone','prezzo_notte','extra','totale','prezzo_testa','prezzo_testa_notte','link','indirizzo','posizione','valutazione','scelto','note','mappa_link','pnr'],
  Voli:        ['id','viaggio_id','gruppo_id','opzione','direzione','tratta','persone','paganti','compagnia','n_volo','da','a','data_part','ora_part','data_arr','ora_arr','scalo','totale','prezzo_testa','bagaglio','scelto','note','costo_bagaglio','pnr'],
  Spese:       ['id','viaggio_id','data','descrizione','categoria','paganti','persone','totale','prezzo_testa','note'],
  CoseDaFare:  ['id','viaggio_id','data','ora','tipo','attivita','posizione','durata','persone','costo','prezzo_testa','prenotazione_req','quando','link','note','confermata'],
  CosaPortare: ['id','viaggio_id','categoria','cosa','qta','chi','spuntato','priorita','note'],
  Contatti:    ['id','viaggio_id','categoria','nome','telefono','link','indirizzo','note','email','mappa_link'],
  InfoDest:    ['id','viaggio_id','sezione','chiave','valore','link'],
  // Anagrafica globale, NON legata a un viaggio: solo l'amministratore la vede.
  Rubrica:     ['id','nome','cognome','data_nascita','luogo_nascita','tipo_doc','num_doc','scadenza_doc','nazionalita','cod_fiscale','telefono','email','note']
};

// Tab che non hanno (e non devono avere) una colonna viaggio_id
const GLOBAL_SHEETS = ['Viaggi','Rubrica'];

// Colonne che devono restare NUMERO puro (evita auto-conversione in data/ora da parte di Sheets)
const NUM_COLS = ['totale','prezzo_notte','prezzo_testa','prezzo_testa_notte','extra','costo','notti','persone','qta','valutazione','n_persone','tratta','opzione','costo_bagaglio'];

// Colonne che devono restare TESTO esatto (date, ore, codici alfanumerici):
// mai oggetti Date né numeri, altrimenti Sheets sfasa il giorno o mangia gli zeri iniziali.
const TEXT_COLS = ['data_inizio','data_fine','checkin','checkout','data_part','data_arr','ora_part','ora_arr','data','ora','data_nascita','scadenza_doc','ora_checkin','ora_checkout','codice','pnr',
                   // numeri di telefono e documenti: il "+" iniziale verrebbe letto come formula,
                   // e gli zeri iniziali (0165..., 00358...) verrebbero mangiati.
                   'telefono','num_doc','cod_fiscale','n_volo'];

// Azioni che modificano i dati (protette da LockService)
const WRITE_ACTIONS = ['create','update','delete','create_many','delete_group','replace_group',
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
function authContext(token) {
  token = String(token == null ? '' : token).trim();
  if (!token) return null;

  var master = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (master && token === String(master).trim()) return { role: 'admin', trips: null };

  // codice di viaggio: confronto senza distinzione fra maiuscole e minuscole
  var wanted = token.toLowerCase();
  var trips = {};
  var found = 0;
  listRows('Viaggi').forEach(function (v) {
    var c = String(v.codice == null ? '' : v.codice).trim().toLowerCase();
    if (c && c === wanted) { trips[String(v.id)] = true; found++; }
  });
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
    return createRow(name, record);
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
    return updateRow(name, record);
  }
  guardRow(ctx, name, record.id);
  return updateRow(name, record);
}

function deleteGuarded(ctx, name, id) {
  if (name === 'Viaggi' || name === 'Rubrica') adminOnly(ctx);
  else guardRow(ctx, name, id);
  return deleteRow(name, id);
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