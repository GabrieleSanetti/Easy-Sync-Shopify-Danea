/**
 * Dati in arrivo da Danea: dal corpo della richiesta agli articoli abbinati ai
 * prodotti Shopify.
 *
 * CONTESTO MACCHINA (per iterazioni IA future):
 * Modulo puro, senza Electron né rete: lo prova tools/test-danea-input.js. Sta in un
 * file core-*.js (patchabile) perché le regole di abbinamento cambiano con il catalogo.
 *
 * Corpo: decodificato come faceva express.text (prima del passaggio a node:http):
 * gzip/deflate decompressi, testo nel charset dichiarato dal Content-Type (utf-8 se
 * manca); se Danea manda un multipart si tiene solo l'XML.
 *
 * Abbinamento, in ordine: SKU normalizzato (solo lettere e cifre, minuscolo) → campo
 * Link di Danea (= handle Shopify) → titolo trasformato in handle. Gli SKU che su
 * Shopify diventano uguali dopo la normalizzazione ("AN-01" e "AN01") sono ambigui:
 * non si abbinano per SKU (prima vinceva l'ultimo e Danea aggiornava il prodotto
 * sbagliato), si passa a Link e titolo e il caso finisce nello storico.
 *
 * Qui sta anche nextPageInfo (paginazione REST di Shopify), perché è logica pura da
 * testare e un file nuovo non potrebbe viaggiare con una patch.
 */

const zlib = require('zlib');
const crypto = require('crypto');

// Confronto a tempo costante: si confrontano gli sha256 (stessa lunghezza) con
// timingSafeEqual, così il tempo di risposta non rivela quanti caratteri sono giusti.
function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Credenziali del server Danea: header Basic (quello che usa Danea per gli invii,
 * verificato il 13/11) oppure ?user=&pwd= nell'URL, tenuto per compatibilità con lo
 * scarico ordini; se ci sono entrambi vince l'header. Senza credenziali nelle
 * impostazioni il server è aperto: ascolta solo su 127.0.0.1.
 */
function checkDaneaAuth(authorization, searchParams, settings) {
  const expectedUser = settings?.daneaServerUsername || '';
  const expectedPassword = settings?.daneaServerPassword || '';
  if (!expectedUser && !expectedPassword) return true;

  let user = searchParams.get('user') || '';
  let password = searchParams.get('pwd') || '';
  if (authorization && authorization.startsWith('Basic ')) {
    const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    // Solo il primo ":" separa utente e password: la password può contenerne altri.
    user = colon >= 0 ? decoded.slice(0, colon) : decoded;
    password = colon >= 0 ? decoded.slice(colon + 1) : '';
  }
  const userOk = sameSecret(user, expectedUser);
  const passwordOk = sameSecret(password, expectedPassword);
  return userOk && passwordOk;
}

// Errore con lo stato HTTP da restituire a Danea.
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function decodeRequestBody(buffer, headers = {}) {
  const encoding = String(headers['content-encoding'] || 'identity').toLowerCase();
  let data = buffer;
  if (encoding === 'gzip') data = zlib.gunzipSync(buffer);
  else if (encoding === 'deflate') data = zlib.inflateSync(buffer);
  else if (encoding !== 'identity') throw httpError(415, `Codifica non supportata: ${encoding}`);

  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(String(headers['content-type'] || ''));
  const charset = match ? match[1] : 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch (e) {
    throw httpError(415, `Charset non supportato: ${charset}`);
  }
  return decoder.decode(data);
}

// Se Danea invia come multipart form-data, si tolgono i separatori e resta solo l'XML.
function extractXml(text) {
  if (!text.includes('---')) return text;
  const start = text.indexOf('<?xml') !== -1 ? text.indexOf('<?xml') : text.indexOf('<Easyfatt');
  return start === -1 ? text : text.substring(start, text.lastIndexOf('>') + 1);
}

// Articoli dall'XML già letto (xml2js, explicitArray: false); null se manca l'elenco.
function daneaProductsFrom(parsed) {
  const data = parsed?.EasyfattProducts?.UpdatedProducts?.Product
    || parsed?.EasyfattProducts?.Products?.Product
    || parsed?.EasyfattDocuments?.Products?.Product;
  if (!data) return null;
  return Array.isArray(data) ? data : [data];
}

function normalizeSku(sku) {
  return String(sku || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

// Titolo Danea → handle Shopify (accenti tolti, spazi in trattini).
function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Mappe del catalogo Shopify per SKU normalizzato e per handle.
 * ambiguous: SKU normalizzato → SKU Shopify in conflitto (tolti da mapBySku).
 */
function buildShopifyMaps(products) {
  const mapBySku = {};
  const mapByHandle = {};
  const ambiguous = {};

  for (const p of products || []) {
    if (!p.variants || p.variants.length === 0) continue;
    // Il cliente non usa vere varianti per le giacenze: la prima variante è il prodotto.
    // Per i prezzi servono tutte, perché le varianti esistono solo su Shopify
    // (vedi decidePriceUpdate in core-prices-rules.js).
    const v = p.variants[0];
    const sku = v.sku || '';
    const itemData = {
      qty: v.inventory_quantity, itemId: v.inventory_item_id, sku, handle: p.handle,
      productId: p.id || v.product_id,
      variants: p.variants.map(pv => ({ id: pv.id, price: pv.price, compareAtPrice: pv.compare_at_price }))
    };

    const key = normalizeSku(sku);
    if (key) {
      if (ambiguous[key]) {
        ambiguous[key].push(sku);
      } else if (mapBySku[key] && mapBySku[key].productId !== itemData.productId) {
        ambiguous[key] = [mapBySku[key].sku, sku];
        delete mapBySku[key];
      } else {
        mapBySku[key] = itemData;
      }
    }
    if (p.handle) mapByHandle[p.handle] = itemData;
  }
  return { mapBySku, mapByHandle, ambiguous };
}

// Danea manda solo i prodotti web con "Aggiorna E-commerce": il tag Web può mancare.
function isWebProduct(p) {
  return p.Web === undefined || p.Web === 'True' || p.Web === 'true';
}

// Campo Link di Danea, ignorando i valori spazzatura ("Sì", vuoto).
function daneaLink(p) {
  if (typeof p.Link !== 'string') return null;
  const link = p.Link.trim().toLowerCase();
  return link && link !== 'sì' && link !== 'si' ? link : null;
}

/**
 * Abbina gli articoli Danea (già letti dall'XML) al catalogo Shopify.
 * Ritorna { matched, unmatched, ambiguousHits }: matched ha un solo articolo per
 * prodotto Shopify; ambiguousHits elenca gli articoli il cui SKU è ambiguo su Shopify.
 */
function matchDaneaProducts(products, maps) {
  const syncDataMap = new Map();
  const unmatched = [];
  const ambiguousHits = [];

  for (const p of products.filter(isWebProduct)) {
    const sku = p.Code || '';
    const key = normalizeSku(sku);
    const link = daneaLink(p);
    const slug = slugify(p.Description);

    let shopifyData = null;
    let matchType = 'Nessuno';
    if (key && maps.ambiguous && maps.ambiguous[key]) {
      ambiguousHits.push({ sku, title: p.Description, shopifySkus: maps.ambiguous[key] });
    }
    if (key && maps.mapBySku[key]) {
      shopifyData = maps.mapBySku[key];
      matchType = 'SKU';
    } else if (link && maps.mapByHandle[link]) {
      shopifyData = maps.mapByHandle[link];
      matchType = 'Link Manuale';
    } else if (slug && maps.mapByHandle[slug]) {
      shopifyData = maps.mapByHandle[slug];
      matchType = 'Titolo';
    }

    const newQty = parseInt(p.AvailableQty || p.Qty || 0, 10);
    const currentItem = {
      sku,
      title: p.Description,
      newQty,
      oldQty: shopifyData ? shopifyData.qty : null,
      itemId: shopifyData ? shopifyData.itemId : null,
      changed: shopifyData ? shopifyData.qty !== newQty : true,
      matchType,
      originalShopifySku: shopifyData ? shopifyData.sku : null,
      // Per la sync prezzi: il prezzo si sceglie dopo, quando si sa se lo store è IVA inclusa
      daneaProduct: p,
      handle: shopifyData ? shopifyData.handle : null,
      productId: shopifyData ? shopifyData.productId : null,
      variants: shopifyData ? shopifyData.variants : []
    };

    if (!shopifyData) {
      unmatched.push(currentItem);
      continue;
    }

    // Più articoli Danea sullo stesso prodotto Shopify: vince lo SKU identico, altrimenti
    // (nessuno o entrambi identici) chi ha quantità > 0 su chi ha 0.
    const itemId = shopifyData.itemId;
    const existing = syncDataMap.get(itemId);
    if (!existing) {
      syncDataMap.set(itemId, currentItem);
      continue;
    }
    const currentIsExact = currentItem.sku === currentItem.originalShopifySku;
    const existingIsExact = existing.sku === existing.originalShopifySku;
    if (currentIsExact && !existingIsExact) {
      syncDataMap.set(itemId, currentItem);
    } else if (currentIsExact === existingIsExact && currentItem.newQty > 0 && existing.newQty === 0) {
      syncDataMap.set(itemId, currentItem);
    }
  }

  return { matched: Array.from(syncDataMap.values()), unmatched, ambiguousHits };
}

// Cursore della pagina successiva nell'header Link delle API REST di Shopify:
// <https://…?limit=250&page_info=abc>; rel="previous", <https://…&page_info=def>; rel="next"
// Ritorna "def", oppure null sull'ultima pagina.
function nextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const next = String(linkHeader).split(',').find((part) => /rel="?next"?/.test(part));
  const match = next && next.match(/[?&]page_info=([^>&]+)/);
  return match ? match[1] : null;
}

module.exports = {
  checkDaneaAuth, httpError, decodeRequestBody, extractXml, daneaProductsFrom,
  normalizeSku, slugify, buildShopifyMaps, matchDaneaProducts, nextPageInfo
};
