let daneaPath = null;
let shopifyPath = null;

let daneaImportPath = null;

// Tab logic
const tabBtns = document.querySelectorAll('.tab-btn:not(.sub-tab-btn)');
const tabContents = document.querySelectorAll('.tab-content:not(.sub-tab-content)');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(btn.dataset.target).classList.add('active');
  });
});

// Sub-Tab logic
const subTabBtns = document.querySelectorAll('.sub-tab-btn');
const subTabContents = document.querySelectorAll('.sub-tab-content');

subTabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    subTabBtns.forEach(b => b.classList.remove('active'));
    subTabContents.forEach(c => c.classList.remove('active'));
    // also use display: none for sub tab contents instead of just active class
    subTabContents.forEach(c => c.style.display = 'none');

    btn.classList.add('active');
    const target = document.getElementById(btn.dataset.target);
    target.classList.add('active');
    target.style.display = 'block';
  });
});

// Sync Elements
const btnBrowseDanea = document.getElementById('btn-browse-danea');
const btnBrowseShopify = document.getElementById('btn-browse-shopify');
const btnSync = document.getElementById('btn-sync');
const daneaFileName = document.getElementById('danea-file-name');
const shopifyFileName = document.getElementById('shopify-file-name');
const daneaCard = document.getElementById('danea-card');
const shopifyCard = document.getElementById('shopify-card');

// Import Elements
const btnBrowseDaneaImport = document.getElementById('btn-browse-danea-import');
const btnImport = document.getElementById('btn-import');
const daneaImportFileName = document.getElementById('danea-import-file-name');
const daneaImportCard = document.getElementById('danea-import-card');

// Shared Log Elements
const logList = document.getElementById('log-list');
const statusIndicator = document.querySelector('.status-indicator');
const statusText = document.getElementById('status-text');

function addLog(message) {
  const li = document.createElement('li');
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  li.textContent = `[${time}] ${message}`;
  logList.prepend(li);
}

function updateSyncButtonState() {
  if (daneaPath && shopifyPath) {
    btnSync.disabled = false;
    statusIndicator.classList.add('ready');
    statusText.textContent = 'Ready to Sync';
    statusText.style.color = 'var(--primary-color)';
  } else {
    btnSync.disabled = true;
    statusIndicator.classList.remove('ready');
    statusText.textContent = 'Waiting for files...';
    statusText.style.color = 'var(--text-secondary)';
  }
}

function updateImportButtonState() {
  if (daneaImportPath) {
    btnImport.disabled = false;
    statusIndicator.classList.add('ready');
    statusText.textContent = 'Ready to Generate Products';
    statusText.style.color = 'var(--primary-color)';
  } else {
    btnImport.disabled = true;
    statusIndicator.classList.remove('ready');
    statusText.textContent = 'Waiting for file...';
    statusText.style.color = 'var(--text-secondary)';
  }
}

// Sync Event Listeners
btnBrowseDanea.addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona File Danea Excel',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });
  if (filePath) {
    daneaPath = filePath;
    const name = filePath.split(/[\\/]/).pop();
    daneaFileName.textContent = name;
    daneaCard.classList.add('active');
    addLog(`Danea file selected (Sync): ${name}`);
    updateSyncButtonState();
  }
});

btnBrowseShopify.addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona File Shopify CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (filePath) {
    shopifyPath = filePath;
    const name = filePath.split(/[\\/]/).pop();
    shopifyFileName.textContent = name;
    shopifyCard.classList.add('active');
    addLog(`Shopify CSV selected (Sync): ${name}`);
    updateSyncButtonState();
  }
});

btnSync.addEventListener('click', async () => {
  if (!daneaPath || !shopifyPath) return;
  
  btnSync.disabled = true;
  addLog('Starting sync process... Reading files...');
  statusText.textContent = 'Syncing...';
  
  const result = await window.electronAPI.processFiles(daneaPath, shopifyPath);
  
  if (result.success) {
    addLog(`✅ Success: ${result.message}`);
    statusText.textContent = 'Sync Complete';
  } else {
    addLog(`❌ Error: ${result.message}`);
    statusText.textContent = 'Sync Error';
    statusText.style.color = 'red';
  }
  updateSyncButtonState();
});

// Import Event Listeners
btnBrowseDaneaImport.addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona File Danea Excel',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });
  if (filePath) {
    daneaImportPath = filePath;
    const name = filePath.split(/[\\/]/).pop();
    daneaImportFileName.textContent = name;
    daneaImportCard.classList.add('active');
    addLog(`Danea file selected (Import): ${name}`);
    updateImportButtonState();
  }
});

btnImport.addEventListener('click', async () => {
  if (!daneaImportPath) return;
  
  btnImport.disabled = true;
  addLog('Starting product generation... Reading Danea file...');
  statusText.textContent = 'Generating...';
  
  const result = await window.electronAPI.generateProducts(daneaImportPath);
  
  if (result.success) {
    addLog(`✅ Success: ${result.message}`);
    statusText.textContent = 'Generation Complete';
  } else {
    addLog(`❌ Error: ${result.message}`);
    statusText.textContent = 'Generation Error';
    statusText.style.color = 'red';
  }
  updateImportButtonState();
});

addLog('App initialized. Please select a tab and files to begin.');

// Settings Logic
let appSettings = {
  scorte: { templatePath: null, mapping: {} },
  nuovi: { templatePath: null, mapping: {} },
  theme: 'system'
};

let currentScorteHeaders = { shopify: [], danea: [] };
let currentNuoviHeaders = { shopify: [], danea: [] };

async function loadSettings() {
  const result = await window.electronAPI.loadSettings();
  if (result.success && result.data) {
    appSettings = result.data;
    if (!appSettings.theme) appSettings.theme = 'system';
    
    // Applica e imposta UI tema
    const themeSelector = document.getElementById('theme-selector');
    if (themeSelector) themeSelector.value = appSettings.theme;
    applyTheme(appSettings.theme);

    if (appSettings.scorte.templatePath) {
      document.getElementById('template-scorte-name').textContent = appSettings.scorte.templatePath.split(/[\\/]/).pop();
    }
    if (appSettings.nuovi.templatePath) {
      document.getElementById('template-nuovi-name').textContent = appSettings.nuovi.templatePath.split(/[\\/]/).pop();
    }
    
    // Inizializza Calculator UI
    if (!appSettings.calculator) {
      appSettings.calculator = { goldPrice: '', discount: '', rules: [] };
    }
    document.getElementById('calc-gold-price').value = appSettings.calculator.goldPrice || '';
    document.getElementById('calc-discount').value = appSettings.calculator.discount || '';
    if (typeof renderRules === 'function') renderRules();
    
    
    // Ripristina gli header se salvati
    if (appSettings.scorte.headers) {
      currentScorteHeaders = appSettings.scorte.headers;
      renderMapping('scorte');
    }
    if (appSettings.nuovi.headers) {
      currentNuoviHeaders = appSettings.nuovi.headers;
      renderMapping('nuovi');
    }
  }
}

function renderMapping(type) {
  const container = document.getElementById(`mapping-${type}-container`);
  const list = document.getElementById(`mapping-list-${type}`);
  const headers = type === 'scorte' ? currentScorteHeaders : currentNuoviHeaders;
  const currentMapping = appSettings[type].mapping || {};
  
  if (headers.shopify.length === 0 || headers.danea.length === 0) {
    container.style.display = 'none';
    return;
  }
  
  list.innerHTML = '';
  container.style.display = 'block';
  
  headers.shopify.forEach(shopCol => {
    const row = document.createElement('div');
    row.className = 'mapping-row';
    
    const label = document.createElement('div');
    label.className = 'mapping-col-name';
    label.textContent = shopCol;
    
    const select = document.createElement('select');
    select.className = 'mapping-select';
    
    // Add default empty option
    select.appendChild(new Option('-- Salta / Non mappare --', ''));
    // Add Fixed Value option
    select.appendChild(new Option('-- Valore Fisso --', '__FIXED__'));
    
    headers.danea.forEach(daneaCol => {
      select.appendChild(new Option(`Danea: ${daneaCol}`, daneaCol));
    });
    
    const fixedInput = document.createElement('input');
    fixedInput.type = 'text';
    fixedInput.className = 'mapping-fixed-input';
    fixedInput.placeholder = 'Inserisci valore fisso...';
    
    // Restore saved mapping if exists
    if (currentMapping[shopCol]) {
      const saved = currentMapping[shopCol];
      if (saved.type === 'fixed') {
        select.value = '__FIXED__';
        fixedInput.value = saved.value;
        fixedInput.classList.add('visible');
      } else if (saved.type === 'danea') {
        select.value = saved.value;
      }
    }
    
    select.addEventListener('change', (e) => {
      if (e.target.value === '__FIXED__') {
        fixedInput.classList.add('visible');
      } else {
        fixedInput.classList.remove('visible');
      }
    });
    
    row.dataset.shopCol = shopCol;
    row.appendChild(label);
    row.appendChild(select);
    row.appendChild(fixedInput);
    list.appendChild(row);
  });
}

function gatherMapping(type) {
  const list = document.getElementById(`mapping-list-${type}`);
  const rows = list.querySelectorAll('.mapping-row');
  const mapping = {};
  
  rows.forEach(row => {
    const shopCol = row.dataset.shopCol;
    const select = row.querySelector('.mapping-select').value;
    const fixedInput = row.querySelector('.mapping-fixed-input').value;
    
    if (select === '__FIXED__') {
      mapping[shopCol] = { type: 'fixed', value: fixedInput };
    } else if (select !== '') {
      mapping[shopCol] = { type: 'danea', value: select };
    }
  });
  
  return mapping;
}

// Scorte Settings
document.getElementById('btn-browse-template-scorte').addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona Template Shopify CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (filePath) {
    const copyRes = await window.electronAPI.copyTemplate(filePath, 'scorte');
    if (copyRes.success) {
      appSettings.scorte.templatePath = copyRes.path;
      document.getElementById('template-scorte-name').textContent = copyRes.fileName;
      addLog(`Template Scorte salvato: ${copyRes.fileName}`);
      
      const headRes = await window.electronAPI.readHeaders(copyRes.path, 'csv');
      if (headRes.success) {
        currentScorteHeaders.shopify = headRes.headers;
        renderMapping('scorte');
      }
    }
  }
});

document.getElementById('btn-browse-danea-scorte-sample').addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona File Danea Excel',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });
  if (filePath) {
    document.getElementById('danea-scorte-sample-name').textContent = filePath.split(/[\\/]/).pop();
    const headRes = await window.electronAPI.readHeaders(filePath, 'xlsx');
    if (headRes.success) {
      currentScorteHeaders.danea = headRes.headers;
      renderMapping('scorte');
    }
  }
});

// Nuovi Prodotti Settings
document.getElementById('btn-browse-template-nuovi').addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona Template Shopify CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (filePath) {
    const copyRes = await window.electronAPI.copyTemplate(filePath, 'nuovi');
    if (copyRes.success) {
      appSettings.nuovi.templatePath = copyRes.path;
      document.getElementById('template-nuovi-name').textContent = copyRes.fileName;
      addLog(`Template Nuovi salvato: ${copyRes.fileName}`);
      
      const headRes = await window.electronAPI.readHeaders(copyRes.path, 'csv');
      if (headRes.success) {
        currentNuoviHeaders.shopify = headRes.headers;
        renderMapping('nuovi');
      }
    }
  }
});

document.getElementById('btn-browse-danea-nuovi-sample').addEventListener('click', async () => {
  const filePath = await window.electronAPI.openFile({
    title: 'Seleziona File Danea Excel',
    filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
  });
  if (filePath) {
    document.getElementById('danea-nuovi-sample-name').textContent = filePath.split(/[\\/]/).pop();
    const headRes = await window.electronAPI.readHeaders(filePath, 'xlsx');
    if (headRes.success) {
      currentNuoviHeaders.danea = headRes.headers;
      renderMapping('nuovi');
    }
  }
});

// Save Settings Scorte
document.getElementById('btn-save-settings-scorte').addEventListener('click', async () => {
  if (currentScorteHeaders.shopify.length > 0 && currentScorteHeaders.danea.length > 0) {
    appSettings.scorte.mapping = gatherMapping('scorte');
    appSettings.scorte.headers = currentScorteHeaders; // Salva gli header per ricostruire la UI
  }
  
  const res = await window.electronAPI.saveSettings(appSettings);
  if (res.success) {
    addLog('✅ Impostazioni e mapping Scorte salvati con successo.');
  } else {
    addLog(`❌ Errore nel salvataggio impostazioni: ${res.message}`);
  }
});

// Save Settings Nuovi Prodotti
document.getElementById('btn-save-settings-nuovi').addEventListener('click', async () => {
  if (currentNuoviHeaders.shopify.length > 0 && currentNuoviHeaders.danea.length > 0) {
    appSettings.nuovi.mapping = gatherMapping('nuovi');
    appSettings.nuovi.headers = currentNuoviHeaders; // Salva gli header per ricostruire la UI
  }
  
  const res = await window.electronAPI.saveSettings(appSettings);
  if (res.success) {
    addLog('✅ Impostazioni e mapping Nuovi Prodotti salvati con successo.');
  } else {
    addLog(`❌ Errore nel salvataggio impostazioni: ${res.message}`);
  }
});

// Export Settings
document.getElementById('btn-export-settings').addEventListener('click', async () => {
  const res = await window.electronAPI.exportSettings();
  if (res.success) {
    addLog(`✅ ${res.message}`);
  } else {
    addLog(`❌ Errore esportazione: ${res.message}`);
  }
});

// Import Settings
document.getElementById('btn-import-settings').addEventListener('click', async () => {
  const res = await window.electronAPI.importSettings();
  if (res.success) {
    addLog(`✅ ${res.message}`);
    // Ricarica tutto
    await loadSettings();
    addLog('Le impostazioni importate sono state caricate.');
  } else {
    addLog(`❌ Errore importazione: ${res.message}`);
  }
});

// === LOGICA TEMA ===
function applyTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark-mode');
  } else if (theme === 'light') {
    document.body.classList.remove('dark-mode');
  } else {
    // system
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
  }
}

// Event listener per cambio tema dal selettore
document.getElementById('theme-selector').addEventListener('change', async (e) => {
  const newTheme = e.target.value;
  appSettings.theme = newTheme;
  applyTheme(newTheme);
  const res = await window.electronAPI.saveSettings(appSettings);
  if (res.success) {
    addLog(`✅ Tema grafico impostato su '${newTheme}'.`);
  } else {
    addLog(`❌ Errore nel salvataggio tema: ${res.message}`);
  }
});

// Listener per i cambiamenti di tema a livello di sistema operativo
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (appSettings.theme === 'system') {
    applyTheme('system');
  }
});

// Applica il tema predefinito prima del caricamento (per evitare flash)
applyTheme('system');

// === LOGICA CALCOLATORE PREZZI ===
const btnAddRule = document.getElementById('btn-add-rule');
const ruleModal = document.getElementById('rule-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnSaveRule = document.getElementById('btn-save-rule');
const ruleWeightType = document.getElementById('rule-weight-type');
const fixedContainer = document.getElementById('rule-weight-fixed-container');
const variableContainer = document.getElementById('rule-weight-variable-container');
const btnAddRange = document.getElementById('btn-add-range');
const rangesContainer = document.getElementById('rule-ranges-container');
const rulesContainer = document.getElementById('rules-container');
const noRulesText = document.getElementById('no-rules-text');

document.getElementById('calc-gold-price').addEventListener('change', async (e) => {
  if(!appSettings.calculator) appSettings.calculator = {rules:[]};
  appSettings.calculator.goldPrice = e.target.value;
  await window.electronAPI.saveSettings(appSettings);
});
document.getElementById('calc-discount').addEventListener('change', async (e) => {
  if(!appSettings.calculator) appSettings.calculator = {rules:[]};
  appSettings.calculator.discount = e.target.value;
  await window.electronAPI.saveSettings(appSettings);
});

function renderRules() {
  if (!appSettings.calculator) appSettings.calculator = { rules: [] };
  const rules = appSettings.calculator.rules || [];
  rulesContainer.innerHTML = '';
  
  if (rules.length === 0) {
    rulesContainer.appendChild(noRulesText);
    noRulesText.style.display = 'block';
    return;
  }
  
  rulesContainer.appendChild(noRulesText);
  noRulesText.style.display = 'none';

  rules.forEach((rule, index) => {
    if (rule.active === undefined) rule.active = true;
    
    const div = document.createElement('div');
    div.className = 'mapping-row';
    div.style.justifyContent = 'space-between';
    div.style.opacity = rule.active ? '1' : '0.5';
    
    const info = document.createElement('div');
    info.style.display = 'flex';
    info.style.alignItems = 'center';
    info.style.gap = '10px';
    
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rule.active;
    checkbox.onchange = async () => {
      rule.active = checkbox.checked;
      await window.electronAPI.saveSettings(appSettings);
      renderRules();
    };
    
    const textInfo = document.createElement('div');
    textInfo.innerHTML = `<strong>${rule.name}</strong> <span style="color:var(--text-secondary);font-size:12px;">(${rule.handle})</span><br>
                      <span style="font-size:11px;color:var(--text-secondary);">Tipo: ${rule.weightType === 'fixed' ? 'Fisso' : 'Variabile'} | Misure: ${rule.minSize || 8}-${rule.maxSize || 31}</span>`;
    
    info.appendChild(checkbox);
    info.appendChild(textInfo);
    
    const actions = document.createElement('div');
    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn btn-outline btn-sm';
    btnEdit.textContent = 'Modifica';
    btnEdit.style.marginRight = '5px';
    btnEdit.onclick = () => openRuleModal(index);
    
    const btnDuplicate = document.createElement('button');
    btnDuplicate.className = 'btn btn-outline btn-sm';
    btnDuplicate.textContent = 'Duplica';
    btnDuplicate.style.marginRight = '5px';
    btnDuplicate.onclick = async () => {
      const cloned = JSON.parse(JSON.stringify(rule));
      cloned.name = cloned.name + ' (Copia)';
      appSettings.calculator.rules.push(cloned);
      await window.electronAPI.saveSettings(appSettings);
      renderRules();
    };
    
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn-outline btn-sm';
    btnDelete.style.borderColor = 'red';
    btnDelete.style.color = 'red';
    btnDelete.textContent = 'Elimina';
    btnDelete.onclick = async () => {
      if(confirm('Eliminare regola?')) {
        appSettings.calculator.rules.splice(index, 1);
        await window.electronAPI.saveSettings(appSettings);
        renderRules();
      }
    };
    
    actions.appendChild(btnEdit);
    actions.appendChild(btnDuplicate);
    actions.appendChild(btnDelete);
    div.appendChild(info);
    div.appendChild(actions);
    rulesContainer.appendChild(div);
  });
}

function parseNum(val) {
  if (!val) return 0;
  return Number(String(val).replace(',', '.')) || 0;
}

async function updateLivePreview() {
  const previewContainer = document.getElementById('live-preview-container');
  const formula = document.getElementById('rule-formula').value || '';
  const goldPrice = parseNum(document.getElementById('calc-gold-price').value);
  
  let rawDiscount = parseNum(document.getElementById('rule-discount').value);
  if (!rawDiscount && document.getElementById('rule-discount').value === '') {
    rawDiscount = parseNum(document.getElementById('calc-discount').value);
  }
  
  let discountMultiplier = 1;
  if (rawDiscount > 0 && rawDiscount < 1) discountMultiplier = rawDiscount;
  else if (rawDiscount >= 1) discountMultiplier = (100 - rawDiscount) / 100;

  const minS = parseInt(document.getElementById('rule-min-size').value) || 8;
  const maxS = parseInt(document.getElementById('rule-max-size').value) || 31;
  const weightType = document.getElementById('rule-weight-type').value;
  
  // Raccogli ranges se variabile
  const ranges = [];
  if (weightType === 'variable') {
    const rows = rangesContainer.children;
    for(let i=0; i<rows.length; i++) {
      const from = parseInt(rows[i].querySelector('.range-from').value);
      const to = parseInt(rows[i].querySelector('.range-to').value);
      const weight = parseNum(rows[i].querySelector('.range-weight').value);
      if (from && to && weight) ranges.push({from, to, weight});
    }
  }

  // Prendi 3 misure campione: minima, media, massima
  const midS = Math.floor((minS + maxS) / 2);
  const sampleSizes = [...new Set([minS, midS, maxS])].sort((a,b)=>a-b);
  
  let html = `<table style="width:100%; text-align:left; border-collapse:collapse;">
                <tr style="border-bottom:1px solid var(--border-color); color:var(--text-secondary);">
                  <th style="padding:5px;">Mis.</th>
                  <th style="padding:5px;">Peso</th>
                  <th style="padding:5px;">Base (€)</th>
                  <th style="padding:5px; color:var(--primary-color);">Scontato (€)</th>
                </tr>`;

  let hasError = false;
  let errorMessage = '';
  let debugFormula = '';

  for (let size of sampleSizes) {
    let weight = 0;
    if (weightType === 'fixed') {
      weight = parseNum(document.getElementById('rule-weight').value);
    } else {
      const range = ranges.find(r => size >= r.from && size <= r.to);
      if (range) weight = range.weight;
    }

    let parsedFormula = formula.replace(/PESO/g, weight).replace(/PREZZO_FINO/g, goldPrice);
    let basePrice = 0;
    try {
      basePrice = await window.electronAPI.evalFormula(parsedFormula);
      if (isNaN(basePrice)) throw new Error('Risultato NaN');
    } catch(e) {
      hasError = true;
      errorMessage = e.message;
      debugFormula = parsedFormula;
      break;
    }
    
    let discounted = basePrice * discountMultiplier;
    
    // Arrotondamento
    basePrice = Math.round(basePrice);
    discounted = Math.round(discounted);

    html += `<tr>
              <td style="padding:5px;">${size}</td>
              <td style="padding:5px;">${weight}g</td>
              <td style="padding:5px; text-decoration:line-through; color:var(--text-secondary);">${basePrice.toFixed(2)}</td>
              <td style="padding:5px; font-weight:bold; color:var(--primary-color);">${discounted.toFixed(2)}</td>
             </tr>`;
  }
  
  html += `</table>`;

  if (hasError) {
    previewContainer.innerHTML = `<div style="text-align: center; color: red; padding: 20px 0;">
      ❌ Errore nella formula! Controlla la sintassi.<br>
      <small style="color:var(--text-secondary);">Dettaglio: ${errorMessage}<br>Formula valutata: ${debugFormula}</small>
    </div>`;
  } else {
    previewContainer.innerHTML = html;
  }
}

// Bind live preview events
['rule-formula', 'rule-min-size', 'rule-max-size', 'rule-weight-type', 'rule-weight', 'calc-gold-price', 'calc-discount', 'rule-discount'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateLivePreview);
  if (el) el.addEventListener('change', updateLivePreview);
});

function openRuleModal(index = -1) {
  rangesContainer.innerHTML = '';
  
  if (index === -1) {
    document.getElementById('rule-modal-title').textContent = 'Nuova Regola';
    document.getElementById('rule-id').value = '';
    document.getElementById('rule-name').value = '';
    document.getElementById('rule-handle').value = '';
    document.getElementById('rule-title').value = '';
    document.getElementById('rule-formula').value = 'PESO * ((PREZZO_FINO * 0.8) + 5.7) * 2';
    document.getElementById('rule-min-size').value = 8;
    document.getElementById('rule-max-size').value = 31;
    document.getElementById('rule-discount').value = '';
    document.getElementById('rule-weight-type').value = 'fixed';
    document.getElementById('rule-weight').value = '';
    toggleWeightContainers('fixed');
  } else {
    const rule = appSettings.calculator.rules[index];
    document.getElementById('rule-modal-title').textContent = 'Modifica Regola';
    document.getElementById('rule-id').value = index;
    document.getElementById('rule-name').value = rule.name;
    document.getElementById('rule-handle').value = rule.handle;
    document.getElementById('rule-title').value = rule.title;
    document.getElementById('rule-formula').value = rule.formula;
    document.getElementById('rule-min-size').value = rule.minSize || 8;
    document.getElementById('rule-max-size').value = rule.maxSize || 31;
    document.getElementById('rule-discount').value = rule.discount || '';
    document.getElementById('rule-weight-type').value = rule.weightType;
    document.getElementById('rule-weight').value = rule.weight || '';
    
    if (rule.weightType === 'variable' && rule.ranges) {
      rule.ranges.forEach(r => addRangeRow(r.from, r.to, r.weight));
    }
    toggleWeightContainers(rule.weightType);
  }
  
  updateLivePreview();
  ruleModal.style.display = 'flex';
}

function closeRuleModal() {
  ruleModal.style.display = 'none';
}

function toggleWeightContainers(type) {
  if (type === 'fixed') {
    fixedContainer.style.display = 'block';
    variableContainer.style.display = 'none';
  } else {
    fixedContainer.style.display = 'none';
    variableContainer.style.display = 'flex';
  }
}

function addRangeRow(from = '', to = '', weight = '') {
  const div = document.createElement('div');
  div.style.display = 'flex';
  div.style.gap = '5px';
  
  div.innerHTML = `
    <input type="number" class="mapping-select range-from" style="width: 30%;" placeholder="Da (es. 8)" value="${from}">
    <input type="number" class="mapping-select range-to" style="width: 30%;" placeholder="A (es. 13)" value="${to}">
    <input type="number" class="mapping-select range-weight" style="width: 30%;" step="0.01" placeholder="Peso" value="${weight}">
    <button class="btn btn-outline btn-sm btn-remove-range" style="border-color:red; color:red; padding: 2px 8px; margin-top:0;">X</button>
  `;
  rangesContainer.appendChild(div);
  
  // Bind live preview events to new inputs
  div.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', updateLivePreview);
  });
  div.querySelector('.btn-remove-range').addEventListener('click', function() {
    this.parentElement.remove();
    updateLivePreview();
  });
}

if(ruleWeightType) ruleWeightType.addEventListener('change', (e) => toggleWeightContainers(e.target.value));
if(btnAddRule) btnAddRule.addEventListener('click', () => openRuleModal(-1));
if(btnCloseModal) btnCloseModal.addEventListener('click', closeRuleModal);
if(btnAddRange) btnAddRange.addEventListener('click', () => addRangeRow());

if(btnSaveRule) btnSaveRule.addEventListener('click', async () => {
  const index = document.getElementById('rule-id').value;
  const rule = {
    name: document.getElementById('rule-name').value,
    handle: document.getElementById('rule-handle').value,
    title: document.getElementById('rule-title').value,
    formula: document.getElementById('rule-formula').value,
    minSize: document.getElementById('rule-min-size').value,
    maxSize: document.getElementById('rule-max-size').value,
    discount: document.getElementById('rule-discount').value,
    weightType: document.getElementById('rule-weight-type').value,
    weight: document.getElementById('rule-weight').value,
    ranges: [],
    active: true // Default
  };
  
  if (index !== '') {
    // Preserve existing active state if modifying
    rule.active = appSettings.calculator.rules[Number(index)].active;
  }
  
  if (rule.weightType === 'variable') {
    const rows = rangesContainer.children;
    for(let i=0; i<rows.length; i++) {
      const from = rows[i].querySelector('.range-from').value;
      const to = rows[i].querySelector('.range-to').value;
      const weight = rows[i].querySelector('.range-weight').value;
      if (from && to && weight) {
        rule.ranges.push({ from: Number(from), to: Number(to), weight: Number(weight) });
      }
    }
  }
  
  if (!appSettings.calculator) appSettings.calculator = { rules: [] };
  if (!appSettings.calculator.rules) appSettings.calculator.rules = [];
  
  if (index === '') {
    appSettings.calculator.rules.push(rule);
  } else {
    appSettings.calculator.rules[Number(index)] = rule;
  }
  
  await window.electronAPI.saveSettings(appSettings);
  closeRuleModal();
  renderRules();
});

if(document.getElementById('btn-generate-prices')) {
  document.getElementById('btn-generate-prices').addEventListener('click', async () => {
    const goldPrice = document.getElementById('calc-gold-price').value;
    const discount = document.getElementById('calc-discount').value;
    
    if (!goldPrice) {
      addLog('❌ Errore: Inserisci il Prezzo Fino prima di generare.');
      return;
    }
    if (!appSettings.calculator.rules || appSettings.calculator.rules.length === 0) {
      addLog('❌ Errore: Nessuna regola impostata.');
      return;
    }
    
    addLog('Generazione listini Shopify in corso...');
    const result = await window.electronAPI.calculatePrices({
      goldPrice: Number(goldPrice),
      discount: discount ? Number(discount) : 0,
      rules: appSettings.calculator.rules
    });
    
    if (result.success) {
      addLog(`✅ Generazione completata! File salvato in: ${result.path}`);
    } else {
      addLog(`❌ Errore generazione: ${result.message}`);
    }
  });
}

// Initialize
loadSettings();
