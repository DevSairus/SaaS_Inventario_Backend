// backend/src/services/importers/thirdPartyImport.service.js
//
// Importación de clientes y proveedores desde Excel, con su plantilla.
//
//  - Mismo patrón que la carga de productos: primero se valida (dry run) y se
//    muestra el resultado; luego se importa.
//  - La identificación es la llave: si ya existe un tercero con el mismo
//    número (sin puntos, espacios ni dígito de verificación), se omite o, si
//    el usuario lo pide, se actualiza solo con las celdas que vengan llenas.
//  - Las columnas se reconocen por su encabezado (sin tildes ni mayúsculas, el
//    "*" de obligatorio se ignora), así que el orden no importa y sirven
//    también exportaciones propias con nombres parecidos.
//  - La ciudad se resuelve contra DIVIPOLA: por código DANE o por nombre de
//    municipio + departamento. Sin ciudad, se usa la del negocio (como al
//    crear un cliente rápido).
'use strict';

const ExcelJS = require('exceljs');
const { Op } = require('sequelize');
const { cellToText, parseLocaleNumber } = require('../../utils/excelCell');
const { DIVIPOLA_CITIES, DIVIPOLA_DEPARTMENTS_BY_CODE } = require('../../data/divipola-colombia');

const MAX_REPORTED_ERRORS = 300;
const MAX_ROWS = 10000;
const CHUNK = 500;

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const TRUE_VALUES = new Set(['si', 's', 'x', '1', 'true', 'verdadero', 'yes']);
const FALSE_VALUES = new Set(['no', 'n', '0', 'false', 'falso']);

// Tipos de identificación DIAN (los mismos de los formularios).
const DOCUMENT_TYPES = [
  { code: '13', label: 'Cédula de ciudadanía', aliases: ['cc', 'cedula', 'cedula de ciudadania', 'c.c.', 'c.c'] },
  { code: '31', label: 'NIT', aliases: ['nit'] },
  { code: '22', label: 'Cédula de extranjería', aliases: ['ce', 'cedula de extranjeria', 'c.e.'] },
  { code: '41', label: 'Pasaporte', aliases: ['pasaporte', 'pp', 'pa'] },
  { code: '12', label: 'Tarjeta de identidad', aliases: ['ti', 'tarjeta de identidad'] },
  { code: '91', label: 'NUIP', aliases: ['nuip'] },
  { code: '11', label: 'Registro civil', aliases: ['rc', 'registro civil', 'registro civil de nacimiento'] },
  { code: '21', label: 'Tarjeta de extranjería', aliases: ['te', 'tarjeta de extranjeria'] },
  { code: '42', label: 'Documento de identificación extranjero', aliases: ['die', 'documento extranjero', 'documento de identificacion extranjero', 'documento de identificacion extranjeria'] },
  { code: '47', label: 'PEP', aliases: ['pep', 'permiso especial de permanencia'] },
  { code: '48', label: 'PPT', aliases: ['ppt', 'permiso de proteccion temporal', 'permiso por proteccion temporal'] },
  { code: '50', label: 'NIT de otro país', aliases: ['nit de otro pais', 'nit extranjero'] },
];
const DOC_BY_TEXT = new Map(DOCUMENT_TYPES.flatMap((d) => [[d.code, d.code], [norm(d.label), d.code], ...d.aliases.map((a) => [norm(a), d.code])]));

// Respaldo por palabras clave para textos escritos a mano o truncados
// ("Documento de Identificación extranj…", "Cédula extranjera", "Permiso
// Protección Temporal (PPT)"). El orden importa: lo más específico primero.
const DOC_KEYWORDS = [
  [/permiso.*temporal|ppt/, '48'],
  [/permiso.*especial|pep/, '47'],
  [/nit.*(otro pais|extranj)/, '50'],
  [/tarjeta.*extranj/, '21'],
  [/cedula.*extranj/, '22'],
  [/(documento|doc).*extranj/, '42'],
  [/tarjeta.*identidad/, '12'],
  [/registro civil/, '11'],
  [/pasaporte/, '41'],
  [/nuip/, '91'],
  [/nit/, '31'],
  [/cedula.*ciudadan|^cedula$/, '13'],
];

function parseDocumentType(raw) {
  const t = norm(raw).replace(/[().]/g, ' ').replace(/\s+/g, ' ').trim();
  if (DOC_BY_TEXT.has(t)) return DOC_BY_TEXT.get(t);
  if (DOC_BY_TEXT.has(norm(raw))) return DOC_BY_TEXT.get(norm(raw));
  const hit = DOC_KEYWORDS.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
}

// Llave de comparación: solo dígitos/letras, sin el dígito de verificación.
function docKey(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return '';
  const base = /^[\d.\s]+-\s*\d$/.test(s) ? s.split('-')[0] : s;
  return base.replace(/[^0-9A-Z]/g, '');
}

// ── Ciudades DIVIPOLA ───────────────────────────────────────────────────
const deptName = (code) => DIVIPOLA_DEPARTMENTS_BY_CODE[code]?.name || '';
const CITY_BY_CODE = new Map(DIVIPOLA_CITIES.map((c) => [c.code, c]));
const CITIES_BY_NAME = new Map();
for (const c of DIVIPOLA_CITIES) {
  const k = norm(c.name);
  if (!CITIES_BY_NAME.has(k)) CITIES_BY_NAME.set(k, []);
  CITIES_BY_NAME.get(k).push(c);
}
const CITY_ALIASES = { bogota: '11001', 'bogota d.c.': '11001', 'bogota dc': '11001', 'santa fe de bogota': '11001', cali: '76001', cartagena: '13001', 'cartagena de indias': '13001', cucuta: '54001' };

/** @returns {{ city?: object, error?: string }} */
function resolveCity({ code, city, department }) {
  const c = String(code || '').replace(/\D/g, '');
  if (c) {
    const found = CITY_BY_CODE.get(c.padStart(5, '0'));
    return found ? { city: found } : { error: `Código de ciudad ${code} no existe en DIVIPOLA` };
  }
  if (!city) return {};
  const aliased = CITY_ALIASES[norm(city)];
  if (aliased) return { city: CITY_BY_CODE.get(aliased) };
  const options = CITIES_BY_NAME.get(norm(city)) || [];
  if (options.length === 1) return { city: options[0] };
  if (!options.length) return { error: `No se encontró el municipio "${city}"` };
  const d = norm(department);
  const match = d && options.find((o) => norm(deptName(o.department_code)).startsWith(d) || d.startsWith(norm(deptName(o.department_code))));
  return match ? { city: match } : { error: `Hay varios municipios llamados "${city}": indica el departamento o el código DANE` };
}

// ── Definición de columnas ──────────────────────────────────────────────
// key: campo interno; header: encabezado de la plantilla; aliases: otros
// encabezados aceptados; type: text|email|number|int|bool|doc|list; width.
const COMMON_LOCATION = [
  { key: 'address', header: 'Dirección', aliases: ['direccion'], width: 30, example: 'Cra 5 # 10-20' },
  { key: 'city_code', header: 'Código ciudad (DANE)', aliases: ['codigo ciudad', 'codigo dane', 'codigo municipio', 'city_code'], width: 14, example: '73001', help: 'Opcional si escribes ciudad y departamento. Ver hoja Municipios.' },
  { key: 'city', header: 'Ciudad', aliases: ['municipio', 'ciudad / municipio'], width: 18, example: 'Ibagué' },
  { key: 'state', header: 'Departamento', aliases: ['depto'], width: 16, example: 'Tolima' },
];

const ENTITIES = {
  customers: {
    sheet: 'Clientes',
    label: 'clientes',
    columns: [
      { key: 'document_type', header: 'Tipo de documento', required: true, type: 'doc', width: 20, example: 'CC', help: 'CC, NIT, CE (cédula de extranjería), Pasaporte, PPT (Permiso de Protección Temporal), PEP, Documento extranjero, TI, NUIP, Registro civil, o el código DIAN.' },
      { key: 'tax_id', header: 'Número de documento', required: true, aliases: ['documento', 'nit', 'cedula', 'nit/cc', 'identificacion', 'numero de identificacion'], width: 18, example: '1110456789', help: 'El NIT puede ir con o sin dígito de verificación (900123456 o 900123456-7). Es la llave para no duplicar clientes.' },
      { key: 'name', header: 'Nombre o razón social', required: true, aliases: ['nombre', 'nombre completo', 'razon social', 'cliente'], width: 32, example: 'María Fernanda López' },
      { key: 'customer_type', header: 'Tipo de cliente', type: 'list', options: ['Persona', 'Empresa'], width: 14, example: 'Persona', help: 'Persona o Empresa. Si se deja vacío: Empresa cuando el documento es NIT.' },
      { key: 'trade_name', header: 'Nombre comercial', width: 22, example: '' },
      { key: 'email', header: 'Correo', aliases: ['email', 'correo electronico', 'e-mail'], type: 'email', width: 26, example: 'maria@correo.com' },
      { key: 'phone', header: 'Teléfono', aliases: ['telefono', 'telefono fijo'], width: 14, example: '6012345678' },
      { key: 'mobile', header: 'Celular', aliases: ['movil', 'whatsapp'], width: 14, example: '3001234567' },
      ...COMMON_LOCATION,
      { key: 'customer_category', header: 'Categoría', aliases: ['categoria de cliente', 'segmento'], width: 16, example: 'Mayorista' },
      { key: 'credit_limit', header: 'Cupo de crédito', aliases: ['cupo', 'limite de credito'], type: 'number', width: 14, example: '5000000' },
      { key: 'payment_terms', header: 'Plazo de pago (días)', aliases: ['plazo', 'plazo de pago', 'dias de credito'], type: 'int', width: 12, example: '30' },
      { key: 'withholding_agent', header: 'Agente de retención', type: 'list', options: ['Automático', 'Sí', 'No'], width: 14, example: 'Automático', help: 'Si este cliente le practica retenciones al negocio. Automático: sí cuando tiene NIT.' },
      { key: 'is_exento', header: 'Exento de retenciones', type: 'bool', width: 12, example: 'No' },
      { key: 'is_active', header: 'Activo', type: 'bool', width: 8, example: 'Sí', help: 'Vacío = Sí.' },
      { key: 'notes', header: 'Notas', aliases: ['observaciones'], width: 30, example: '' },
    ],
  },
  suppliers: {
    sheet: 'Proveedores',
    label: 'proveedores',
    columns: [
      { key: 'document_type', header: 'Tipo de documento', required: true, type: 'doc', width: 20, example: 'NIT', help: 'NIT, CC, CE (cédula de extranjería), Pasaporte, PPT (Permiso de Protección Temporal), PEP, Documento extranjero, NIT de otro país, o el código DIAN.' },
      { key: 'tax_id', header: 'Número de documento', required: true, aliases: ['documento', 'nit', 'nit/rut', 'cedula', 'identificacion', 'numero de identificacion'], width: 18, example: '900123456-7', help: 'Con o sin dígito de verificación. Es la llave para no duplicar proveedores.' },
      { key: 'name', header: 'Nombre', required: true, aliases: ['nombre del proveedor', 'proveedor'], width: 30, example: 'Distribuidora Solar SAS' },
      { key: 'business_name', header: 'Razón social', aliases: ['razon social'], width: 30, example: 'Distribuidora Solar S.A.S.' },
      { key: 'trade_name', header: 'Nombre comercial', width: 22, example: '' },
      { key: 'code', header: 'Código', aliases: ['codigo', 'codigo proveedor'], width: 12, example: 'PROV-001' },
      { key: 'person_type', header: 'Tipo de persona', type: 'list', options: ['Natural', 'Jurídica'], width: 14, example: 'Jurídica', help: 'Si se deja vacío: Jurídica cuando el documento es NIT.' },
      { key: 'tax_regime', header: 'Régimen', aliases: ['regimen', 'regimen tributario', 'responsabilidad iva'], type: 'list', options: ['Común', 'Simple', 'No responsable de IVA'], width: 20, example: 'Común' },
      { key: 'fiscal_responsibilities', header: 'Responsabilidades fiscales', aliases: ['responsabilidades', 'responsabilidades rut'], width: 22, example: 'O-13, O-15', help: 'Códigos del RUT separados por coma (ej. O-13, O-15, R-99-PN).' },
      { key: 'is_obligated_to_invoice', header: 'Obligado a facturar', type: 'bool', width: 12, example: 'Sí', help: 'No = las compras a este proveedor requieren documento soporte. Vacío = Sí.' },
      { key: 'email', header: 'Correo', aliases: ['email', 'correo electronico', 'e-mail'], type: 'email', width: 26, example: 'ventas@proveedor.com' },
      { key: 'phone', header: 'Teléfono', aliases: ['telefono'], width: 14, example: '6014567890' },
      { key: 'mobile', header: 'Celular', aliases: ['movil'], width: 14, example: '3109876543' },
      { key: 'website', header: 'Sitio web', aliases: ['web', 'pagina web'], width: 22, example: '' },
      ...COMMON_LOCATION,
      { key: 'contact_name', header: 'Contacto', aliases: ['nombre de contacto', 'persona de contacto'], width: 22, example: 'Juan Pérez' },
      { key: 'contact_position', header: 'Cargo del contacto', aliases: ['cargo'], width: 18, example: 'Asesor comercial' },
      { key: 'contact_phone', header: 'Teléfono del contacto', aliases: ['telefono contacto', 'celular contacto'], width: 16, example: '3001112233' },
      { key: 'contact_email', header: 'Correo del contacto', aliases: ['email contacto', 'correo contacto'], type: 'email', width: 24, example: '' },
      { key: 'payment_terms', header: 'Plazo de pago (días)', aliases: ['plazo', 'plazo de pago', 'dias de credito'], type: 'int', width: 12, example: '30' },
      { key: 'credit_limit', header: 'Cupo de crédito', aliases: ['cupo'], type: 'number', width: 14, example: '' },
      { key: 'discount_percentage', header: 'Descuento (%)', aliases: ['descuento'], type: 'number', width: 10, example: '' },
      { key: 'bank_name', header: 'Banco', width: 20, example: 'Bancolombia' },
      { key: 'account_type', header: 'Tipo de cuenta', type: 'list', options: ['Ahorros', 'Corriente'], width: 12, example: 'Ahorros' },
      { key: 'account_number', header: 'Número de cuenta', aliases: ['cuenta', 'numero cuenta'], width: 18, example: '' },
      { key: 'is_exento', header: 'Exento de retenciones', type: 'bool', width: 12, example: 'No' },
      { key: 'is_declarante', header: 'Declarante de renta', type: 'bool', width: 12, example: '' },
      { key: 'is_active', header: 'Activo', type: 'bool', width: 8, example: 'Sí', help: 'Vacío = Sí.' },
      { key: 'notes', header: 'Notas', aliases: ['observaciones'], width: 30, example: '' },
    ],
  },
};

const MAX_LENGTHS = {
  tax_id: 50, name: 255, trade_name: 255, business_name: 255, email: 255, phone: 50, mobile: 50, city: 100, state: 100,
  customer_category: 50, code: 50, website: 255, contact_name: 255, contact_position: 255, contact_phone: 50, contact_email: 255,
  bank_name: 255, account_number: 100, fiscal_responsibilities: 200,
};

function headerMap(entity) {
  const map = new Map();
  for (const col of ENTITIES[entity].columns) {
    for (const h of [col.header, ...(col.aliases || [])]) map.set(norm(h), col.key);
  }
  return map;
}

// ── Plantilla ───────────────────────────────────────────────────────────
async function buildTemplate(entity) {
  const def = ENTITIES[entity];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pitbox';
  const ws = wb.addWorksheet(def.sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({ header: c.required ? `${c.header}*` : c.header, key: c.key, width: c.width || 16 }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 32;
  def.columns.forEach((c, i) => {
    head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFC2410C' : 'FF475569' } };
    if (c.help) head.getCell(i + 1).note = c.help;
    const letter = ws.getColumn(i + 1).letter;
    // Texto en documento/teléfonos: que Excel no los convierta en número ni quite ceros.
    if (['tax_id', 'phone', 'mobile', 'contact_phone', 'account_number', 'city_code'].includes(c.key)) ws.getColumn(i + 1).numFmt = '@';
    const list = c.type === 'bool' ? ['Sí', 'No'] : c.type === 'doc' ? ['CC', 'NIT', 'CE', 'Pasaporte', 'PPT', 'PEP', 'Documento extranjero', 'TI', 'NUIP'] : c.options;
    if (list) {
      for (let r = 2; r <= 2000; r += 1) {
        ws.getCell(`${letter}${r}`).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`],
          showErrorMessage: false,
        };
      }
    }
  });

  const help = wb.addWorksheet('Instrucciones');
  help.columns = [{ header: 'Columna', width: 28 }, { header: 'Obligatoria', width: 12 }, { header: 'Qué escribir', width: 70 }, { header: 'Ejemplo', width: 26 }];
  help.getRow(1).font = { bold: true };
  help.addRow([`Llena la hoja "${def.sheet}" desde la fila 2, un ${entity === 'customers' ? 'cliente' : 'proveedor'} por fila. No cambies los encabezados. Las columnas marcadas con * son obligatorias.`]);
  help.mergeCells('A2:D2');
  help.getRow(2).font = { italic: true };
  for (const c of def.columns) {
    const allowed = c.type === 'bool' ? 'Sí o No.' : c.options ? `${c.options.join(', ')}.` : '';
    help.addRow([c.header, c.required ? 'Sí' : '', [c.help, allowed].filter(Boolean).join(' '), c.example || '']);
  }
  help.getColumn(3).alignment = { wrapText: true, vertical: 'top' };

  const cities = wb.addWorksheet('Municipios');
  cities.columns = [{ header: 'Código DANE', key: 'code', width: 12 }, { header: 'Municipio', key: 'name', width: 30 }, { header: 'Departamento', key: 'dept', width: 30 }];
  cities.getRow(1).font = { bold: true };
  for (const c of DIVIPOLA_CITIES) cities.addRow({ code: c.code, name: c.name, dept: deptName(c.department_code) });
  cities.getColumn(1).numFmt = '@';

  return wb.xlsx.writeBuffer();
}

// ── Lectura y validación ────────────────────────────────────────────────
async function readRows(entity, buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(ENTITIES[entity].sheet) || wb.worksheets[0];
  if (!ws) return { fields: new Set(), ignored: [], rows: [] };
  const map = headerMap(entity);
  const colField = [];
  const fields = new Set();
  const ignored = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const header = cellToText(cell.value).trim();
    if (!header) return;
    const key = map.get(norm(header.replace(/\*/g, '')));
    if (key && !fields.has(key)) { colField[col] = key; fields.add(key); } else ignored.push(header);
  });
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const data = {};
    let has = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const key = colField[col];
      if (!key) return;
      const text = cellToText(cell.value).trim();
      if (text) { data[key] = text; has = true; }
    });
    if (has) rows.push({ rowNumber, data });
  });
  return { fields, ignored, rows };
}

// Números es-CO: "5.000.000" y "5.000" son miles (no decimales); "1.234,5" y "12,5" también valen.
function parseAmount(raw) {
  let t = String(raw).replace(/[$\s%]/g, '');
  if (!t.includes(',') && /^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return parseLocaleNumber(t);
}

const parseBool = (v) => {
  if (v === undefined) return undefined;
  const n = norm(v);
  if (TRUE_VALUES.has(n)) return true;
  if (FALSE_VALUES.has(n)) return false;
  return null;
};

/** Convierte una fila del Excel en los datos del modelo. Puro. */
function parseRow(entity, data) {
  const errors = [];
  const out = {};
  const cols = ENTITIES[entity].columns;
  for (const col of cols) {
    const raw = data[col.key];
    if (raw === undefined) {
      if (col.required) errors.push(`Falta "${col.header}"`);
      continue;
    }
    if (MAX_LENGTHS[col.key] && raw.length > MAX_LENGTHS[col.key]) {
      errors.push(`"${col.header}" supera ${MAX_LENGTHS[col.key]} caracteres`);
      continue;
    }
    switch (col.type) {
      case 'doc': {
        const code = parseDocumentType(raw);
        if (code) out.document_type = code; else errors.push(`Tipo de documento "${raw}" no reconocido`);
        break;
      }
      case 'email':
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) out[col.key] = raw.toLowerCase(); else errors.push(`Correo inválido en "${col.header}": ${raw}`);
        break;
      case 'number':
      case 'int': {
        const n = parseAmount(raw);
        if (!Number.isFinite(n) || n < 0) errors.push(`"${col.header}" debe ser un número positivo`);
        else out[col.key] = col.type === 'int' ? Math.round(n) : n;
        break;
      }
      case 'bool': {
        const b = parseBool(raw);
        if (b === null) errors.push(`"${col.header}" debe ser Sí o No`); else out[col.key] = b;
        break;
      }
      case 'list':
        out[col.key] = raw;
        break;
      default:
        out[col.key] = col.key === 'tax_id' ? raw.replace(/\s+/g, '') : raw;
    }
  }

  // Listas cerradas
  if (out.customer_type !== undefined) {
    const t = norm(out.customer_type);
    if (['persona', 'persona natural', 'natural', 'individual'].includes(t)) out.customer_type = 'individual';
    else if (['empresa', 'persona juridica', 'juridica', 'company'].includes(t)) out.customer_type = 'company';
    else errors.push(`Tipo de cliente "${out.customer_type}" no reconocido (Persona o Empresa)`);
  }
  if (out.person_type !== undefined) {
    const t = norm(out.person_type);
    if (t.startsWith('natural') || t === 'persona natural') out.person_type = 'natural';
    else if (t.startsWith('juridica') || t === 'persona juridica') out.person_type = 'juridica';
    else errors.push(`Tipo de persona "${out.person_type}" no reconocido (Natural o Jurídica)`);
  }
  if (out.tax_regime !== undefined) {
    const t = norm(out.tax_regime);
    if (t.startsWith('comun') || t.includes('responsable de iva') && !t.startsWith('no')) out.tax_regime = 'comun';
    else if (t.startsWith('simple')) out.tax_regime = 'simple';
    else if (t.startsWith('no')) out.tax_regime = 'no_responsable';
    else errors.push(`Régimen "${out.tax_regime}" no reconocido (Común, Simple o No responsable de IVA)`);
  }
  if (out.account_type !== undefined) {
    const t = norm(out.account_type);
    if (t.startsWith('ahorro')) out.account_type = 'savings';
    else if (t.startsWith('corriente')) out.account_type = 'checking';
    else errors.push(`Tipo de cuenta "${out.account_type}" no reconocido (Ahorros o Corriente)`);
  }
  if (out.withholding_agent !== undefined) {
    const t = norm(out.withholding_agent);
    if (t.startsWith('auto') || t === '') out.withholding_agent = 'auto';
    else {
      const b = parseBool(out.withholding_agent);
      if (b === null) errors.push('"Agente de retención" debe ser Automático, Sí o No');
      else out.withholding_agent = b;
    }
  }
  if (out.fiscal_responsibilities !== undefined) {
    out.fiscal_responsibilities = out.fiscal_responsibilities.split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  if (out.discount_percentage !== undefined && out.discount_percentage > 100) errors.push('"Descuento (%)" no puede pasar de 100');

  // Ciudad
  if (data.city_code !== undefined || data.city !== undefined) {
    const r = resolveCity({ code: data.city_code, city: data.city, department: data.state });
    if (r.error) errors.push(r.error);
    else if (r.city) {
      out.city_code = r.city.code;
      out.city = r.city.name;
      out.state = deptName(r.city.department_code);
    }
  } else {
    delete out.state;
  }

  out.key = docKey(out.tax_id);
  if (out.tax_id && !out.key) errors.push('Número de documento inválido');
  return { data: out, errors };
}

// Arma el registro del modelo a partir de lo leído. `existing`: para
// actualizar, solo lleva lo que vino en el Excel.
function toModel(entity, d, { forUpdate = false, existing = null } = {}) {
  const m = {};
  const copy = (keys) => { for (const k of keys) if (d[k] !== undefined) m[k] = d[k]; };
  if (entity === 'customers') {
    const type = d.customer_type || (d.document_type === '31' ? 'company' : (forUpdate ? undefined : 'individual'));
    if (type) m.customer_type = type;
    if (d.name !== undefined) {
      const effectiveType = type || existing?.customer_type || 'individual';
      if (effectiveType === 'company') {
        m.first_name = d.name; m.last_name = ''; m.business_name = d.name;
      } else {
        const parts = d.name.trim().split(/\s+/);
        m.first_name = parts[0]; m.last_name = parts.slice(1).join(' ');
      }
    }
    copy(['document_type', 'trade_name', 'email', 'phone', 'mobile', 'address', 'city', 'state', 'city_code', 'customer_category', 'credit_limit', 'payment_terms', 'notes', 'is_active']);
    if (!forUpdate) m.tax_id = d.tax_id;
    if (d.withholding_agent !== undefined || d.is_exento !== undefined) {
      const rc = { ...(existing?.retention_config || {}) };
      if (d.is_exento !== undefined) rc.is_exento = d.is_exento;
      if (d.withholding_agent === 'auto') delete rc.withholding_agent;
      else if (d.withholding_agent !== undefined) rc.withholding_agent = d.withholding_agent;
      if (rc.is_exento === undefined) rc.is_exento = false;
      m.retention_config = rc;
    }
  } else {
    copy(['name', 'business_name', 'trade_name', 'code', 'document_type', 'tax_regime', 'fiscal_responsibilities', 'is_obligated_to_invoice',
      'email', 'phone', 'mobile', 'website', 'address', 'city', 'state', 'city_code', 'contact_name', 'contact_position', 'contact_phone',
      'contact_email', 'payment_terms', 'credit_limit', 'discount_percentage', 'bank_name', 'account_type', 'account_number', 'notes', 'is_active']);
    const person = d.person_type || (d.document_type ? (d.document_type === '31' ? 'juridica' : 'natural') : undefined);
    if (person && (!forUpdate || d.person_type || !existing?.person_type)) m.person_type = person;
    if (!forUpdate) {
      m.tax_id = d.tax_id;
      if (!m.business_name && person === 'juridica') m.business_name = d.name;
    }
    if (d.is_exento !== undefined || d.is_declarante !== undefined) {
      const rc = { ...(existing?.retention_config || {}) };
      if (d.is_exento !== undefined) rc.is_exento = d.is_exento;
      if (d.is_declarante !== undefined) rc.is_declarante = d.is_declarante;
      m.retention_config = rc;
    }
  }
  return m;
}

/**
 * Valida (dryRun) o importa.
 * @param {object} opts { entity, tenantId, buffer, dryRun, updateExisting, defaultCity }
 */
async function importThirdParties({ entity, tenantId, buffer, dryRun, updateExisting = false, defaultCity = null }) {
  const def = ENTITIES[entity];
  if (!def) throw Object.assign(new Error('Tipo de importación no válido'), { statusCode: 400 });
  const models = require('../../models');
  const Model = entity === 'customers' ? models.Customer : models.Supplier;
  const { sequelize } = require('../../config/database');

  let read;
  try {
    read = await readRows(entity, buffer);
  } catch (err) {
    throw Object.assign(new Error(`No se pudo leer el archivo Excel: ${err.message}`), { statusCode: 400 });
  }
  const missing = def.columns.filter((c) => c.required && !read.fields.has(c.key)).map((c) => `${c.header}*`);
  if (missing.length) throw Object.assign(new Error(`Faltan columnas obligatorias: ${missing.join(', ')}. Descarga la plantilla.`), { statusCode: 400 });
  if (read.rows.length > MAX_ROWS) throw Object.assign(new Error(`El archivo tiene ${read.rows.length} filas; el máximo por carga es ${MAX_ROWS}`), { statusCode: 400 });

  const parsed = read.rows.map((r) => ({ rowNumber: r.rowNumber, ...parseRow(entity, r.data) }));

  // Duplicados dentro del archivo: vale la primera fila.
  const seen = new Map();
  for (const p of parsed) {
    if (!p.data.key) continue;
    if (seen.has(p.data.key)) p.errors.push(`Documento repetido en el archivo (ya está en la fila ${seen.get(p.data.key)})`);
    else seen.set(p.data.key, p.rowNumber);
  }

  // Existentes en el negocio, por llave de documento.
  const existingRows = await Model.findAll({ where: { tenant_id: tenantId, tax_id: { [Op.ne]: null } } });
  const existingByKey = new Map();
  for (const e of existingRows) {
    const k = docKey(e.tax_id);
    if (k && !existingByKey.has(k)) existingByKey.set(k, e);
  }

  const toCreate = [];
  const toUpdate = [];
  const skipped = [];
  const invalid = [];
  for (const p of parsed) {
    if (p.errors.length) { invalid.push(p); continue; }
    const ex = existingByKey.get(p.data.key);
    if (!ex) toCreate.push(p);
    else if (updateExisting) toUpdate.push({ ...p, existing: ex });
    else skipped.push({ ...p, existing: ex });
  }

  const summary = {
    dry_run: Boolean(dryRun),
    total_registros: parsed.length,
    a_crear: toCreate.length,
    a_actualizar: toUpdate.length,
    omitidos_existentes: skipped.length,
    con_errores: invalid.length,
    creados: 0,
    actualizados: 0,
    errores: invalid.slice(0, MAX_REPORTED_ERRORS).map((p) => ({ fila: p.rowNumber, documento: p.data.tax_id || '', nombre: p.data.name || '', errores: p.errors })),
    errores_truncados: invalid.length > MAX_REPORTED_ERRORS,
    existentes: skipped.slice(0, 50).map((p) => ({ fila: p.rowNumber, documento: p.data.tax_id, nombre: p.data.name })),
    columnas_ignoradas: read.ignored,
  };
  if (dryRun) return summary;

  await sequelize.transaction(async (transaction) => {
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const batch = toCreate.slice(i, i + CHUNK).map((p) => {
        const m = { ...toModel(entity, p.data), tenant_id: tenantId };
        // Sin ciudad: la del negocio (mismo atajo que el alta rápida de clientes).
        if (!m.city_code && defaultCity?.city_code) {
          m.city_code = defaultCity.city_code;
          m.city = m.city || defaultCity.city || null;
          m.state = m.state || defaultCity.state || null;
        }
        if (m.is_active === undefined) m.is_active = true;
        return m;
      });
      // eslint-disable-next-line no-await-in-loop -- lotes de 500
      await Model.bulkCreate(batch, { transaction, validate: true });
    }
    for (const p of toUpdate) {
      const changes = toModel(entity, p.data, { forUpdate: true, existing: p.existing });
      // eslint-disable-next-line no-await-in-loop -- una actualización por tercero existente
      if (Object.keys(changes).length) await p.existing.update(changes, { transaction });
    }
  });
  summary.creados = toCreate.length;
  summary.actualizados = toUpdate.length;
  return summary;
}

module.exports = { ENTITIES, DOCUMENT_TYPES, parseDocumentType, buildTemplate, importThirdParties, parseRow, docKey, resolveCity, toModel };
