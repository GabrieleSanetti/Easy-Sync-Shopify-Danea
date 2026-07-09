const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const Papa = require('papaparse');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('index.html');
}

// Disabilita accelerazione hardware e Vulkan per evitare warning su Linux Wayland
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-vulkan');

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
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
