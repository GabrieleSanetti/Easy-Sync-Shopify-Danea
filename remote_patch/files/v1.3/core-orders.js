/**
 * Ordini Shopify verso Danea: anteprima, XML nella serie /W, tag "Scaricato_Danea".
 */
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { axios, LIB_DIR, resolvePatchableModule, userDataPath, patchDir } = require('./core-env.js');
const { shopifyContext, shopifyCall, pauseIfRestBucketFull, shopifyErrorMessage } = require('./core-shopify.js');
const { nextPageInfo } = require('./core-danea-input.js');

// Il tracciato verso Danea è logica applicativa, non sicurezza: può arrivare da una
// patch firmata, così una correzione al formato dell'XML non impone di reinstallare
// l'app su tutte le postazioni. Se la patch non è verificata si usa quello del bundle.
const { buildDocumentsXml, isOrderToExport, tagsWithExported } = require(resolvePatchableModule(patchDir, LIB_DIR, 'danea-order-xml.js', app.getVersion()));

// Numerazione degli ordini nella serie /W di Danea: la decide EasySync, perché
// Danea usa sempre il numero scritto nell'XML. Stato in un file proprio, non in
// settings.json (vedi lib/danea-order-sequence.js).
const { createOrderSequence, SequenceNotInitializedError } = require(path.join(LIB_DIR, 'danea-order-sequence.js'));
const orderSequence = createOrderSequence(path.join(userDataPath, 'danea-order-sequence.json'));

// Oltre questo numero di pagine (25.000 ordini) ci si ferma: un cursore che non
// avanza non deve tenere il server Danea in un ciclo infinito di chiamate.
const MAX_ORDER_PAGES = 100;

// Ordini da scaricare in Danea (né già scaricati né annullati, vedi isOrderToExport):
// base comune di anteprima, XML e tag. Si leggono TUTTE le pagine da 250: il filtro
// sui tag si fa qui, quindi prima, con una sola pagina, oltre 250 ordini (già
// scaricati compresi) i più vecchi non arrivavano mai a Danea. Con page_info Shopify
// accetta solo limit e fields: status=any resta quello della prima pagina.
// Senza il permesso read_all_orders Shopify restituisce solo gli ultimi 60 giorni.
async function fetchUnexportedOrders({ token, cleanUrl }) {
  const base = `https://${cleanUrl}/admin/api/2024-01/orders.json`;
  const headers = { 'X-Shopify-Access-Token': token };
  const orders = [];
  let url = `${base}?status=any&limit=250`;
  for (let page = 1; url; page++) {
    if (page > MAX_ORDER_PAGES) throw new Error(`Ordini Shopify: più di ${MAX_ORDER_PAGES} pagine, lettura interrotta.`);
    const response = await shopifyCall(() => axios.get(url, { headers }));
    await pauseIfRestBucketFull(response);
    orders.push(...(response.data.orders || []));
    const next = nextPageInfo(response.headers && response.headers.link);
    url = next ? `${base}?limit=250&page_info=${next}` : null;
  }
  return orders.filter(isOrderToExport);
}

async function fetchNewOrdersForPreview() {
  const newOrders = await fetchUnexportedOrders(await shopifyContext());
  return newOrders.map(o => {
    const ba = o.billing_address || {};
    const c = o.customer || {};
    return {
      id: o.id.toString(),
      order_number: o.order_number,
      created_at: o.created_at.substring(0,10),
      customer: ba.name || (ba.first_name + ' ' + ba.last_name) || c.first_name + ' ' + c.last_name || 'Cliente',
      total_price: o.total_price
    };
  });
}

// Tag "Scaricato_Danea" uno alla volta, ritentando sui 429. Prima partivano tutti
// insieme senza attendere la risposta: oltre il limite di Shopify fallivano in
// silenzio. Un ordine rifiutato non ferma gli altri; 401/403 (credenziali o
// permessi) valgono per tutti: errore.
async function tagOrders(ctx, orders) {
  const failed = [];
  let tagged = 0;
  for (const o of orders) {
    try {
      const res = await shopifyCall(() => axios.put(`https://${ctx.cleanUrl}/admin/api/2024-01/orders/${o.id}.json`, {
        order: { id: o.id, tags: tagsWithExported(o) }
      }, { headers: { 'X-Shopify-Access-Token': ctx.token } }));
      await pauseIfRestBucketFull(res);
      tagged++;
    } catch (e) {
      const status = e.response && e.response.status;
      if (status === 401 || status === 403) throw new Error(`Shopify ha rifiutato il tag (${status}): ${shopifyErrorMessage(e)}`);
      failed.push({ id: String(o.id), orderNumber: o.order_number, error: shopifyErrorMessage(e) });
    }
  }
  return { tagged, failed };
}

// Ritorna l'XML e tagExported(), che mette i tag: chi chiama decide QUANDO (il
// server Danea solo dopo aver consegnato l'XML, vedi core-danea-server.js).
async function generateDaneaOrdersXml(selectedIds = null) {
  const ctx = await shopifyContext();
  let newOrders = await fetchUnexportedOrders(ctx);
  if (selectedIds) {
    newOrders = newOrders.filter(o => selectedIds.includes(o.id.toString()));
  }

  // I numeri vengono salvati prima di costruire l'XML: un ordine riesportato
  // riceve lo stesso numero e Danea lo blocca come duplicato.
  const numbers = orderSequence.assignNumbers(newOrders);
  const finalXml = buildDocumentsXml(newOrders, { numberFor: (o) => numbers.get(String(o.id)) });

  return { xml: finalXml, count: newOrders.length, tagExported: () => tagOrders(ctx, newOrders) };
}

async function tagOrdersOnShopify(selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return { success: true, count: 0, failed: [] };

  const ctx = await shopifyContext();
  const toTag = (await fetchUnexportedOrders(ctx)).filter(o => selectedIds.includes(o.id.toString()));
  const { tagged, failed } = await tagOrders(ctx, toTag);
  return { success: true, count: tagged, failed };
}

ipcMain.handle('shopify:fetch-new-orders', async () => {
  try {
    const orders = await fetchNewOrdersForPreview();
    return { success: true, orders };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('shopify:export-orders', async (event, selectedIds) => {
  try {
    const result = await generateDaneaOrdersXml(selectedIds);
    if (result.count === 0) {
      return { success: false, message: 'Nessun ordine selezionato o trovato.' };
    }
    
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Salva Ordini Danea XML',
      defaultPath: `Ordini_Shopify_${new Date().toISOString().split('T')[0]}.xml`,
      filters: [{ name: 'XML', extensions: ['xml'] }]
    });
    
    if (!canceled && filePath) {
      fs.writeFileSync(filePath, result.xml, 'utf8');
      return { success: true, count: result.count, path: filePath };
    }
    return { success: false, message: 'Salvataggio annullato dall\'utente.' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('danea:get-order-sequence', async () => {
  try {
    return { success: true, data: orderSequence.getState() };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('danea:set-order-sequence', async (event, lastNumber) => {
  try {
    return { success: true, data: orderSequence.setLastNumber(lastNumber) };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('shopify:tag-orders', async (event, selectedIds) => {
  try {
    return await tagOrdersOnShopify(selectedIds);
  } catch (error) {
    return { success: false, message: error.message };
  }
});

module.exports = { generateDaneaOrdersXml, SequenceNotInitializedError };
