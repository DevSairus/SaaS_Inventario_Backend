// backend/src/services/invoiceXmlParser.js
const xml2js = require('xml2js');

/**
 * Parser de XML de Factura Electrónica
 * Soporta formato DIAN Colombia (UBL 2.1) y formatos similares
 */

/**
 * Parsear XML de factura electrónica
 */
async function parseInvoiceXML(xmlContent) {
  try {
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
      normalizeTags: true,
      normalize: true
    });

    const result = await parser.parseStringPromise(xmlContent);
    
    console.log('🔍 Estructura del XML parseado:');
    console.log('Root keys:', Object.keys(result));
    console.log('Root structure:', JSON.stringify(result, null, 2).substring(0, 500));
    
    // Detectar el formato del XML - Más flexible
    const rootKey = Object.keys(result)[0];
    console.log('📌 Root key detectada:', rootKey);
    
    // Verificar si es un AttachedDocument (contenedor DIAN)
    if (rootKey.toLowerCase().includes('attacheddocument')) {
      console.log('📦 Detectado AttachedDocument DIAN - Extrayendo factura embebida...');
      return parseAttachedDocument(result[rootKey]);
    }
    
    // Buscar diferentes variantes de factura
    if (result.invoice || result['fe:invoice'] || rootKey.toLowerCase().includes('invoice')) {
      console.log('✅ Detectado formato DIAN/UBL');
      return parseDIANFormat(result);
    } else if (result.factura || rootKey.toLowerCase().includes('factura')) {
      console.log('✅ Detectado formato genérico');
      return parseGenericFormat(result);
    } else {
      // Intentar parsear con el primer elemento encontrado
      console.log('⚠️  Formato no reconocido, intentando parseo flexible...');
      return parseFlexibleFormat(result);
    }
  } catch (error) {
    console.error('❌ Error parseando XML:', error);
    throw new Error(`Error al parsear factura electrónica: ${error.message}`);
  }
}

/**
 * Parsear formato DIAN Colombia (UBL 2.1)
 */
function parseDIANFormat(xml) {
  const invoice = xml.invoice || xml['fe:invoice'] || xml;
  
  console.log('🔎 Parseando formato DIAN...');
  
  // Extraer namespace si existe - Mejorada para buscar en profundidad
  const getField = (obj, ...keys) => {
    if (!obj) return null;
    
    for (const key of keys) {
      const lowerKey = key.toLowerCase();
      
      // Buscar directamente
      if (obj[key]) return obj[key];
      if (obj[lowerKey]) return obj[lowerKey];
      
      // Buscar en todas las keys (case insensitive y con namespace)
      const foundKey = Object.keys(obj).find(k => {
        const lowerK = k.toLowerCase();
        return lowerK === lowerKey || lowerK.endsWith(':' + lowerKey);
      });
      
      if (foundKey) return obj[foundKey];
    }
    return null;
  };

  // Información del proveedor (emisor)
  const supplierParty = getField(invoice, 'accountingsupplierparty', 'supplierparty', 'emisor');
  console.log('📦 SupplierParty encontrado:', !!supplierParty);
  
  const party = supplierParty ? getField(supplierParty, 'party', 'parte') : null;
  console.log('👤 Party encontrado:', !!party);
  
  // Extraer tax_id del PartyTaxScheme o PartyIdentification
  let tax_id = null;
  const partyTaxScheme = getField(party, 'partytaxscheme');
  if (partyTaxScheme) {
    const companyId = getField(partyTaxScheme, 'companyid');
    tax_id = extractText(companyId);
  }
  
  if (!tax_id) {
    const partyId = getField(party, 'partyidentification');
    if (partyId) {
      const id = getField(partyId, 'id');
      tax_id = extractText(id);
    }
  }
  
  // Extraer nombre
  let supplierName = null;
  const partyName = getField(party, 'partyname');
  if (partyName) {
    supplierName = extractText(getField(partyName, 'name'));
  }
  
  if (!supplierName && partyTaxScheme) {
    supplierName = extractText(getField(partyTaxScheme, 'registrationname'));
  }
  
  if (!supplierName) {
    const partyLegalEntity = getField(party, 'partylegalentity');
    if (partyLegalEntity) {
      supplierName = extractText(getField(partyLegalEntity, 'registrationname'));
    }
  }
  
  // Extraer contacto
  const contact = getField(party, 'contact');
  const email = contact ? extractText(getField(contact, 'electronicmail')) : null;
  const phone = contact ? extractText(getField(contact, 'telephone')) : null;
  
  // Extraer dirección
  const physicalLocation = getField(party, 'physicallocation');
  const address = physicalLocation ? getField(physicalLocation, 'address') : null;
  let addressText = null;
  
  if (address) {
    const addressLine = getField(address, 'addressline');
    const line = addressLine ? extractText(getField(addressLine, 'line')) : null;
    const cityName = extractText(getField(address, 'cityname'));
    const countrySubentity = extractText(getField(address, 'countrysubentity'));
    
    const parts = [line, cityName, countrySubentity].filter(Boolean);
    addressText = parts.length > 0 ? parts.join(', ') : null;
  }
  
  const supplierInfo = {
    tax_id: tax_id,
    name: supplierName,
    email: email,
    phone: phone,
    address: addressText
  };
  
  console.log('✅ Supplier info:', supplierInfo);

  // Información de la factura
  const invoiceNumber = extractText(getField(invoice, 'id', 'numero'));
  const invoiceDate = extractText(getField(invoice, 'issuedate', 'fecha'));
  const dueDate = extractText(getField(invoice, 'duedate', 'fechavencimiento'));
  
  console.log('📄 Invoice info:', { number: invoiceNumber, date: invoiceDate });

  // Items de la factura
  const invoiceLines = getField(invoice, 'invoiceline', 'lineas');
  console.log('📋 InvoiceLines encontrado:', !!invoiceLines, 'Es array:', Array.isArray(invoiceLines));
  
  const items = parseItems(invoiceLines, getField);

  // Totales
  const monetaryTotal = getField(invoice, 'legalmonetarytotal', 'totalmonetario');
  const totals = parseTotals(monetaryTotal, getField);
  
  console.log('💰 Totales:', totals);
  console.log('📦 Items count:', items.length);

  return {
    supplier: supplierInfo,
    invoice: {
      number: invoiceNumber,
      date: invoiceDate,
      due_date: dueDate
    },
    items: items,
    totals: totals,
    raw: invoice // Guardar XML original por si se necesita
  };
}

/**
 * Parsear formato genérico de factura
 */
function parseGenericFormat(xml) {
  const invoice = xml.factura || xml;

  return {
    supplier: {
      tax_id: extractText(invoice.emisor?.nit || invoice.proveedor?.nit),
      name: extractText(invoice.emisor?.nombre || invoice.proveedor?.nombre),
      email: extractText(invoice.emisor?.email || invoice.proveedor?.email),
      phone: extractText(invoice.emisor?.telefono || invoice.proveedor?.telefono),
      address: extractText(invoice.emisor?.direccion || invoice.proveedor?.direccion)
    },
    invoice: {
      number: extractText(invoice.numero || invoice.id),
      date: extractText(invoice.fecha),
      due_date: extractText(invoice.fechavencimiento || invoice.fecha_vencimiento)
    },
    items: parseGenericItems(invoice.items || invoice.productos || invoice.lineas),
    totals: {
      subtotal: parseFloat(invoice.subtotal || 0),
      tax: parseFloat(invoice.iva || invoice.impuesto || 0),
      total: parseFloat(invoice.total || 0)
    }
  };
}

/**
 * Parsear AttachedDocument de DIAN (contenedor)
 * La factura real está embebida dentro en un CDATA
 */
async function parseAttachedDocument(attachedDoc) {
  try {
    console.log('🔎 Buscando factura embebida en AttachedDocument...');
    
    // Buscar el attachment que contiene la factura
    const attachment = attachedDoc.attachment || attachedDoc['cac:attachment'];
    if (!attachment) {
      throw new Error('No se encontró attachment en AttachedDocument');
    }
    
    const externalRef = attachment.externalreference || attachment['cac:externalreference'];
    if (!externalRef) {
      throw new Error('No se encontró ExternalReference en attachment');
    }
    
    const description = externalRef.description || externalRef['cbc:description'];
    if (!description) {
      throw new Error('No se encontró Description con factura embebida');
    }
    
    // El XML embebido está dentro de un CDATA
    let embeddedXml = extractText(description);
    
    if (!embeddedXml) {
      throw new Error('No se pudo extraer XML embebido');
    }
    
    console.log('📄 XML embebido encontrado (primeros 300 chars):', embeddedXml.substring(0, 300));
    
    // Parsear el XML embebido
    const xml2js = require('xml2js');
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true,
      trim: true,
      normalizeTags: true,
      normalize: true
    });
    
    const embeddedResult = await parser.parseStringPromise(embeddedXml);
    console.log('✅ XML embebido parseado correctamente');
    console.log('Embedded root keys:', Object.keys(embeddedResult));
    
    // El XML embebido debería ser un Invoice
    if (embeddedResult.invoice || embeddedResult['fe:invoice']) {
      return parseDIANFormat(embeddedResult);
    } else {
      throw new Error('El XML embebido no es una factura válida');
    }
    
  } catch (error) {
    console.error('❌ Error parseando AttachedDocument:', error.message);
    throw new Error(`Error al parsear AttachedDocument: ${error.message}`);
  }
}

/**
 * Parsear formato genérico de factura
 */
function parseGenericFormat(xml) {
  const invoice = xml.factura || xml;

  return {
    supplier: {
      tax_id: extractText(invoice.emisor?.nit || invoice.proveedor?.nit),
      name: extractText(invoice.emisor?.nombre || invoice.proveedor?.nombre),
      email: extractText(invoice.emisor?.email || invoice.proveedor?.email),
      phone: extractText(invoice.emisor?.telefono || invoice.proveedor?.telefono),
      address: extractText(invoice.emisor?.direccion || invoice.proveedor?.direccion)
    },
    invoice: {
      number: extractText(invoice.numero || invoice.id),
      date: extractText(invoice.fecha),
      due_date: extractText(invoice.fechavencimiento || invoice.fecha_vencimiento)
    },
    items: parseGenericItems(invoice.items || invoice.productos || invoice.lineas),
    totals: {
      subtotal: parseFloat(invoice.subtotal || 0),
      tax: parseFloat(invoice.iva || invoice.impuesto || 0),
      total: parseFloat(invoice.total || 0)
    }
  };
}

/**
 * Parsear items de la factura (formato DIAN)
 */
function parseItems(invoiceLines, getField) {
  if (!invoiceLines) {
    console.log('⚠️  No se encontraron invoiceLines');
    return [];
  }
  
  const lines = Array.isArray(invoiceLines) ? invoiceLines : [invoiceLines];
  console.log(`📦 Procesando ${lines.length} líneas de factura`);
  
  return lines.map((line, index) => {
    console.log(`\n--- Item ${index + 1} ---`);
    
    // Buscar el item/producto
    const item = getField(line, 'item', 'producto');
    console.log('Item encontrado:', !!item);
    
    // Buscar descripción del producto
    let itemName = null;
    if (item) {
      itemName = extractText(getField(item, 'description', 'nombre', 'descripcion'));
    }
    console.log('Item name:', itemName);
    
    // Buscar SKU
    let sku = null;
    if (item) {
      const sellersId = getField(item, 'sellersitemidentification');
      if (sellersId) {
        sku = extractText(getField(sellersId, 'id'));
      }
      
      if (!sku) {
        const standardId = getField(item, 'standarditemidentification');
        if (standardId) {
          sku = extractText(getField(standardId, 'id'));
        }
      }
      
      if (!sku) {
        sku = extractText(getField(item, 'codigo', 'sku', 'additionalinformation'));
      }
    }
    console.log('SKU:', sku);
    
    // Cantidad
    const quantity = parseFloat(extractText(getField(line, 'invoicedquantity', 'cantidad')) || 1);
    console.log('Quantity:', quantity);
    
    // Precio
    const priceObj = getField(line, 'price', 'precio');
    let unitPrice = 0;
    if (priceObj) {
      unitPrice = parseFloat(extractText(getField(priceObj, 'priceamount', 'valor', 'amount')) || 0);
    }
    console.log('Unit price:', unitPrice);
    
    // Subtotal de la línea (antes de impuestos)
    const lineExtensionAmount = parseFloat(extractText(getField(line, 'lineextensionamount', 'subtotal')) || 0);
    console.log('Line extension amount:', lineExtensionAmount);
    
    // IVA/Tax
    const taxTotalObj = getField(line, 'taxtotal', 'impuesto');
    let taxAmount = 0;
    let taxPercentage = 19; // Default IVA Colombia
    
    if (taxTotalObj) {
      taxAmount = parseFloat(extractText(getField(taxTotalObj, 'taxamount', 'valor', 'amount')) || 0);
      
      // Buscar el porcentaje en TaxSubtotal
      const taxSubtotal = getField(taxTotalObj, 'taxsubtotal');
      if (taxSubtotal) {
        const taxCategory = getField(taxSubtotal, 'taxcategory');
        if (taxCategory) {
          const percent = extractText(getField(taxCategory, 'percent', 'porcentaje'));
          if (percent) {
            taxPercentage = parseFloat(percent);
          }
        }
        
        // Si no se encontró en category, buscar directamente en subtotal
        if (!taxPercentage || taxPercentage === 19) {
          const percent = extractText(getField(taxSubtotal, 'percent', 'porcentaje'));
          if (percent) {
            taxPercentage = parseFloat(percent);
          }
        }
      }
    }
    console.log('Tax amount:', taxAmount, 'Tax %:', taxPercentage);
    
    // Calcular subtotal si no está disponible
    const subtotal = lineExtensionAmount || (unitPrice * quantity);
    const total = subtotal + taxAmount;
    
    console.log('Subtotal:', subtotal, 'Total:', total);
    
    const parsedItem = {
      name: itemName || 'Producto sin nombre',
      sku: sku || `TEMP-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      quantity: quantity,
      unit_price: unitPrice,
      tax_percentage: taxPercentage,
      tax_amount: taxAmount,
      subtotal: subtotal,
      total: total,
      raw: line
    };
    
    console.log('✅ Item parseado:', parsedItem.name, '-', parsedItem.sku);
    
    return parsedItem;
  });
}

/**
 * Parsear items genéricos
 */
function parseGenericItems(items) {
  if (!items) return [];
  
  const itemList = Array.isArray(items) ? items : [items];
  
  return itemList.map(item => ({
    name: extractText(item.nombre || item.descripcion || item.name),
    sku: extractText(item.codigo || item.sku) || `TEMP-${Date.now()}`,
    quantity: parseFloat(item.cantidad || item.quantity || 1),
    unit_price: parseFloat(item.precio || item.price || 0),
    tax_percentage: parseFloat(item.iva_porcentaje || item.tax_percent || 19),
    tax_amount: parseFloat(item.iva || item.tax || 0),
    subtotal: parseFloat(item.subtotal || 0),
    total: parseFloat(item.total || 0)
  }));
}

/**
 * Parsear totales de la factura
 */
function parseTotals(monetaryTotal, getField) {
  if (!monetaryTotal) {
    console.log('⚠️  No se encontró LegalMonetaryTotal');
    return { subtotal: 0, tax: 0, total: 0 };
  }
  
  console.log('💰 Parseando totales...');
  
  const subtotal = parseFloat(extractText(
    getField(monetaryTotal, 'lineextensionamount', 'taxexclusiveamount', 'subtotal')
  ) || 0);
  
  const taxInclusive = parseFloat(extractText(
    getField(monetaryTotal, 'taxinclusiveamount')
  ) || 0);
  
  const total = parseFloat(extractText(
    getField(monetaryTotal, 'payableamount', 'total')
  ) || 0);
  
  // El IVA se puede calcular o buscar
  let tax = total - subtotal;
  
  // También intentar buscar TaxTotal a nivel de invoice
  const taxExclusive = parseFloat(extractText(
    getField(monetaryTotal, 'taxexclusiveamount')
  ) || 0);
  
  if (taxExclusive > 0) {
    tax = taxInclusive - taxExclusive;
  }
  
  console.log('Subtotal:', subtotal, 'Tax:', tax, 'Total:', total);
  
  return {
    subtotal: subtotal,
    tax: tax,
    total: total || (subtotal + tax)
  };
}

/**
 * Extraer texto de un objeto XML
 */
function extractText(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.trim();
  if (obj._) return obj._.trim();
  if (obj.$t) return obj.$t.trim();
  if (obj.id && obj.id._) return obj.id._.trim();
  if (obj.value) return obj.value.trim();
  
  // Si es un objeto con una sola propiedad, intentar extraerla
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof obj[keys[0]] === 'string') {
    return obj[keys[0]].trim();
  }
  
  return null;
}

/**
 * Extraer dirección
 */
function extractAddress(addressObj) {
  if (!addressObj) return null;
  
  const parts = [];
  
  if (addressObj.streetname) parts.push(extractText(addressObj.streetname));
  if (addressObj.cityname) parts.push(extractText(addressObj.cityname));
  if (addressObj.countrysubentity) parts.push(extractText(addressObj.countrysubentity));
  
  return parts.length > 0 ? parts.join(', ') : extractText(addressObj);
}

/**
 * Parsear formato flexible (cuando no se reconoce el formato específico)
 */
function parseFlexibleFormat(xml) {
  console.log('🔧 Iniciando parseo flexible...');
  
  // Obtener el nodo raíz
  const rootKey = Object.keys(xml)[0];
  const root = xml[rootKey];
  
  console.log('Root data:', JSON.stringify(root, null, 2).substring(0, 1000));
  
  // Función helper para buscar valores en el objeto
  const findValue = (obj, searchTerms) => {
    if (!obj) return null;
    
    // Buscar directamente
    for (const term of searchTerms) {
      if (obj[term]) return obj[term];
      
      // Buscar con diferentes variantes de mayúsculas/minúsculas
      const lowerTerm = term.toLowerCase();
      const foundKey = Object.keys(obj).find(k => k.toLowerCase() === lowerTerm);
      if (foundKey) return obj[foundKey];
      
      // Buscar con namespace (ej: cac:PartyName)
      const nsKey = Object.keys(obj).find(k => k.toLowerCase().endsWith(':' + lowerTerm));
      if (nsKey) return obj[nsKey];
    }
    
    return null;
  };
  
  // Buscar información del emisor/proveedor
  const supplier = findValue(root, [
    'accountingsupplierparty',
    'supplierparty', 
    'emisor',
    'proveedor',
    'seller',
    'vendor'
  ]);
  
  const supplierParty = supplier ? findValue(supplier, ['party', 'parte']) : supplier;
  
  const supplierInfo = {
    tax_id: extractFlexibleText(findValue(supplierParty || root, [
      'partyidentification',
      'identificacion',
      'nit',
      'taxid',
      'ruc',
      'id'
    ])),
    name: extractFlexibleText(findValue(supplierParty || root, [
      'partyname',
      'partylegalentity',
      'nombre',
      'name',
      'razonsocial'
    ])),
    email: extractFlexibleText(findValue(supplierParty || root, [
      'electronicmail',
      'email',
      'correo'
    ])),
    phone: extractFlexibleText(findValue(supplierParty || root, [
      'telephone',
      'telefono',
      'phone'
    ])),
    address: extractFlexibleText(findValue(supplierParty || root, [
      'postaladdress',
      'direccion',
      'address'
    ]))
  };
  
  // Buscar información de la factura
  const invoiceNumber = extractFlexibleText(findValue(root, [
    'id',
    'numero',
    'number',
    'invoicenumber',
    'numerofactura'
  ]));
  
  const invoiceDate = extractFlexibleText(findValue(root, [
    'issuedate',
    'fecha',
    'date',
    'fechaemision'
  ]));
  
  const dueDate = extractFlexibleText(findValue(root, [
    'duedate',
    'fechavencimiento',
    'fecha_vencimiento'
  ]));
  
  // Buscar items/líneas
  const invoiceLines = findValue(root, [
    'invoiceline',
    'lineas',
    'lines',
    'items',
    'productos',
    'detail',
    'detalles'
  ]);
  
  let items = [];
  if (invoiceLines) {
    items = parseFlexibleItems(invoiceLines);
  }
  
  // Buscar totales
  const monetaryTotal = findValue(root, [
    'legalmonetarytotal',
    'totalmonetario',
    'totals',
    'totales'
  ]);
  
  const totals = parseFlexibleTotals(monetaryTotal || root);
  
  console.log('📊 Datos extraídos:', {
    supplier: supplierInfo,
    invoiceNumber,
    itemsCount: items.length,
    totals
  });
  
  return {
    supplier: supplierInfo,
    invoice: {
      number: invoiceNumber,
      date: invoiceDate,
      due_date: dueDate
    },
    items: items,
    totals: totals,
    raw: root
  };
}

/**
 * Extraer texto de forma flexible
 */
function extractFlexibleText(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.trim();
  if (typeof obj === 'number') return obj.toString();
  if (obj._) return obj._.trim();
  if (obj.$t) return obj.$t.trim();
  if (obj.value) return String(obj.value).trim();
  
  // Si tiene una propiedad 'id' con estructura
  if (obj.id) {
    if (typeof obj.id === 'string') return obj.id.trim();
    if (obj.id._) return obj.id._.trim();
  }
  
  // Si es un objeto con una sola propiedad de tipo string/number
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const val = obj[keys[0]];
    if (typeof val === 'string' || typeof val === 'number') {
      return String(val).trim();
    }
  }
  
  return null;
}

/**
 * Parsear items de forma flexible
 */
function parseFlexibleItems(invoiceLines) {
  if (!invoiceLines) return [];
  
  const lines = Array.isArray(invoiceLines) ? invoiceLines : [invoiceLines];
  
  return lines.map(line => {
    const findInLine = (searchTerms) => {
      for (const term of searchTerms) {
        if (line[term]) return line[term];
        const lowerTerm = term.toLowerCase();
        const foundKey = Object.keys(line).find(k => k.toLowerCase() === lowerTerm);
        if (foundKey) return line[foundKey];
        const nsKey = Object.keys(line).find(k => k.toLowerCase().endsWith(':' + lowerTerm));
        if (nsKey) return line[nsKey];
      }
      return null;
    };
    
    const item = findInLine(['item', 'producto', 'product']) || line;
    const price = findInLine(['price', 'precio']) || {};
    
    const quantity = parseFloat(extractFlexibleText(
      findInLine(['invoicedquantity', 'cantidad', 'quantity', 'qty'])
    ) || 1);
    
    const unitPrice = parseFloat(extractFlexibleText(
      price.priceamount || price.valor || price.amount || price
    ) || 0);
    
    const taxTotal = findInLine(['taxtotal', 'impuesto', 'tax', 'iva']) || {};
    const taxAmount = parseFloat(extractFlexibleText(
      taxTotal.taxamount || taxTotal.valor || taxTotal.amount || taxTotal
    ) || 0);
    
    const taxPercentage = parseFloat(extractFlexibleText(
      taxTotal.percent || taxTotal.porcentaje || taxTotal.percentage
    ) || 0);
    
    const lineTotal = parseFloat(extractFlexibleText(
      findInLine(['lineextensionamount', 'total', 'amount'])
    ) || (unitPrice * quantity));
    
    const name = extractFlexibleText(
      item.description || item.nombre || item.descripcion || item.name
    );
    
    const sku = extractFlexibleText(
      item.sellersitemidentification || item.codigo || item.sku || item.code
    ) || `TEMP-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
    
    return {
      name: name || 'Producto sin nombre',
      sku: sku,
      quantity: quantity,
      unit_price: unitPrice,
      tax_percentage: taxPercentage || 19,
      tax_amount: taxAmount,
      subtotal: lineTotal,
      total: lineTotal + taxAmount,
      raw: line
    };
  });
}

/**
 * Parsear totales de forma flexible
 */
function parseFlexibleTotals(obj) {
  if (!obj) return { subtotal: 0, tax: 0, total: 0 };
  
  const findValue = (searchTerms) => {
    for (const term of searchTerms) {
      if (obj[term]) return obj[term];
      const lowerTerm = term.toLowerCase();
      const foundKey = Object.keys(obj).find(k => k.toLowerCase() === lowerTerm);
      if (foundKey) return obj[foundKey];
      const nsKey = Object.keys(obj).find(k => k.toLowerCase().endsWith(':' + lowerTerm));
      if (nsKey) return obj[nsKey];
    }
    return null;
  };
  
  return {
    subtotal: parseFloat(extractFlexibleText(findValue([
      'lineextensionamount',
      'subtotal',
      'taxexclusiveamount',
      'base'
    ])) || 0),
    tax: parseFloat(extractFlexibleText(findValue([
      'taxtotal',
      'taxinclusiveamount',
      'iva',
      'impuesto',
      'tax'
    ])) || 0),
    total: parseFloat(extractFlexibleText(findValue([
      'payableamount',
      'total',
      'amount',
      'grandtotal'
    ])) || 0)
  };
}

/**
 * Validar datos parseados
 */
function validateParsedData(data) {
  const errors = [];

  if (!data.supplier?.name) {
    errors.push('No se pudo extraer el nombre del proveedor');
  }

  if (!data.items || data.items.length === 0) {
    errors.push('No se encontraron items en la factura');
  }

  if (!data.invoice?.number) {
    errors.push('No se pudo extraer el número de factura');
  }

  return {
    isValid: errors.length === 0,
    errors: errors
  };
}

module.exports = {
  parseInvoiceXML,
  validateParsedData
};