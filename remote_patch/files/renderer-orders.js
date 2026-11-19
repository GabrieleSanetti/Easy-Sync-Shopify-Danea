/**
 * Scheda ORDINI: ricerca dei nuovi ordini Shopify, XML per Danea e tag.
 */

let currentNewOrders = [];

if (document.getElementById('btn-fetch-orders')) {
  document.getElementById('btn-fetch-orders').addEventListener('click', async () => {
    addLog('Ricerca nuovi ordini su Shopify in corso...');
    const result = await window.electronAPI.fetchNewOrders();
    
    if (result.success) {
      if (result.orders.length === 0) {
        addLog('Nessun nuovo ordine da scaricare.');
        alert('Nessun nuovo ordine trovato.');
        return;
      }
      
      currentNewOrders = result.orders;
      
      const tbody = document.getElementById('orders-table-body');
      tbody.innerHTML = '';
      currentNewOrders.forEach(o => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-color)';
        // Il nome lo scrive il cliente al checkout: va escapato prima di innerHTML.
        tr.innerHTML = `
          <td style="padding: 8px;"><input type="checkbox" class="order-checkbox" value="${escapeHtml(o.id)}" checked></td>
          <td style="padding: 8px;">${escapeHtml(o.order_number)}</td>
          <td style="padding: 8px;">${escapeHtml(o.created_at)}</td>
          <td style="padding: 8px;">${escapeHtml(o.customer)}</td>
          <td style="padding: 8px;">€ ${escapeHtml(o.total_price)}</td>
        `;
        tbody.appendChild(tr);
      });
      
      document.getElementById('orders-initial-state').style.display = 'none';
      document.getElementById('orders-preview-state').style.display = 'flex';
      
      updateOrderSelectionSummary();
      addLog(`Trovati ${result.orders.length} nuovi ordini.`);
    } else {
      addLog(`❌ Errore ricerca ordini: ${result.message}`);
    }
  });
}

function updateOrderSelectionSummary() {
  const checkboxes = document.querySelectorAll('.order-checkbox');
  const checked = Array.from(checkboxes).filter(cb => cb.checked).length;
  document.getElementById('orders-preview-summary').textContent = `Ordini selezionati: ${checked} su ${checkboxes.length}`;
}

if (document.getElementById('check-all-orders')) {
  document.getElementById('check-all-orders').addEventListener('change', (e) => {
    const checkboxes = document.querySelectorAll('.order-checkbox');
    checkboxes.forEach(cb => cb.checked = e.target.checked);
    updateOrderSelectionSummary();
  });
}

document.getElementById('orders-table-body')?.addEventListener('change', (e) => {
  if (e.target.classList.contains('order-checkbox')) {
    updateOrderSelectionSummary();
  }
});

if (document.getElementById('btn-cancel-orders')) {
  document.getElementById('btn-cancel-orders').addEventListener('click', () => {
    document.getElementById('orders-initial-state').style.display = 'flex';
    document.getElementById('orders-preview-state').style.display = 'none';
    currentNewOrders = [];
  });
}

if (document.getElementById('btn-export-xml-only')) {
  document.getElementById('btn-export-xml-only').addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.order-checkbox:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (selectedIds.length === 0) {
      alert('Seleziona almeno un ordine da scaricare.');
      return;
    }
    
    addLog(`Generazione XML per ${selectedIds.length} ordini in corso...`);
    document.getElementById('btn-export-xml-only').disabled = true;
    
    const result = await window.electronAPI.exportOrders(selectedIds);
    
    document.getElementById('btn-export-xml-only').disabled = false;
    
    if (result.success) {
      addLog(`✅ Salvataggio completato! Esportati ${result.count} ordini nel file: ${result.path}`);
      // Rimuoviamo gli ordini esportati dalla tabella corrente così non li esportano di nuovo per sbaglio?
      // Oppure li lasciamo lì in modo che possano decidere di taggarli in un secondo momento. Li lasciamo.
    } else {
      addLog(`❌ Errore esportazione ordini: ${result.message}`);
    }
  });
}

if (document.getElementById('btn-tag-orders-only')) {
  document.getElementById('btn-tag-orders-only').addEventListener('click', async () => {
    const checkboxes = document.querySelectorAll('.order-checkbox:checked');
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    
    if (selectedIds.length === 0) {
      alert('Seleziona almeno un ordine da taggare.');
      return;
    }
    
    if(!confirm(`Sei sicuro di voler taggare ${selectedIds.length} ordini come "Scaricato_Danea" su Shopify? Scompariranno dalle prossime ricerche.`)) {
      return;
    }
    
    addLog(`Tag di ${selectedIds.length} ordini su Shopify in corso...`);
    document.getElementById('btn-tag-orders-only').disabled = true;
    
    const result = await window.electronAPI.tagOrders(selectedIds);
    
    document.getElementById('btn-tag-orders-only').disabled = false;
    
    if (result.success) {
      addLog(`✅ Taggati con successo ${result.count} ordini!`);
      if (result.failed && result.failed.length) {
        addLog(`⚠️ Non taggati ${result.failed.length}: ${result.failed.map(f => `#${f.orderNumber} (${f.error})`).join(', ')}`);
      }
      // Ritorna allo stato iniziale
      document.getElementById('orders-initial-state').style.display = 'flex';
      document.getElementById('orders-preview-state').style.display = 'none';
      currentNewOrders = [];
    } else {
      addLog(`❌ Errore durante il tag: ${result.message}`);
    }
  });
}
