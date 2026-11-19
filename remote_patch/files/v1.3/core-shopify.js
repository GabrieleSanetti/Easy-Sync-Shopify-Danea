/**
 * Accesso a Shopify: token, mappa dell'inventario, limiti di richiesta (429 /
 * THROTTLED) e invio delle giacenze.
 */
const { axios, readSettings } = require('./core-env.js');
const { buildShopifyMaps } = require('./core-danea-input.js');

async function getShopifyAccessToken(storeUrl, clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  const cleanId = clientId.trim();
  const cleanSecret = clientSecret.trim();
  const cleanUrl = storeUrl.replace('https://', '').replace(/\/$/, '').trim();
  const tokenUrl = `https://${cleanUrl}/admin/oauth/access_token`;
  
  try {
    const params = new URLSearchParams();
    params.append('client_id', cleanId);
    params.append('client_secret', cleanSecret);
    params.append('grant_type', 'client_credentials');
    // Chiediamo esplicitamente i permessi di lettura prodotti e ordini
    params.append('scope', 'read_inventory,write_inventory,read_products,write_products,read_orders,write_orders');
    
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    return response.data.access_token;
  } catch (error) {
    console.error('Error fetching Shopify access token:', error.response?.data || error.message);
    let errMsg = error.response?.data?.error_description || error.response?.data?.error || error.message;
    throw new Error('Impossibile ottenere il token: ' + errMsg);
  }
}

// Impostazioni, token e URL dello store: gli stessi controlli servono a ordini,
// giacenze, prezzi e server Danea, quindi stanno in un posto solo. Errore chiaro se
// manca qualcosa. Chi ha già letto le impostazioni (il server Danea) le passa.
async function shopifyContext(settings = readSettings()) {
  if (!settings || !settings.shopifyStoreUrl) {
    throw new Error('URL Store Shopify mancante. Compila le Impostazioni API nell\'app.');
  }
  let token = settings.shopifyApiToken;
  if (!token && settings.shopifyClientId && settings.shopifyClientSecret) {
    try {
      token = await getShopifyAccessToken(settings.shopifyStoreUrl, settings.shopifyClientId, settings.shopifyClientSecret);
    } catch (e) {
      throw new Error('Credenziali Shopify errate (Client ID / Secret). Dettagli: ' + e.message);
    }
  }
  if (!token) throw new Error('Token Shopify mancante. Compila le Impostazioni API nell\'app.');
  return { settings, token, cleanUrl: settings.shopifyStoreUrl.replace('https://', '').replace(/\/$/, '') };
}

async function getShopifyInventoryMap(storeUrl, token) {
  let allProducts = [];
  let hasNext = true;
  let pageInfo = '';
  const cleanUrl = storeUrl.replace('https://', '').replace(/\/$/, '');
  // Aggiunto status=active per escludere le bozze
  const pageParams = 'limit=250&fields=id,handle,variants';
  const baseUrl = `https://${cleanUrl}/admin/api/2024-01/products.json?${pageParams}&status=active`;

  try {
    while (hasNext) {
      // Con page_info Shopify accetta solo limit e fields (status resta quello della prima
      // pagina). Senza di essi le pagine successive erano da 50 prodotti con tutti i campi.
      const url = pageInfo ? `https://${cleanUrl}/admin/api/2024-01/products.json?${pageParams}&page_info=${pageInfo}` : baseUrl;
      const response = await shopifyCall(() => axios.get(url, { headers: { 'X-Shopify-Access-Token': token } }));
      await pauseIfRestBucketFull(response);
      allProducts = allProducts.concat(response.data.products);
      
      const linkHeader = response.headers.link;
      if (linkHeader && linkHeader.includes('rel="next"')) {
        const match = linkHeader.match(/page_info=([^>;&]+)>; rel="next"/);
        if (match) pageInfo = match[1];
        else hasNext = false;
      } else {
        hasNext = false;
      }
    }
  } catch (err) {
    console.error('Shopify fetch error:', err.message);
    if (err.response && err.response.status === 403) {
      throw new Error('Errore 403: Manca il permesso "read_products" nelle impostazioni dell\'App Shopify.');
    }
    throw new Error('Errore di comunicazione con Shopify: ' + err.message);
  }
  
  return buildShopifyMaps(allProducts);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Shopify limita le richieste (REST: secchio da 40, 2/s; GraphQL: a punti). Su 429 o
// THROTTLED si aspetta e si riprova, invece di interrompere a metà la sincronizzazione.
async function shopifyCall(fn, attempts = 5) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fn();
    } catch (err) {
      if (err.response && err.response.status === 429 && i < attempts) {
        const wait = parseFloat(err.response.headers?.['retry-after']) || i;
        await sleep(wait * 1000);
        continue;
      }
      throw err;
    }
    const throttled = Array.isArray(res?.data?.errors) && res.data.errors.some(e => e?.extensions?.code === 'THROTTLED');
    if (!throttled) return res;
    if (i >= attempts) throw new Error('Shopify: limite di richieste superato (THROTTLED)');
    await sleep(1000 * i);
  }
}

// Rallenta prima di riempire il secchio REST ("32/40" nell'header), così i 429 restano l'eccezione.
async function pauseIfRestBucketFull(res) {
  const header = res?.headers?.['x-shopify-shop-api-call-limit'];
  if (!header) return;
  const [used, max] = String(header).split('/').map(Number);
  if (used >= max - 5) await sleep(1000);
}

// Messaggio leggibile da un errore di Shopify: il motivo vero sta in response.data.errors.
function shopifyErrorMessage(e) {
  const errors = e.response && e.response.data && e.response.data.errors;
  if (!errors) return e.message;
  return typeof errors === 'string' ? errors : JSON.stringify(errors);
}

// Un prodotto rifiutato da Shopify (es. 422: giacenze non tracciate o articolo non
// presente in quella sede) non deve fermare gli altri: prima il ciclo si interrompeva
// e, a ogni invio, i prodotti successivi e i prezzi restavano fermi. L'errore si annota
// e si continua. Credenziali o permessi sbagliati (401/403) valgono per tutti: stop.
async function syncQuantitiesToShopify(productsToUpdate, ctx = null) {
  const { settings, token, cleanUrl } = ctx || await shopifyContext();
  let successCount = 0;
  const failed = [];

  for (const prod of productsToUpdate) {
    if (!prod.itemId) continue;
    try {
      const res = await shopifyCall(() => axios.post(`https://${cleanUrl}/admin/api/2024-01/inventory_levels/set.json`, {
        location_id: settings.shopifyLocationId || '',
        inventory_item_id: prod.itemId,
        available: prod.newQty
      }, {
        headers: { 'X-Shopify-Access-Token': token }
      }));
      await pauseIfRestBucketFull(res);
      successCount++;
    } catch (e) {
      const status = e.response && e.response.status;
      if (status === 401 || status === 403) throw e;
      failed.push({
        itemId: prod.itemId, sku: prod.sku, title: prod.title, oldQty: prod.oldQty, newQty: prod.newQty,
        error: shopifyErrorMessage(e)
      });
    }
  }

  return { success: true, count: successCount, failed };
}

module.exports = {
  getShopifyAccessToken, shopifyContext, getShopifyInventoryMap, sleep, shopifyCall, pauseIfRestBucketFull,
  shopifyErrorMessage, syncQuantitiesToShopify
};
