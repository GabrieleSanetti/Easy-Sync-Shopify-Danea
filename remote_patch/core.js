const { app, BrowserWindow, ipcMain, dialog, Notification, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Permette a core.js hot-patchato (eseguito da APPDATA) di trovare i pacchetti originali
module.paths.push(path.join(app.getAppPath(), 'node_modules'));

const ExcelJS = require('exceljs');
const Papa = require('papaparse');
const express = require('express');
const xml2js = require('xml2js');
const axios = require('axios');
const { autoUpdater } = require('electron-updater');

// Patch vars
const userDataPath = app.getPath('userData');
const patchDir = global.PATCH_DIR || path.join(userDataPath, 'patch');

let mainWindow;

let tray = null;

function createWindow() {
  const isHidden = process.argv.includes('--hidden');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    show: !isHidden, // Mostra solo se non avviato con --hidden
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.myshopify.com https://*.shopify.com https://raw.githubusercontent.com;"
        ]
      }
    });
  });

  const patchedHtml = path.join(patchDir, 'index.html');
  if (fs.existsSync(patchedHtml)) {
    mainWindow.loadFile(patchedHtml);
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'index.html'));
  }
  
  // Gestiamo la chiusura della finestra in modo che vada solo in background
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  setupAutoUpdater(mainWindow);
  
  return mainWindow;
}

// Disabilita accelerazione hardware e Vulkan per evitare warning su Linux Wayland
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-vulkan');

let expressServer = null;

app.whenReady().then(() => {
  // Imposta l'avvio automatico all'accensione del PC in background
  app.setLoginItemSettings({
    openAtLogin: true,
    args: ['--hidden']
  });

  mainWindow = createWindow();

  // Creazione icona nella System Tray
  const iconPath = path.join(app.getAppPath(), 'build', 'icon.png');
  if (fs.existsSync(iconPath)) {
    tray = new Tray(iconPath);
  } else {
    // Fallback se l'icona build/icon.png non esiste
    console.warn('Icona non trovata in ' + iconPath);
  }

  if (tray) {
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Apri EasySync', click: () => { mainWindow.show(); } },
      { type: 'separator' },
      { label: 'Esci', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip('Easy-Sync Shopify-Danea');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    });
  }

  if (app.isPackaged) {
    setupAutoUpdater(mainWindow);
  }

  startExpressServer(mainWindow);

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    else mainWindow.show();
  });
});

function setupAutoUpdater(win) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  
  autoUpdater.on('update-available', (info) => {
    win.webContents.send('update:available', info);
  });
  autoUpdater.on('update-downloaded', () => {
    win.webContents.send('update:downloaded');
  });
  autoUpdater.checkForUpdatesAndNotify();
}

ipcMain.on('update:check', () => {
  autoUpdater.checkForUpdates();
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall();
});

// === HOT PATCH LOGIC ===
ipcMain.handle('patch:check', async () => {
  try {
    const patchUrl = 'https://raw.githubusercontent.com/GabrieleSanetti/Easy-Sync-Shopify-Danea/main/remote_patch/patch.json';
    const response = await axios.get(`${patchUrl}?t=${Date.now()}`); // bypass cache
    const remotePatch = response.data;
    
    if (!remotePatch || !remotePatch.version) return { success: false, message: 'Nessuna patch trovata sul server.' };
    
    const localVersionPath = path.join(patchDir, 'patch_version.json');
    let localVersion = 0;
    if (fs.existsSync(localVersionPath)) {
      localVersion = JSON.parse(fs.readFileSync(localVersionPath, 'utf8')).version || 0;
    }
    
    if (remotePatch.version <= localVersion) {
      return { success: false, message: 'Sei già aggiornato all\'ultima patch disponibile.' };
    }
    
    if (!fs.existsSync(patchDir)) fs.mkdirSync(patchDir, { recursive: true });
    
    // Download all files specified in patch.json
    for (const [filename, fileUrl] of Object.entries(remotePatch.files)) {
      const fileRes = await axios.get(`${fileUrl}?t=${Date.now()}`, { responseType: 'text' });
      fs.writeFileSync(path.join(patchDir, filename), fileRes.data, 'utf8');
    }
    
    fs.writeFileSync(localVersionPath, JSON.stringify({ version: remotePatch.version }));
    
    return { success: true, message: 'Patch installata con successo!' };
  } catch (error) {
    return { success: false, message: `Errore durante il download della patch: ${error.message}` };
  }
});

ipcMain.handle('patch:rollback', async () => {
  try {
    if (fs.existsSync(patchDir)) {
      fs.rmSync(patchDir, { recursive: true, force: true });
    }
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

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

async function getShopifyInventoryMap(storeUrl, token) {
  let allProducts = [];
  let hasNext = true;
  let pageInfo = '';
  const cleanUrl = storeUrl.replace('https://', '').replace(/\/$/, '');
  // Aggiunto status=active per escludere le bozze
  const baseUrl = `https://${cleanUrl}/admin/api/2024-01/products.json?limit=250&status=active&fields=handle,variants`;
  
  try {
    while (hasNext) {
      // Quando si usa page_info con Shopify, NON si possono inviare altri parametri (come status o campi)
      const url = pageInfo ? `https://${cleanUrl}/admin/api/2024-01/products.json?page_info=${pageInfo}` : baseUrl;
      const response = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token } });
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
  
  const mapBySku = {};
  const mapByHandle = {};
  
  allProducts.forEach(p => {
    const handle = p.handle;
    if (p.variants && p.variants.length > 0) {
      // In questo caso il cliente non usa vere varianti con taglie/colori su Shopify per lo stesso prodotto,
      // quindi consideriamo la prima variante come il prodotto stesso.
      const v = p.variants[0]; 
      const sku = v.sku || '';
      const normalizedSku = sku.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      
      const itemData = { qty: v.inventory_quantity, itemId: v.inventory_item_id, sku: sku, handle: handle };
      
      if (normalizedSku) mapBySku[normalizedSku] = itemData;
      if (handle) mapByHandle[handle] = itemData;
    }
  });
  
  return { mapBySku, mapByHandle };
}

ipcMain.handle('export-not-found-csv', async (event, data) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Esporta SKU non trovati in CSV',
      defaultPath: `SKU_Non_Trovati_${new Date().toISOString().split('T')[0]}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });
    
    if (canceled || !filePath) return { success: false, canceled: true };
    
    const headers = "SKU,Titolo Danea,Quantita\\r\\n";
    const rows = data.map(p => {
      const sku = (p.sku || '').replace(/"/g, '""');
      const title = (p.title || '').replace(/"/g, '""');
      const qty = p.newQty || 0;
      return `"${sku}","${title}",${qty}`;
    }).join("\\r\\n");
    
    // Aggiungi il BOM per preservare i caratteri speciali
    fs.writeFileSync(filePath, headers + rows, 'utf8');
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

async function syncQuantitiesToShopify(productsToUpdate) {
  const settingsPath = getSettingsPath();
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const storeUrl = settings?.shopifyStoreUrl;
  
  let token = settings?.shopifyApiToken;
  const clientId = settings?.shopifyClientId;
  const clientSecret = settings?.shopifyClientSecret;
  
  if (!storeUrl) throw new Error('Configura l\'URL dello store Shopify nelle Impostazioni');
  if (!token && (!clientId || !clientSecret)) {
    throw new Error('Configura le credenziali Shopify (Client ID e Secret) nelle Impostazioni');
  }
  
  if (!token && clientId && clientSecret) {
    token = await getShopifyAccessToken(storeUrl, clientId, clientSecret);
  }
  
  const cleanUrl = storeUrl.replace('https://', '').replace(/\/$/, '');
  let successCount = 0;
  
  for (const prod of productsToUpdate) {
    if (!prod.itemId) continue;
    
    await axios.post(`https://${cleanUrl}/admin/api/2024-01/inventory_levels/set.json`, {
      location_id: settings.shopifyLocationId || '', 
      inventory_item_id: prod.itemId,
      available: prod.newQty
    }, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    successCount++;
  }
  
  return { success: true, count: successCount };
}

ipcMain.handle('shopify:sync-quantities', async (event, productsToUpdate) => {
  try {
    return await syncQuantitiesToShopify(productsToUpdate);
  } catch (error) {
    return { success: false, message: error.message };
  }
});

function startExpressServer(win) {
  const server = express();
  server.use(express.text({ type: ['text/xml', 'application/xml', '*/*'], limit: '50mb' }));

  server.post('/danea-sync', async (req, res) => {
    try {
      const settingsPath = getSettingsPath();
      let settings = null;
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      
      const serverUsername = settings?.daneaServerUsername || '';
      const serverPassword = settings?.daneaServerPassword || '';
      
      let providedUsername = req.query.user || '';
      let providedPassword = req.query.pwd || '';

      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Basic ')) {
        const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
        const [u, p] = auth.split(':');
        providedUsername = u || '';
        providedPassword = p || '';
      }
      
      if (serverPassword || serverUsername) {
        if (providedPassword !== serverPassword || providedUsername !== serverUsername) {
          res.set('WWW-Authenticate', 'Basic realm="Danea Sync"');
          return res.status(401).send('Unauthorized');
        }
      }

      let xmlContent = req.body;
      
      // DEBUGLOG: salviamo il contenuto della richiesta per capire cosa arriva
      const logPath = path.join(app.getPath('userData'), 'danea_debug.log');
      fs.writeFileSync(logPath, `HEADERS:\n${JSON.stringify(req.headers, null, 2)}\n\nBODY:\n${xmlContent}\n`);

      // Se Danea invia come multipart form-data, puliamo i boundary e prendiamo solo l'XML
      if (typeof xmlContent === 'string' && xmlContent.includes('---')) {
        const xmlStart = xmlContent.indexOf('<?xml') !== -1 ? xmlContent.indexOf('<?xml') : xmlContent.indexOf('<Easyfatt');
        if (xmlStart !== -1) {
          const xmlEnd = xmlContent.lastIndexOf('>');
          xmlContent = xmlContent.substring(xmlStart, xmlEnd + 1);
        }
      }

      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(xmlContent);
      
      const productsData = result.EasyfattProducts?.UpdatedProducts?.Product 
                        || result.EasyfattProducts?.Products?.Product 
                        || result.EasyfattDocuments?.Products?.Product;
      if (!productsData) {
        return res.status(400).send('Invalid XML structure: missing Products.');
      }
      
      const products = Array.isArray(productsData) ? productsData : [productsData];
      
      // Danea invia solo i prodotti web con "Aggiorna E-commerce", quindi il tag Web potrebbe non esserci.
      const webProducts = products.filter(p => p.Web === undefined || p.Web === 'True' || p.Web === 'true');
      
      // Fetch Shopify Inventory if API configured
      let shopifyMaps = { mapBySku: {}, mapByHandle: {} };
      
      const logError = (msg) => {
        const logPath = path.join(app.getPath('userData'), 'danea_debug.log');
        fs.appendFileSync(logPath, `\n\nERRORE API:\n${msg}\n`);
        return res.status(500).send(msg);
      };

      if (!settings?.shopifyStoreUrl) {
        return logError('URL Store Shopify mancante. Compila le Impostazioni API nell\'app.');
      }
      
      let token = settings?.shopifyApiToken;
      if (!token && settings?.shopifyClientId && settings?.shopifyClientSecret) {
        try {
          token = await getShopifyAccessToken(settings.shopifyStoreUrl, settings.shopifyClientId, settings.shopifyClientSecret);
        } catch (e) {
          console.error('Failed to get token for preview:', e.message);
          return logError('Credenziali Shopify errate (Client ID / Secret). Impossibile ottenere il token. Dettagli: ' + e.message);
        }
      }
      
      if (!token) {
        return logError('Token Shopify mancante. Compila le Impostazioni API nell\'app.');
      }
      
      try {
        shopifyMaps = await getShopifyInventoryMap(settings.shopifyStoreUrl, token);
      } catch (fetchError) {
        return logError('Errore critico Shopify: ' + fetchError.message);
      }
      
      const syncDataMap = new Map();
      const unmatchedProducts = [];

      webProducts.forEach(p => {
        const sku = p.Code || '';
        const normalizedDaneaSku = sku.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        
        // Estrazione Link Danea ignorando valori spazzatura
        const daneaLink = typeof p.Link === 'string' && p.Link.toLowerCase() !== 'sì' && p.Link.toLowerCase() !== 'si' && p.Link.trim() !== '' ? p.Link.trim().toLowerCase() : null;
        
        // Slugification del titolo
        let slug = (p.Description || '').toLowerCase();
        slug = slug.replace(/[àáâãäå]/g, "a")
                   .replace(/[èéêë]/g, "e")
                   .replace(/[ìíîï]/g, "i")
                   .replace(/[òóôõö]/g, "o")
                   .replace(/[ùúûü]/g, "u")
                   .replace(/[^a-z0-9\s-]/g, "") 
                   .trim()
                   .replace(/\s+/g, "-");
                   
        let shopifyData = null;
        let matchType = 'Nessuno';
        
        // LIVELLO 1: SKU Normalizzato
        if (normalizedDaneaSku && shopifyMaps.mapBySku[normalizedDaneaSku]) {
          shopifyData = shopifyMaps.mapBySku[normalizedDaneaSku];
          matchType = 'SKU';
        } 
        // LIVELLO 2: Campo Link Custom (Handle)
        else if (daneaLink && shopifyMaps.mapByHandle[daneaLink]) {
          shopifyData = shopifyMaps.mapByHandle[daneaLink];
          matchType = 'Link Manuale';
        } 
        // LIVELLO 3: Titolo Slugificato
        else if (slug && shopifyMaps.mapByHandle[slug]) {
          shopifyData = shopifyMaps.mapByHandle[slug];
          matchType = 'Titolo';
        }
        
        const newQty = parseInt(p.AvailableQty || p.Qty || 0, 10);
        
        const currentItem = {
          sku: sku,
          title: p.Description,
          newQty: newQty,
          oldQty: shopifyData ? shopifyData.qty : null,
          itemId: shopifyData ? shopifyData.itemId : null,
          changed: shopifyData ? shopifyData.qty !== newQty : true,
          matchType: matchType,
          originalShopifySku: shopifyData ? shopifyData.sku : null
        };

        if (shopifyData) {
          const itemId = shopifyData.itemId;
          if (syncDataMap.has(itemId)) {
            const existingItem = syncDataMap.get(itemId);
            const currentIsExact = currentItem.sku === currentItem.originalShopifySku;
            const existingIsExact = existingItem.sku === existingItem.originalShopifySku;
            
            if (currentIsExact && !existingIsExact) {
               syncDataMap.set(itemId, currentItem);
            } else if (!currentIsExact && existingIsExact) {
               // Mantieni l'esistente
            } else {
               // Nessuno esatto o entrambi esatti: vince chi ha qty > 0
               if (currentItem.newQty > 0 && existingItem.newQty === 0) {
                 syncDataMap.set(itemId, currentItem);
               }
            }
          } else {
            syncDataMap.set(itemId, currentItem);
          }
        } else {
          unmatchedProducts.push(currentItem);
        }
      });
      
      const syncData = Array.from(syncDataMap.values()).concat(unmatchedProducts);
      const toUpdate = syncData.filter(p => p.itemId && p.changed);
      
      let updateMsg = `Nessun prodotto da aggiornare.`;
      if (toUpdate.length > 0) {
        const result = await syncQuantitiesToShopify(toUpdate);
        updateMsg = `Aggiornati con successo ${result.count} prodotti su Shopify.`;
      }
      
      // Se l'app è aperta, mandiamo comunque l'evento per aggiornare la UI
      if (win && !win.isDestroyed()) {
        win.webContents.send('danea:preview', syncData);
      }
      
      if (tray) {
        tray.displayBalloon({
          title: 'Sincronizzazione Danea completata',
          content: updateMsg,
          iconType: 'info'
        });
      }
      
      res.set('Content-Type', 'text/plain');
      res.status(200).send('OK');
    } catch (error) {
      console.error(error);
      res.status(500).send(error.message);
    }
  });
  server.get('/danea-orders', async (req, res) => {
    try {
      const settingsPath = getSettingsPath();
      let settings = null;
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      }
      
      const serverUsername = settings?.daneaServerUsername || '';
      const serverPassword = settings?.daneaServerPassword || '';
      
      let providedUsername = req.query.user || '';
      let providedPassword = req.query.pwd || '';

      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Basic ')) {
        const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString('utf8');
        const [u, p] = auth.split(':');
        providedUsername = u || '';
        providedPassword = p || '';
      }
      
      if (serverPassword || serverUsername) {
        if (providedPassword !== serverPassword || providedUsername !== serverUsername) {
          res.set('WWW-Authenticate', 'Basic realm="Danea Sync"');
          return res.status(401).send('Unauthorized');
        }
      }

      const result = await generateDaneaOrdersXml(null, true);
      
      if (tray) {
        tray.displayBalloon({
          title: 'Scaricamento Ordini Danea',
          content: `Scaricati ${result.count || 0} nuovi ordini da Shopify.`,
          iconType: 'info'
        });
      }
      
      res.set('Content-Type', 'text/xml');
      res.send(result.xml);
    } catch (error) {
      console.error(error);
      res.status(500).send('Error processing orders: ' + error.message);
    }
  });

  expressServer = server.listen(3000, '127.0.0.1', () => {
    console.log('Danea local server listening on http://127.0.0.1:3000/danea-sync');
  });
}


async function fetchNewOrdersForPreview() {
  const settingsPath = getSettingsPath();
  let settings = null;
  if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (!settings?.shopifyStoreUrl) throw new Error('URL Store Shopify mancante. Compila le Impostazioni API nell\'app.');
  
  let token = settings?.shopifyApiToken;
  if (!token && settings?.shopifyClientId && settings?.shopifyClientSecret) {
    token = await getShopifyAccessToken(settings.shopifyStoreUrl, settings.shopifyClientId, settings.shopifyClientSecret);
  }
  if (!token) throw new Error('Token Shopify mancante.');

  const cleanUrl = settings.shopifyStoreUrl.replace('https://', '').replace(/\/$/, '');
  const ordersUrl = `https://${cleanUrl}/admin/api/2024-01/orders.json?status=any`;
  
  const response = await axios.get(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
  const allOrders = response.data.orders || [];
  
  const newOrders = allOrders.filter(o => {
    const tags = o.tags || '';
    return !tags.includes('Scaricato_Danea');
  });

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

async function generateDaneaOrdersXml(selectedIds = null, shouldTag = false) {
  const settingsPath = getSettingsPath();
  let settings = null;
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  if (!settings?.shopifyStoreUrl) {
    throw new Error('URL Store Shopify mancante. Compila le Impostazioni API nell\'app.');
  }
  
  let token = settings?.shopifyApiToken;
  if (!token && settings?.shopifyClientId && settings?.shopifyClientSecret) {
    try {
      token = await getShopifyAccessToken(settings.shopifyStoreUrl, settings.shopifyClientId, settings.shopifyClientSecret);
    } catch (e) {
      throw new Error('Credenziali Shopify errate (Client ID / Secret). Dettagli: ' + e.message);
    }
  }
  if (!token) {
    throw new Error('Token Shopify mancante. Compila le Impostazioni API nell\'app.');
  }

  const cleanUrl = settings.shopifyStoreUrl.replace('https://', '').replace(/\/$/, '');
  const ordersUrl = `https://${cleanUrl}/admin/api/2024-01/orders.json?status=any`;
  
  const response = await axios.get(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
  const allOrders = response.data.orders || [];
  
  let newOrders = allOrders.filter(o => {
    const tags = o.tags || '';
    return !tags.includes('Scaricato_Danea');
  });
  
  if (selectedIds) {
    newOrders = newOrders.filter(o => selectedIds.includes(o.id.toString()));
  }

  const docs = [];
  for (const o of newOrders) {
    const c = o.customer || {};
    const ba = o.billing_address || {};
    
    let cf = '';
    if (ba.company && ba.company.match(/^[A-Z0-9]{16}$/i)) cf = ba.company;
    else if (o.note && o.note.toLowerCase().includes('codice fiscale')) {
       const match = o.note.match(/codice fiscale[\s:]*([a-z0-9]{16})/i);
       if (match) cf = match[1];
    }

    const rows = o.line_items.map(item => {
      return `
      <Row>
        <Code><![CDATA[${item.sku || item.product_id || ''}]]></Code>
        <Description><![CDATA[${item.name}]]></Description>
        <Qty>${item.quantity}</Qty>
        <Price>${item.price}</Price>
        <VatCode>22</VatCode>
      </Row>`;
    }).join('');

    let shippingRow = '';
    if (o.shipping_lines && o.shipping_lines.length > 0) {
      const ship = o.shipping_lines[0];
      shippingRow = `
      <Row>
        <Description><![CDATA[Spese di Spedizione: ${ship.title}]]></Description>
        <Qty>1</Qty>
        <Price>${ship.price}</Price>
        <VatCode>22</VatCode>
      </Row>`;
    }

    const docXml = `
    <Document>
      <DocumentType>O</DocumentType>
      <CustomerName><![CDATA[${ba.name || (ba.first_name + ' ' + ba.last_name) || c.first_name + ' ' + c.last_name || 'Cliente'}]]></CustomerName>
      <CustomerAddress><![CDATA[${(ba.address1 || '') + ' ' + (ba.address2 || '')}]]></CustomerAddress>
      <CustomerPostcode><![CDATA[${ba.zip || ''}]]></CustomerPostcode>
      <CustomerCity><![CDATA[${ba.city || ''}]]></CustomerCity>
      <CustomerProvince><![CDATA[${ba.province_code || ''}]]></CustomerProvince>
      <CustomerCountry><![CDATA[${ba.country_code || ''}]]></CustomerCountry>
      ${cf ? `<CustomerFiscalCode><![CDATA[${cf}]]></CustomerFiscalCode>` : ''}
      <Number>${o.order_number}</Number>
      <Date>${o.created_at.substring(0,10)}</Date>
      <Rows>
        ${rows}
        ${shippingRow}
      </Rows>
    </Document>`;
    docs.push(docXml);
  }

  const finalXml = `<?xml version="1.0" encoding="UTF-8"?>
<EasyfattDocuments AppVersion="2">
<Documents>
${docs.join('')}
</Documents>
</EasyfattDocuments>`;

  if (shouldTag) {
    for (const o of newOrders) {
      const currentTags = o.tags ? o.tags + ', Scaricato_Danea' : 'Scaricato_Danea';
      axios.put(`https://${cleanUrl}/admin/api/2024-01/orders/${o.id}.json`, {
        order: { id: o.id, tags: currentTags }
      }, { headers: { 'X-Shopify-Access-Token': token } }).catch(e => console.error('Failed to tag order', o.id, e.message));
    }
  }
  
  return { xml: finalXml, count: newOrders.length };
}

async function tagOrdersOnShopify(selectedIds) {
  if (!selectedIds || selectedIds.length === 0) return { success: true, count: 0 };
  
  const settingsPath = getSettingsPath();
  let settings = null;
  if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  let token = settings?.shopifyApiToken || await getShopifyAccessToken(settings.shopifyStoreUrl, settings.shopifyClientId, settings.shopifyClientSecret);
  const cleanUrl = settings.shopifyStoreUrl.replace('https://', '').replace(/\/$/, '');

  const ordersUrl = `https://${cleanUrl}/admin/api/2024-01/orders.json?status=any`;
  const response = await axios.get(ordersUrl, { headers: { 'X-Shopify-Access-Token': token } });
  const allOrders = response.data.orders || [];
  
  const toTag = allOrders.filter(o => selectedIds.includes(o.id.toString()));
  let taggedCount = 0;
  
  for (const o of toTag) {
    if (o.tags && o.tags.includes('Scaricato_Danea')) continue;
    const currentTags = o.tags ? o.tags + ', Scaricato_Danea' : 'Scaricato_Danea';
    try {
      await axios.put(`https://${cleanUrl}/admin/api/2024-01/orders/${o.id}.json`, {
        order: { id: o.id, tags: currentTags }
      }, { headers: { 'X-Shopify-Access-Token': token } });
      taggedCount++;
    } catch (e) {
      console.error('Failed to tag order', o.id, e.message);
    }
  }
  return { success: true, count: taggedCount };
}



app.on('window-all-closed', function () {
  // L'app rimane attiva in background (System Tray)
});

// IPC Handler for file selection
ipcMain.handle('dialog:openFile', async (event, options) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(options);
  if (canceled) {
    return null;
  } else {
    return filePaths[0];
  }
});

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
    const result = await generateDaneaOrdersXml(selectedIds, false);
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

ipcMain.handle('shopify:tag-orders', async (event, selectedIds) => {
  try {
    return await tagOrdersOnShopify(selectedIds);
  } catch (error) {
    return { success: false, message: error.message };
  }
});

const SETTINGS_FILE = 'settings.json';

function getSettingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

ipcMain.handle('save-settings', async (event, settingsData) => {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settingsData, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('load-settings', async () => {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      return { success: true, data: JSON.parse(data) };
    }
    return { success: true, data: null };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('export-settings', async () => {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) {
      return { success: false, message: 'Nessun file settings.json locale trovato da esportare.' };
    }
    const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
    const settingsObj = JSON.parse(settingsRaw);

    const backupData = {
      settings: settingsObj,
      templates: {}
    };

    if (settingsObj.scorte && settingsObj.scorte.templatePath && fs.existsSync(settingsObj.scorte.templatePath)) {
      backupData.templates.scorteCsv = fs.readFileSync(settingsObj.scorte.templatePath, 'utf8');
    }
    if (settingsObj.nuovi && settingsObj.nuovi.templatePath && fs.existsSync(settingsObj.nuovi.templatePath)) {
      backupData.templates.nuoviCsv = fs.readFileSync(settingsObj.nuovi.templatePath, 'utf8');
    }

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Esporta Pacchetto Impostazioni',
      defaultPath: 'easysync_backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    
    if (!canceled && filePath) {
      fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf8');
      return { success: true, message: 'Impostazioni e Template esportati con successo.' };
    }
    return { success: false, message: 'Esportazione annullata.' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('import-settings', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Importa Pacchetto settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    
    if (canceled || filePaths.length === 0) {
      return { success: false, message: 'Importazione annullata.' };
    }
    
    const importedPath = filePaths[0];
    const dataRaw = fs.readFileSync(importedPath, 'utf8');
    const importedData = JSON.parse(dataRaw);
    
    let settingsData = importedData;
    let templatesData = null;
    
    // Verifica se è un super-pacchetto combinato o un vecchio settings.json
    if (importedData.settings && importedData.templates) {
      settingsData = importedData.settings;
      templatesData = importedData.templates;
    }
    
    // Validazione strutturale
    if (!settingsData.scorte || !settingsData.nuovi || typeof settingsData.scorte.mapping !== 'object' || typeof settingsData.nuovi.mapping !== 'object') {
      return { success: false, message: 'File JSON non valido o corrotto. Struttura non riconosciuta.' };
    }
    
    const currentDataPath = app.getPath('userData');

    // Ricrea i template fisici se presenti nel backup
    if (templatesData) {
      if (templatesData.scorteCsv && settingsData.scorte.templatePath) {
        const fileName = path.basename(settingsData.scorte.templatePath);
        const newPath = path.join(currentDataPath, fileName);
        fs.writeFileSync(newPath, templatesData.scorteCsv, 'utf8');
        settingsData.scorte.templatePath = newPath;
      }
      if (templatesData.nuoviCsv && settingsData.nuovi.templatePath) {
        const fileName = path.basename(settingsData.nuovi.templatePath);
        const newPath = path.join(currentDataPath, fileName);
        fs.writeFileSync(newPath, templatesData.nuoviCsv, 'utf8');
        settingsData.nuovi.templatePath = newPath;
      }
    } else {
      // Adattamento path legacy se importato un vecchio settings.json privo di CSV incorporati
      if (settingsData.scorte.templatePath) {
        const fileName = path.basename(settingsData.scorte.templatePath);
        settingsData.scorte.templatePath = path.join(currentDataPath, fileName);
      }
      if (settingsData.nuovi.templatePath) {
        const fileName = path.basename(settingsData.nuovi.templatePath);
        settingsData.nuovi.templatePath = path.join(currentDataPath, fileName);
      }
    }
    
    // Salva localmente
    fs.writeFileSync(getSettingsPath(), JSON.stringify(settingsData, null, 2), 'utf8');
    
    let msg = 'Impostazioni importate e adattate con successo.';
    if (templatesData) msg = 'Pacchetto completo (Impostazioni + Template) ripristinato con successo.';
    
    return { success: true, message: msg };
  } catch (error) {
    return { success: false, message: 'Errore di lettura JSON: ' + error.message };
  }
});

ipcMain.handle('copy-template', async (event, filePath, templateType) => {
  try {
    const ext = path.extname(filePath);
    const fileName = `template_${templateType}${ext}`;
    const destPath = path.join(app.getPath('userData'), fileName);
    fs.copyFileSync(filePath, destPath);
    return { success: true, path: destPath, fileName: path.basename(filePath) };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('read-headers', async (event, filePath, type) => {
  try {
    if (type === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const sheet = workbook.worksheets[0];
      const headers = [];
      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell, colNumber) => {
        headers.push({ index: colNumber, value: cell.value ? String(cell.value).trim() : '' });
      });
      return { success: true, headers: headers.map(h => h.value) };
    } else if (type === 'csv') {
      const csvContent = fs.readFileSync(filePath, 'utf8');
      const parsed = Papa.parse(csvContent, { header: true, preview: 1, skipEmptyLines: true });
      if (parsed.meta && parsed.meta.fields) {
        return { success: true, headers: parsed.meta.fields };
      }
      return { success: false, message: 'Impossibile leggere le colonne dal CSV.' };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
});

// IPC Handler for processing files
ipcMain.handle('process-files', async (event, daneaPath, shopifyPath) => {
  try {
    const settingsPath = getSettingsPath();
    let settings = null;
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    const mapping = settings?.scorte?.mapping;
    if (!mapping || Object.keys(mapping).length === 0) {
      throw new Error("Mappatura Scorte mancante. Configura le Impostazioni.");
    }

    // 1. Read Danea Excel
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(daneaPath);
    const sheet = workbook.worksheets[0];
    
    const daneaColIndexes = {};
    sheet.getRow(1).eachCell((cell, colNumber) => {
      const val = cell.value ? String(cell.value).trim() : '';
      if (val) daneaColIndexes[val] = colNumber;
    });

    // 2. Read Shopify CSV
    const shopifyCsvContent = fs.readFileSync(shopifyPath, 'utf8');
    const shopifyParsed = Papa.parse(shopifyCsvContent, { header: true, skipEmptyLines: true });
    
    if (shopifyParsed.errors.length > 0 && shopifyParsed.data.length === 0) {
      throw new Error('Errore nella lettura del CSV Shopify.');
    }

    const shopifyData = shopifyParsed.data;
    if (shopifyData.length === 0) {
      return { success: true, message: 'File Shopify vuoto.', updatedCount: 0 };
    }

    const shopifyHeaders = Object.keys(shopifyData[0]);

    const mappedSkuCol = Object.keys(mapping).find(h => h.trim().toLowerCase().includes('sku'));
    if (!mappedSkuCol || mapping[mappedSkuCol].type !== 'danea') {
      throw new Error("Nelle Impostazioni non hai mappato la colonna SKU (o l'hai impostata come valore fisso). Torna in Impostazioni e mappa l'SKU a una colonna Danea (es. 'Cod.').");
    }

    const shopifySkuCol = shopifyHeaders.find(h => h.trim().toLowerCase().includes('sku'));
    if (!shopifySkuCol) {
      throw new Error("Il file Shopify fornito nel tab 'Aggiorna Scorte' non contiene una colonna per l'SKU.");
    }

    const daneaSkuColName = mapping[mappedSkuCol].value;
    const daneaSkuColIdx = daneaColIndexes[daneaSkuColName];

    if (daneaSkuColIdx === undefined) {
      throw new Error(`Colonna SKU Danea "${daneaSkuColName}" non trovata nel file Excel fornito.`);
    }

    const daneaDataMap = new Map();
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const skuCell = row.getCell(daneaSkuColIdx).value;
      const sku = skuCell !== null && skuCell !== undefined ? String(skuCell).trim() : '';
      if (sku) {
        daneaDataMap.set(sku, row);
      }
    });
    
    // 3. Compare and Update
    let updatedCount = 0;
    const updatedProducts = [];

    shopifyData.forEach(shopRow => {
      const sku = String(shopRow[shopifySkuCol] || '').trim();
      if (sku && daneaDataMap.has(sku)) {
        const dRow = daneaDataMap.get(sku);
        let rowChanged = false;
        const updatedRow = { ...shopRow };

        Object.keys(mapping).forEach(shopCol => {
          if (shopCol === mappedSkuCol) return; // Non aggiornare la chiave

          // Tolleranza per spaziature accidentali tra template e file di sync
          let actualShopCol = shopifyHeaders.find(h => h.trim() === shopCol.trim()) || shopCol;

          const mapDef = mapping[shopCol];
          let newValue = shopRow[actualShopCol];

          if (mapDef.type === 'fixed') {
            newValue = mapDef.value;
          } else if (mapDef.type === 'danea') {
            const dColIdx = daneaColIndexes[mapDef.value];
            if (dColIdx !== undefined) {
              const cellVal = dRow.getCell(dColIdx).value;
              newValue = cellVal !== null && cellVal !== undefined ? String(cellVal).trim() : '';
            }
          }

          let oldVal = shopRow[actualShopCol] !== undefined ? String(shopRow[actualShopCol]).trim() : '';
          const newValStr = String(newValue).trim();
          
          // SMART CHECK SHOPIFY INVENTORY:
          // Se stiamo mappando una colonna "(new)" come "On hand (new)", Shopify la lascia sempre vuota.
          // Per capire se c'è un VERO cambiamento, dobbiamo confrontare il nuovo valore con la colonna "(current)"
          if (actualShopCol.includes('(new)')) {
             const currentCol = actualShopCol.replace('(new)', '(current)');
             if (shopRow[currentCol] !== undefined) {
                 oldVal = String(shopRow[currentCol]).trim();
             }
          }
          
          if (oldVal !== newValStr) {
             // Ignora differenze "0" vs vuoto che sono tipici falsi positivi nei fogli di calcolo
             if ((oldVal === '0' && newValStr === '') || (oldVal === '' && newValStr === '0')) {
                // Falso positivo, nessuna modifica
             } else if (!isNaN(oldVal) && !isNaN(newValStr) && oldVal !== '' && newValStr !== '') {
                // Controllo numerico per evitare aggiornamenti fittizi tipo "5" vs "5.0"
                if (Number(oldVal) !== Number(newValStr)) {
                   rowChanged = true;
                   updatedRow[actualShopCol] = newValStr;
                }
             } else {
                rowChanged = true;
                updatedRow[actualShopCol] = newValStr;
             }
          }
        });

        if (rowChanged) {
          updatedProducts.push(updatedRow);
          updatedCount++;
        }
      }
    });

    if (updatedProducts.length === 0) {
      return { success: true, message: 'Nessun prodotto necessita di aggiornamento. I dati coincidono.', updatedCount: 0 };
    }

    // 4. Generate New CSV
    const newCsv = Papa.unparse(updatedProducts);
    
    // 5. Save the updated CSV
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Salva CSV Aggiornato',
      defaultPath: 'shopify_aggiornato.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (!canceled && filePath) {
      fs.writeFileSync(filePath, newCsv, 'utf8');
      return { success: true, message: `Generato CSV con ${updatedCount} prodotti aggiornati.`, updatedCount };
    } else {
      return { success: false, message: 'Salvataggio annullato dall\'utente.' };
    }

  } catch (error) {
    return { success: false, message: `Errore: ${error.message}` };
  }
});

// IPC Handler for generating new products CSV
ipcMain.handle('generate-products', async (event, daneaPath) => {
  try {
    const settingsPath = getSettingsPath();
    let settings = null;
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }

    if (!settings || !settings.nuovi || !settings.nuovi.mapping || Object.keys(settings.nuovi.mapping).length === 0) {
      throw new Error("Nessuna mappatura trovata per i Nuovi Prodotti. Configura prima la sezione Impostazioni.");
    }

    const mapping = settings.nuovi.mapping;
    
    const templatePath = settings.nuovi.templatePath;
    if (!templatePath || !fs.existsSync(templatePath)) {
      throw new Error("Template Shopify per i Nuovi Prodotti non trovato. Assicurati di aver caricato il template nelle Impostazioni.");
    }
    const templateCsvContent = fs.readFileSync(templatePath, 'utf8');
    const templateParsed = Papa.parse(templateCsvContent, { header: true, preview: 1, skipEmptyLines: true });
    if (!templateParsed.meta || !templateParsed.meta.fields) {
      throw new Error("Impossibile leggere le colonne dal Template Shopify salvato.");
    }
    const shopifyHeaders = templateParsed.meta.fields;

    // 1. Read Danea Excel
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(daneaPath);
    const sheet = workbook.worksheets[0];
    
    // Get Danea headers
    const headerRow = sheet.getRow(1);
    const daneaColIndexes = {};
    headerRow.eachCell((cell, colNumber) => {
      const val = cell.value ? String(cell.value).trim() : '';
      if (val) daneaColIndexes[val] = colNumber;
    });

    const generatedProducts = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      
      const newRow = {};
      let hasData = false;

      shopifyHeaders.forEach(shopCol => {
        const mapDef = mapping[shopCol];
        if (!mapDef) {
          newRow[shopCol] = '';
        } else if (mapDef.type === 'fixed') {
          newRow[shopCol] = mapDef.value;
          hasData = true;
        } else if (mapDef.type === 'danea') {
          const dColName = mapDef.value;
          const colIdx = daneaColIndexes[dColName];
          if (colIdx !== undefined) {
            const val = row.getCell(colIdx).value;
            newRow[shopCol] = val !== null && val !== undefined ? String(val).trim() : '';
            if (newRow[shopCol]) hasData = true;
          } else {
            newRow[shopCol] = '';
          }
        }
      });
      
      // Basic check: only add if we mapped something (e.g. SKU isn't empty)
      // Usually we check if SKU or Title is present, but hasData is a fallback
      if (hasData) {
        generatedProducts.push(newRow);
      }
    });

    // Generate CSV string
    const newCsv = Papa.unparse(generatedProducts, { columns: shopifyHeaders });
    
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Salva CSV Nuovi Prodotti',
      defaultPath: 'shopify_nuovi_prodotti.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (!canceled && filePath) {
      fs.writeFileSync(filePath, newCsv, 'utf8');
      return { success: true, message: `Generato CSV per l'importazione di ${generatedProducts.length} nuovi prodotti.` };
    } else {
      return { success: false, message: 'Salvataggio annullato dall\'utente.' };
    }

  } catch (error) {
    return { success: false, message: `Errore: ${error.message}` };
  }
});

// Funzione di utilità per il parsing numerico con la virgola
const parseNum = (val) => {
  if (!val) return 0;
  return Number(String(val).replace(',', '.')) || 0;
};

// Valutazione matematica sicura da CSP
ipcMain.handle('eval-formula', (event, formula) => {
  try {
    return Function(`'use strict'; return (${formula})`)();
  } catch(e) {
    throw new Error(e.message);
  }
});

// CALCOLATORE PREZZI
ipcMain.handle('calculate-prices', async (event, data) => {
  try {
    const goldPrice = parseNum(data.goldPrice);
    const globalDiscount = parseNum(data.discount);
    const rules = data.rules || [];
    const generatedRows = [];
    
    // Shopify CSV columns
    const headers = [
      'Handle', 'Title', 'Option1 Name', 'Option1 Value', 
      'Variant Price', 'Variant Compare At Price', 'Variant Inventory Tracker', 'Variant Inventory Policy'
    ];
    
    rules.forEach(rule => {
      if (rule.active === false) return; // Salta le regole inattive

      // Calcola il discount multiplier per questa specifica regola
      let ruleRawDiscount = globalDiscount;
      if (rule.discount !== undefined && rule.discount !== null && rule.discount !== '') {
        ruleRawDiscount = parseNum(rule.discount);
      }
      
      let discountMultiplier = 1;
      if (ruleRawDiscount > 0 && ruleRawDiscount < 1) {
        discountMultiplier = ruleRawDiscount;
      } else if (ruleRawDiscount >= 1) {
        discountMultiplier = (100 - ruleRawDiscount) / 100;
      }

      const minS = parseInt(rule.minSize) || 8;
      const maxS = parseInt(rule.maxSize) || 31;
      
      // Loop over sizes
      for (let size = minS; size <= maxS; size++) {
        let weight = 0;
        
        if (rule.weightType === 'fixed') {
          weight = parseNum(rule.weight);
        } else if (rule.weightType === 'variable') {
          if (!rule.ranges) continue;
          const range = rule.ranges.find(r => size >= r.from && size <= r.to);
          if (range) {
            weight = parseNum(range.weight);
          } else {
            continue;
          }
        }
        
        // Sostituisci variabili e calcola
        let formula = String(rule.formula)
          .replace(/PESO/g, weight)
          .replace(/PREZZO_FINO/g, goldPrice);
          
        let basePrice = 0;
        try {
          // Valutazione sicura della stringa matematica
          basePrice = Function(`'use strict'; return (${formula})`)();
        } catch(e) {
          console.error(`Errore formula per regola ${rule.name}:`, e);
          continue;
        }
        
        let discountedPrice = basePrice * discountMultiplier;
        
        // Arrotondamento all'intero per eccesso/difetto
        basePrice = Math.round(basePrice);
        discountedPrice = Math.round(discountedPrice);
        
        // Se non c'è handle, salta
        if (!rule.handle) continue;

        generatedRows.push({
          'Handle': rule.handle,
          'Title': rule.title,
          'Option1 Name': 'Misura',
          'Option1 Value': String(size),
          'Variant Price': discountedPrice.toFixed(2),
          'Variant Compare At Price': basePrice.toFixed(2),
          'Variant Inventory Tracker': 'shopify',
          'Variant Inventory Policy': 'continue' // Vendi anche senza scorte per le fedi su misura
        });
      }
    });

    const newCsv = Papa.unparse(generatedRows, { columns: headers });
    
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Salva CSV Listino Prezzi Shopify',
      defaultPath: 'shopify_listino_prezzi.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (!canceled && filePath) {
      fs.writeFileSync(filePath, newCsv, 'utf8');
      return { success: true, path: filePath };
    } else {
      return { success: false, message: 'Salvataggio annullato.' };
    }
    
  } catch (error) {
    return { success: false, message: `Errore: ${error.message}` };
  }
});
