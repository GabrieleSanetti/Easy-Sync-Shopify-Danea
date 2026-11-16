/**
 * Server locale per Danea (127.0.0.1:3000): POST /danea-sync riceve giacenze e prezzi,
 * GET /danea-orders restituisce gli ordini Shopify in XML.
 *
 * CONTESTO MACCHINA (per iterazioni IA future):
 * node:http al posto di Express (due percorsi, nessun middleware). Si mantiene quello
 * che faceva Express e su cui Danea può contare: percorsi senza distinzione tra
 * maiuscole e minuscole, "/" finale tollerata, corpo fino a 50 MB decodificato come
 * express.text (vedi decodeRequestBody in core-danea-input.js).
 */
const { app } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { xml2js, readSettings, shared } = require('./core-env.js');
const { shopifyContext, getShopifyInventoryMap, syncQuantitiesToShopify } = require('./core-shopify.js');
const { syncPricesToShopify } = require('./core-prices.js');
const { recordDaneaSync } = require('./core-history.js');
const {
  checkDaneaAuth, httpError, decodeRequestBody, extractXml, daneaProductsFrom, matchDaneaProducts
} = require('./core-danea-input.js');
const { generateDaneaOrdersXml, SequenceNotInitializedError } = require('./core-orders.js');

const DANEA_PORT = 3000;
const MAX_BODY_BYTES = 50 * 1024 * 1024;

let daneaServer = null;

function send(res, status, text, contentType = 'text/plain; charset=utf-8', headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': contentType, ...headers });
  res.end(text);
}

function unauthorized(res) {
  send(res, 401, 'Unauthorized', undefined, { 'WWW-Authenticate': 'Basic realm="Danea Sync"' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => (size > MAX_BODY_BYTES
      ? reject(httpError(413, 'Richiesta troppo grande (max 50 MB).'))
      : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function debugLogPath() {
  return path.join(app.getPath('userData'), 'danea_debug.log');
}

const MAX_LOG_BYTES = 1024 * 1024;

// Una riga per richiesta (e per errore), in coda; oltre 1 MB il file riparte da zero.
// Mai intestazioni né corpo: contengono la password del server Danea e il listino.
function logLine(text) {
  const file = debugLogPath();
  try {
    const full = fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES;
    fs[full ? 'writeFileSync' : 'appendFileSync'](file, `${new Date().toISOString()} ${text}\n`);
  } catch (e) {
    console.error('[DANEA] log non scritto:', e.message);
  }
}

function credentialsSource(req, url) {
  if (req.headers.authorization) return 'credenziali nell\'header';
  return url.searchParams.has('pwd') ? 'credenziali nell\'URL' : 'senza credenziali';
}

// Danea manda ogni invio prima senza credenziali e, ricevuto il 401, lo ripete con
// l'header Basic (osservato il 16/11/2026): quel primo 401 è normale.
function unauthorizedReason(req, url) {
  return credentialsSource(req, url) === 'senza credenziali'
    ? 'richiesta senza credenziali (normale: Danea la ripete subito con la password)'
    : 'utente o password del server Danea non corrispondono alle impostazioni';
}

async function handleDaneaSync(req, res, url, win) {
  // Il corpo si legge tutto PRIMA di controllare le credenziali, come faceva Express
  // (express.text girava prima della rotta). Con la 1.0.5, che rispondeva 401 appena
  // arrivate le intestazioni, Danea dava "Socket Error # 10053" a ogni invio (16/11/2026),
  // mentre la 1.0.3 con Express riceveva regolarmente.
  const body = await readBody(req);
  logLine(`POST /danea-sync, ${body.length} byte, ${credentialsSource(req, url)}`);

  const settings = readSettings();
  if (!checkDaneaAuth(req.headers.authorization, url.searchParams, settings)) {
    logLine(`  → 401: ${unauthorizedReason(req, url)}`);
    return unauthorized(res);
  }

  const xmlContent = extractXml(decodeRequestBody(body, req.headers));
  const logError = (msg) => {
    logLine(`  → 500: ${msg}`);
    send(res, 500, msg);
  };

  const parsed = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(xmlContent);
  const products = daneaProductsFrom(parsed);
  if (!products) {
    logLine('  → 400: XML senza elenco prodotti');
    return send(res, 400, 'Invalid XML structure: missing Products.');
  }

  let ctx;
  try {
    ctx = await shopifyContext(settings);
  } catch (e) {
    return logError(e.message);
  }
  const { token } = ctx;

  let shopifyMaps;
  try {
    shopifyMaps = await getShopifyInventoryMap(settings.shopifyStoreUrl, token);
  } catch (fetchError) {
    return logError('Errore critico Shopify: ' + fetchError.message);
  }

  const { matched, unmatched, ambiguousHits } = matchDaneaProducts(products, shopifyMaps);
  const toUpdate = matched.concat(unmatched).filter(p => p.itemId && p.changed);

  let qtyCount = 0;
  let qtyFailed = [];
  if (toUpdate.length > 0) {
    const result = await syncQuantitiesToShopify(toUpdate, ctx);
    qtyCount = result.count;
    qtyFailed = result.failed;
  }

  // Danea riceve la risposta appena le giacenze sono a posto. I prezzi vengono dopo:
  // al primo invio possono essere centinaia e Danea resterebbe in attesa fino al timeout.
  send(res, 200, 'OK');
  logLine(`  → 200: ${products.length} prodotti ricevuti, ${qtyCount} giacenze aggiornate, ${qtyFailed.length} rifiutate da Shopify`);

  // Stessa data per la voce di storico e per la memoria delle variazioni da confermare.
  const syncDate = new Date().toISOString();
  let priceReport = null;
  if (settings.daneaPriceSyncEnabled) {
    try {
      priceReport = await syncPricesToShopify(matched, settings, token, syncDate);
    } catch (e) {
      console.error('Errore sync prezzi', e);
      priceReport = { error: e.message, updated: [], suspicious: [], onSale: [], failed: [], skipped: {} };
    }
  }

  recordDaneaSync(win, toUpdate, qtyCount, priceReport, syncDate, { qtyFailed, ambiguousSkus: ambiguousHits });
}

async function handleDaneaOrders(req, res, url) {
  logLine(`GET /danea-orders, ${credentialsSource(req, url)}`);
  if (!checkDaneaAuth(req.headers.authorization, url.searchParams, readSettings())) {
    logLine(`  → 401: ${unauthorizedReason(req, url)}`);
    return unauthorized(res);
  }
  const tray = shared.tray;
  try {
    const result = await generateDaneaOrdersXml(null, true);
    logLine(`  → 200: ${result.count || 0} ordini`);
    if (tray) {
      tray.displayBalloon({
        title: 'Scaricamento Ordini Danea',
        content: `Scaricati ${result.count || 0} nuovi ordini da Shopify.`,
        iconType: 'info'
      });
    }
    send(res, 200, result.xml, 'text/xml; charset=utf-8');
  } catch (error) {
    console.error(error);
    logLine(`  → 500: ${error.message}`);
    // Danea mostra solo un errore generico: la causa la diciamo dalla tray.
    if (tray && error instanceof SequenceNotInitializedError) {
      tray.displayBalloon({ title: 'Ordini non scaricati', content: error.message, iconType: 'warning' });
    }
    send(res, 500, 'Error processing orders: ' + error.message);
  }
}

async function handleRequest(req, res, win) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = `${req.method} ${url.pathname.toLowerCase().replace(/\/+$/, '')}`;
  if (route === 'POST /danea-sync') return handleDaneaSync(req, res, url, win);
  if (route === 'GET /danea-orders') return handleDaneaOrders(req, res, url);
  logLine(`${req.method} ${url.pathname} → 404`);
  send(res, 404, 'Not Found');
}

function startDaneaServer(win) {
  daneaServer = http.createServer((req, res) => {
    // Connessione chiusa dall'altra parte prima che arrivasse la risposta (es. timeout di Danea).
    res.on('close', () => {
      if (!res.writableFinished) logLine(`  ! ${req.method} ${req.url.split('?')[0]}: connessione chiusa prima della risposta`);
    });
    handleRequest(req, res, win).catch((error) => {
      console.error(error);
      logLine(`  → ${error.status || 500}: ${error.message}`);
      send(res, error.status || 500, error.message);
    });
  });

  // Richiesta che il parser HTTP di Node rifiuta: senza questo gestore la connessione
  // si chiude senza lasciare traccia. Non si registra err.rawPacket: contiene le intestazioni.
  daneaServer.on('clientError', (err, socket) => {
    logLine(`richiesta rifiutata dal parser HTTP: ${err.code || ''} ${err.message}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  // Porta occupata da un altro programma: prima il server non partiva e il log diceva
  // comunque "listening". Ora l'utente lo vede nella tray.
  daneaServer.on('error', (error) => {
    const message = error.code === 'EADDRINUSE'
      ? `La porta ${DANEA_PORT} è già usata da un altro programma: Danea non può inviare giacenze né scaricare ordini.`
      : `Server per Danea non avviato: ${error.message}`;
    console.error('[DANEA]', message);
    if (shared.tray) shared.tray.displayBalloon({ title: 'Server Danea non attivo', content: message, iconType: 'error' });
  });

  daneaServer.listen(DANEA_PORT, '127.0.0.1', () => {
    console.log(`Danea local server listening on http://127.0.0.1:${DANEA_PORT}/danea-sync`);
  });
}

module.exports = { startDaneaServer };
