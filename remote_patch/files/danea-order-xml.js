/**
 * Costruisce l'XML Easyfatt (EasyfattDocuments) degli ordini Shopify da importare
 * in Danea.
 *
 * CONTESTO MACCHINA (per iterazioni IA future):
 * Il tracciato è quello documentato su danea.it/software/easyfatt/xml/documenti/.
 * Alcuni campi sono critici e vanno lasciati come sono, salvo nuova verifica sulla
 * documentazione ufficiale:
 *
 *  - DocumentType: "C" = Ordine cliente. In passato qui c'era "O", che nel
 *    tracciato Danea significa "Nota d'addebito": gli ordini importati finivano
 *    quindi come note di debito. Se il tag viene omesso, Danea assume "C".
 *  - PricesIncludeVat: dice a Danea se Row.Price è ivato. Shopify lo sa
 *    nell'ordine stesso (`taxes_included`), quindi lo ricopiamo da lì: scriverlo
 *    a mano sbagliato falsa tutti i totali del documento del 22%.
 *  - Number: trasmesso, quindi Danea numera il documento come l'ordine Shopify.
 *    Non è quello che si vuole, ma omettendolo Danea ha smesso di importare:
 *    l'interruttore OMIT_NUMBER tiene la cosa in un posto solo, in attesa di
 *    capire cosa serve a Danea per numerare da sé. Il riferimento all'ordine
 *    Shopify sta comunque in CustomField1.
 *  - Total: obbligatorio nello schema ufficiale (easyfatt-xml.xsd), insieme a
 *    DocumentType, Date e CustomerName, anche se la documentazione lo dà per
 *    ignorato in importazione. Per molto tempo non è stato emesso affatto.
 *  - Discounts accetta SOLO percentuali ("20+5.5%"), mentre Shopify dà importi in
 *    valuta: convertiamo noi. Row.Total verrebbe ignorato in importazione, quindi
 *    non è una scorciatoia utilizzabile per farsi tornare i conti.
 *  - VatCode: il valore dell'elemento deve esistere nella tabella "Categorie Iva"
 *    di Easyfatt, è lì che avviene l'abbinamento; Perc è solo un attributo
 *    facoltativo. Aliquote diverse da quelle configurate nel gestionale vengono
 *    rifiutate in importazione.
 *
 * La logica sta qui e non in core.js perché è l'unico modo per testarla senza
 * chiamare le API Shopify: vedi tools/test-danea-order-xml.js.
 */

// Il valore Easyfatt per "Ordine cliente".
const DOCUMENT_TYPE_ORDINE_CLIENTE = 'C';

/**
 * Se true il documento esce senza <Number> e Danea dovrebbe numerarlo con la sua
 * sequenza interna. Tenuto a false: provandolo, Danea ha smesso di importare del
 * tutto (nessun documento mostrato), mentre lo schema ufficiale dà Number per
 * facoltativo. Prima di rimetterlo a true va capito cosa serve davvero a Danea
 * per numerare da sé: vedi la nota in handoff.md.
 */
const OMIT_NUMBER = false;

// Aliquota usata quando Shopify non espone nessuna informazione fiscale e
// l'ordine non risulta esplicitamente esente.
const DEFAULT_VAT_CODE = 22;

/**
 * Racchiude il testo in CDATA neutralizzando la sequenza "]]>", che altrimenti
 * chiuderebbe la sezione in anticipo e romperebbe l'XML (un nome prodotto o una
 * nota del cliente possono contenerla).
 */
function cdata(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return `<![CDATA[${text.split(']]>').join(']]]]><![CDATA[>')}]]>`;
}

/** Numero senza zeri decimali inutili: 22 -> "22", 5.50 -> "5.5". */
function num(value, decimals) {
  return String(Number(Number(value).toFixed(decimals)));
}

/** Primo valore non vuoto, ignorando le concatenazioni tipo "undefined undefined". */
function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return '';
}

function joinName(first, last) {
  return [first, last].filter((p) => typeof p === 'string' && p.trim() !== '').join(' ');
}

function addressLine(addr) {
  return [addr.address1, addr.address2].filter((p) => p && String(p).trim() !== '').join(' ').trim();
}

/** Codice fiscale: dal campo azienda se ha la forma giusta, altrimenti dalla nota. */
function extractFiscalCode(order, billing) {
  if (billing.company && /^[A-Z0-9]{16}$/i.test(billing.company)) return billing.company;
  if (order.note && order.note.toLowerCase().includes('codice fiscale')) {
    const match = order.note.match(/codice fiscale[\s:]*([a-z0-9]{16})/i);
    if (match) return match[1];
  }
  return '';
}

/**
 * Aliquota in percentuale da una lista di tax_lines Shopify (rate 0.22 -> 22).
 * Più tax_lines sulla stessa riga si sommano (IVA + eventuali imposte locali).
 * Ritorna null se non c'è nessuna informazione.
 */
function rateFromTaxLines(taxLines) {
  const lines = (taxLines || []).filter((t) => t && t.rate !== undefined && t.rate !== null);
  if (lines.length === 0) return null;
  return Number((lines.reduce((sum, t) => sum + Number(t.rate), 0) * 100).toFixed(2));
}

/**
 * Aliquota da usare per una riga. Priorità: tax_lines della riga, poi quelle
 * dell'ordine, infine DEFAULT_VAT_CODE.
 *
 * NON si deduce lo 0 dall'assenza di imposte sull'ordine: il valore finisce in
 * VatCode e deve esistere nelle Categorie Iva di Easyfatt, che normalmente non ha
 * una categoria "0", e l'importazione segnalava errore. Uno 0 viene scritto solo
 * se è Shopify a dichiarare esplicitamente un'aliquota 0 nei tax_lines; in quel
 * caso la categoria "0" va creata nel gestionale con la classe corretta (non
 * imponibile, esente, fuori campo...), che da Shopify non è deducibile.
 */
function resolveVatRate(taxLines, order) {
  const fromRow = rateFromTaxLines(taxLines);
  if (fromRow !== null) return fromRow;

  const fromOrder = rateFromTaxLines(order.tax_lines);
  if (fromOrder !== null) return fromOrder;

  return DEFAULT_VAT_CODE;
}

function vatCodeTag(rate) {
  const value = num(rate, 2);
  return `<VatCode Perc="${value}">${value}</VatCode>`;
}

/**
 * Sconto di riga come percentuale, perché Danea non accetta importi.
 * Shopify dà importi assoluti: discount_allocations comprende anche gli sconti
 * di testata ripartiti sulle righe, quindi quando c'è si usa quello e NON
 * total_discount, che li conterebbe due volte.
 * Ritorna '' quando non c'è sconto.
 */
function discountPercentage(item) {
  const qty = Number(item.quantity) || 0;
  const unitPrice = Number(item.price) || 0;
  const gross = qty * unitPrice;
  if (gross <= 0) return '';

  let discount = 0;
  if (Array.isArray(item.discount_allocations) && item.discount_allocations.length > 0) {
    discount = item.discount_allocations.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  } else if (item.total_discount) {
    discount = Number(item.total_discount) || 0;
  }
  if (!(discount > 0)) return '';

  const percentage = Math.min((discount / gross) * 100, 100);
  // 4 decimali: l'errore sul totale di riga resta sotto il centesimo anche su
  // importi di qualche migliaio di euro.
  return `${num(percentage, 4)}%`;
}

function buildRows(order) {
  const rows = (order.line_items || []).map((item) => {
    const discounts = discountPercentage(item);
    return `
      <Row>
        <Code>${cdata(item.sku || item.product_id || '')}</Code>
        <Description>${cdata(item.name)}</Description>
        <Qty>${item.quantity}</Qty>
        <Price>${item.price}</Price>${discounts ? `
        <Discounts>${discounts}</Discounts>` : ''}
        ${vatCodeTag(resolveVatRate(item.tax_lines, order))}
      </Row>`;
  });

  const shipping = (order.shipping_lines || [])[0];
  if (shipping) {
    // discounted_price tiene già conto delle promozioni "spedizione gratuita":
    // è esatto al centesimo, mentre una percentuale andrebbe arrotondata.
    const price = shipping.discounted_price !== undefined && shipping.discounted_price !== null
      ? shipping.discounted_price
      : shipping.price;
    rows.push(`
      <Row>
        <Description>${cdata('Spese di Spedizione: ' + shipping.title)}</Description>
        <Qty>1</Qty>
        <Price>${price}</Price>
        ${vatCodeTag(resolveVatRate(shipping.tax_lines, order))}
      </Row>`);
  }
  return rows.join('');
}

/** Lo stesso indirizzo, a meno di maiuscole e spazi? */
function sameAddress(a, b) {
  const key = (addr) => [
    firstNonEmpty(addr.name, joinName(addr.first_name, addr.last_name)),
    addressLine(addr), addr.zip, addr.city, addr.province_code, addr.country_code
  ].map((v) => String(v || '').trim().toLowerCase()).join('|');
  return key(a) === key(b);
}

/**
 * Tag Delivery*, che il tracciato vuole compilati solo quando la consegna
 * differisce dall'indirizzo di fatturazione.
 */
function buildDeliveryTags(order, billing) {
  const shipping = order.shipping_address;
  if (!shipping || Object.keys(shipping).length === 0) return '';
  if (sameAddress(shipping, billing)) return '';

  const name = firstNonEmpty(shipping.name, joinName(shipping.first_name, shipping.last_name));
  return `
      <DeliveryName>${cdata(name)}</DeliveryName>
      <DeliveryAddress>${cdata(addressLine(shipping))}</DeliveryAddress>
      <DeliveryPostcode>${cdata(shipping.zip || '')}</DeliveryPostcode>
      <DeliveryCity>${cdata(shipping.city || '')}</DeliveryCity>
      <DeliveryProvince>${cdata(shipping.province_code || '')}</DeliveryProvince>
      <DeliveryCountry>${cdata(shipping.country_code || '')}</DeliveryCountry>`;
}

/** Un <Document> per un ordine Shopify. */
function buildOrderDocument(order) {
  const customer = order.customer || {};
  const billing = order.billing_address || {};
  const fiscalCode = extractFiscalCode(order, billing);

  const customerName = firstNonEmpty(
    billing.name,
    joinName(billing.first_name, billing.last_name),
    joinName(customer.first_name, customer.last_name)
  ) || 'Cliente';

  // taxes_included manca su ordini molto vecchi: in quel caso non dichiariamo
  // nulla e lasciamo decidere alle impostazioni di Danea.
  const pricesIncludeVat = typeof order.taxes_included === 'boolean'
    ? `
      <PricesIncludeVat>${order.taxes_included ? 'true' : 'false'}</PricesIncludeVat>`
    : '';

  // Number è facoltativo nello schema, ma omettendolo Danea non importava più
  // nulla: finché non è chiaro il perché, si trasmette (vedi OMIT_NUMBER).
  const numberTag = OMIT_NUMBER ? '' : `
      <Number>${order.order_number}</Number>`;

  // Total è obbligatorio nello schema ufficiale (easyfatt-xml.xsd) anche se la
  // documentazione lo dà per ignorato in importazione: non lo abbiamo mai emesso.
  const totalTag = order.total_price !== undefined && order.total_price !== null
    ? `
      <Total>${order.total_price}</Total>`
    : '';

  return `
    <Document>
      <DocumentType>${DOCUMENT_TYPE_ORDINE_CLIENTE}</DocumentType>
      <CustomerName>${cdata(customerName)}</CustomerName>
      <CustomerAddress>${cdata(addressLine(billing))}</CustomerAddress>
      <CustomerPostcode>${cdata(billing.zip || '')}</CustomerPostcode>
      <CustomerCity>${cdata(billing.city || '')}</CustomerCity>
      <CustomerProvince>${cdata(billing.province_code || '')}</CustomerProvince>
      <CustomerCountry>${cdata(billing.country_code || '')}</CustomerCountry>
      ${fiscalCode ? `<CustomerFiscalCode>${cdata(fiscalCode)}</CustomerFiscalCode>` : ''}${buildDeliveryTags(order, billing)}
      <CustomField1>${cdata('Ordine Shopify #' + order.order_number)}</CustomField1>
      <Date>${String(order.created_at).substring(0, 10)}</Date>${numberTag}${totalTag}${pricesIncludeVat}
      <Rows>
        ${buildRows(order)}
      </Rows>
    </Document>`;
}

/** Documento completo EasyfattDocuments con tutti gli ordini passati. */
function buildDocumentsXml(orders) {
  const docs = (orders || []).map(buildOrderDocument).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<EasyfattDocuments AppVersion="2">
<Documents>
${docs}
</Documents>
</EasyfattDocuments>`;
}

module.exports = {
  DOCUMENT_TYPE_ORDINE_CLIENTE,
  DEFAULT_VAT_CODE,
  cdata,
  extractFiscalCode,
  rateFromTaxLines,
  resolveVatRate,
  discountPercentage,
  sameAddress,
  buildOrderDocument,
  buildDocumentsXml
};
