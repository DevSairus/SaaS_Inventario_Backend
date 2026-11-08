// src/scripts/seedProjectsDemo.js
//
// Datos de demostración del módulo Proyectos (empresa de energía solar).
// Trabaja contra la API, con los mismos flujos del frontend (cotización →
// proyecto → compras → traslados → cortes), así que respeta validaciones,
// numeración, kardex y asientos automáticos. No necesita acceso a la base.
//
// Uso (PowerShell):
//   $env:PITBOX_API_URL="https://<backend>/api"
//   $env:PITBOX_EMAIL="admin@empresa.com"; $env:PITBOX_PASSWORD="..."
//   node src/scripts/seedProjectsDemo.js
//
// Opcionales: PITBOX_TENANT_ID (si el correo existe en varios tenants),
// PITBOX_BRANCH_ID (sede; por defecto la principal), PITBOX_TOKEN (JWT ya
// firmado, en lugar de correo y clave). --dry-run solo revisa requisitos.
//
// Qué deja:
//   PRY-A  Planta solar 30 kWp (desde el cotizador): en ejecución, anticipo,
//          materiales en obra, gastos, herramienta asignada, corte 1 aprobado
//          (sin facturar: las facturas irían a la DIAN).
//   PRY-B  Sistema híbrido 12 kWp: terminado y cerrado, facturado por remisión.
//   PRY-C  Alumbrado solar: aprobado, BOM con faltantes y pedido a proveedor.
//   PRY-D  Techo solar 8 kWp: en ejecución con sobrecosto (alertas).
//   Más dos estudios del cotizador (borrador y cotizado) y herramientas.
//
// No se re-ejecuta encima de sí mismo: si ya existe el proyecto PRY-A, para.
// Clientes, proveedores y productos se buscan antes de crearlos.

// Acepta la URL sin protocolo (https por defecto) y sin /api al final.
const API = (() => {
  let url = (process.env.PITBOX_API_URL || 'http://localhost:5000/api').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/\/api$/.test(url)) url += '/api';
  return url;
})();
const DRY_RUN = process.argv.includes('--dry-run');

let token = process.env.PITBOX_TOKEN || null;
let branchId = process.env.PITBOX_BRANCH_ID || null;

const NAMES = {
  A: 'Planta solar 30 kWp - Bodega Logística El Dorado',
  B: 'Sistema híbrido 12 kWp - Finca La Esperanza',
  C: 'Alumbrado solar parqueadero - Conjunto Altos del Bosque',
  D: 'Techo solar 8 kWp - Colegio San José',
};

// ── HTTP ──────────────────────────────────────────────────────────────
async function api(method, path, body, { allow = [] } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (branchId) headers['x-branch-id'] = branchId;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !allow.includes(res.status)) {
    const detail = json.data ? ` ${JSON.stringify(json.data).slice(0, 400)}` : '';
    throw new Error(`${method} ${path} → ${res.status}: ${json.message || res.statusText}${detail}`);
  }
  return { status: res.status, ...json };
}

// Las listas responden con formas distintas según el módulo.
function rows(res) {
  const d = res.data ?? res;
  if (Array.isArray(d)) return d;
  for (const k of ['rows', 'items', 'products', 'customers', 'suppliers', 'tools', 'warehouses', 'branches', 'studies', 'lines', 'entries']) {
    if (Array.isArray(d?.[k])) return d[k];
  }
  return [];
}

const log = (...a) => console.log(...a);
const step = (t) => console.log(`\n── ${t}`);
const cop = (n) => `$ ${Math.round(Number(n) || 0).toLocaleString('es-CO')}`;
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

// Días hábiles hacia atrás (para las horas de los técnicos).
function workdaysBack(count, offset = 0) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - 1 - offset);
  while (out.length < count) {
    if (d.getDay() !== 0 && d.getDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  return out.reverse();
}

// ── Datos maestros ────────────────────────────────────────────────────
const PRODUCTS = [
  { key: 'panel', sku: 'SOL-PAN-645', name: 'Panel solar bifacial 645 W', base_price: 520000, cost: 400000, tax: 0, stock: 120 },
  { key: 'inv5', sku: 'SOL-INV-5K', name: 'Inversor on-grid 5 kW', base_price: 4200000, cost: 3300000, tax: 0, stock: 6 },
  { key: 'inv10', sku: 'SOL-INV-10K', name: 'Inversor on-grid trifásico 10 kW', base_price: 7900000, cost: 6200000, tax: 0, stock: 6 },
  { key: 'hyb', sku: 'SOL-INV-HYB6', name: 'Inversor híbrido 6 kW con cargador', base_price: 6100000, cost: 4800000, tax: 0, stock: 4 },
  { key: 'bat', sku: 'SOL-BAT-LFP5', name: 'Batería litio LiFePO4 5,12 kWh', base_price: 7400000, cost: 5900000, tax: 0, stock: 6 },
  { key: 'est', sku: 'SOL-EST-AL', name: 'Estructura de aluminio por panel', base_price: 95000, cost: 70000, tax: 19, stock: 120 },
  { key: 'cable', sku: 'SOL-CAB-6MM', name: 'Cable solar fotovoltaico 6 mm² (metro)', base_price: 6800, cost: 4300, tax: 19, stock: 1500, unit: 'MT' },
  { key: 'mc4', sku: 'SOL-MC4-PAR', name: 'Conector MC4 (par)', base_price: 12000, cost: 6500, tax: 19, stock: 150 },
  { key: 'dc', sku: 'SOL-PRO-DC', name: 'Tablero de protecciones DC (fusibles + DPS)', base_price: 980000, cost: 690000, tax: 19, stock: 8 },
  { key: 'ac', sku: 'SOL-PRO-AC', name: 'Tablero de protecciones AC (breaker + DPS)', base_price: 760000, cost: 520000, tax: 19, stock: 8 },
  { key: 'meter', sku: 'SOL-MED-BID', name: 'Medidor bidireccional certificado', base_price: 1350000, cost: 980000, tax: 19, stock: 4 },
  // Sin stock a propósito: muestra faltantes y el pedido al proveedor.
  { key: 'lum', sku: 'SOL-LUM-100', name: 'Luminaria solar todo en uno 100 W', base_price: 890000, cost: 610000, tax: 19, stock: 0 },
  { key: 'poste', sku: 'SOL-POS-6M', name: 'Poste metálico galvanizado 6 m', base_price: 1150000, cost: 820000, tax: 19, stock: 0 },
];

const CUSTOMERS = [
  { key: 'dorado', business_name: 'Logística El Dorado SAS', tax_id: '901456789', city: 'Funza', state: 'Cundinamarca', email: 'compras@logisticaeldorado.demo', phone: '6017451200' },
  { key: 'esperanza', first_name: 'Hernán', last_name: 'Valencia Ospina', document_type: '13', customer_type: 'individual', tax_id: '79845123', city: 'La Mesa', state: 'Cundinamarca', email: 'hernan.valencia@correo.demo', phone: '3104567890' },
  { key: 'altos', business_name: 'Conjunto Residencial Altos del Bosque PH', tax_id: '900789321', city: 'Chía', state: 'Cundinamarca', email: 'administracion@altosdelbosque.demo', phone: '6018623300' },
  { key: 'colegio', business_name: 'Colegio San José de Cajicá', tax_id: '860512347', city: 'Cajicá', state: 'Cundinamarca', email: 'rectoria@colegiosanjose.demo', phone: '6018798000' },
  { key: 'vargas', first_name: 'Paola', last_name: 'Vargas Restrepo', document_type: '13', customer_type: 'individual', tax_id: '52987456', city: 'Bogotá', state: 'Bogotá D.C.', email: 'paola.vargas@correo.demo', phone: '3157894561' },
  { key: 'panaderia', business_name: 'Panadería La Espiga Dorada SAS', tax_id: '901223344', city: 'Zipaquirá', state: 'Cundinamarca', email: 'gerencia@laespiga.demo', phone: '6018521100' },
];

const SUPPLIERS = [
  { key: 'andina', name: 'Distribuidora Solar Andina SAS', tax_id: '901112233', city: 'Bogotá', email: 'ventas@solarandina.demo', phone: '6017004000', contact_name: 'Mónica Ríos', payment_terms: 30 },
  { key: 'ferre', name: 'Ferreléctricos de la Sabana SAS', tax_id: '900334455', city: 'Chía', email: 'pedidos@ferrelectricos.demo', phone: '6018617000', contact_name: 'Jorge Lara', payment_terms: 15 },
  { key: 'gruas', name: 'Grúas y Montajes El Puente SAS', tax_id: '900556677', city: 'Mosquera', email: 'servicios@gruaselpuente.demo', phone: '3201234567', contact_name: 'Ricardo Peña', payment_terms: 0 },
];

const EMPLOYEES = [
  { document_number: '1019876543', first_name: 'Andrés', first_surname: 'Moreno', base_salary: 2300000 },
  { document_number: '1022334455', first_name: 'Jhon', first_surname: 'Castañeda', base_salary: 1900000 },
];

// ── Helpers de dominio ────────────────────────────────────────────────
async function ensureCustomer(c) {
  const found = rows(await api('GET', `/customers?search=${encodeURIComponent(c.tax_id)}&limit=20`)).find((x) => String(x.tax_id) === c.tax_id);
  if (found) return found;
  const body = c.business_name
    ? { customer_type: 'company', document_type: '31', business_name: c.business_name, first_name: c.business_name, ...c }
    : c;
  delete body.key;
  return (await api('POST', '/customers', { ...body, country: 'Colombia', retention_config: { withholding_agent: false } })).data;
}

async function ensureSupplier(s) {
  const found = rows(await api('GET', `/inventory/suppliers?search=${encodeURIComponent(s.tax_id)}&limit=20`)).find((x) => String(x.tax_id) === s.tax_id);
  if (found) return found;
  const { key, ...body } = s;
  return (await api('POST', '/inventory/suppliers', { ...body, business_name: s.name, person_type: 'juridica', document_type: '31', country: 'Colombia' })).data;
}

async function ensureProduct(p) {
  const found = rows(await api('GET', `/products?search=${encodeURIComponent(p.sku)}&limit=20`)).find((x) => x.sku === p.sku);
  if (found) return found;
  return (await api('POST', '/products', {
    sku: p.sku, name: p.name, product_type: 'product', base_price: p.base_price, cost: p.cost, average_cost: p.cost,
    has_tax: p.tax > 0, tax_percentage: p.tax, track_inventory: true, unit_of_measure: p.unit === 'MT' ? 'm' : 'unit',
  })).data;
}

async function purchase({ supplier, items, warehouseId, projectId, notes }) {
  const pc = (await api('POST', '/inventory/purchases', {
    supplier_id: supplier.id, payment_terms: supplier.payment_terms ?? 30, notes,
    ...(projectId ? { project_id: projectId } : { warehouse_id: warehouseId }),
    items: items.map((i) => ({ product_id: i.product.id, quantity: i.quantity, unit_cost: i.unit_cost ?? i.product.cost ?? i.product.average_cost, tax_rate: i.tax_rate ?? 19 })),
  })).data;
  await api('PATCH', `/inventory/purchases/${pc.id}/confirm`, {});
  await api('PATCH', `/inventory/purchases/${pc.id}/receive`, {});
  return pc;
}

async function receiveTransfer(transferId) {
  const tr = (await api('GET', `/inventory/transfers/${transferId}`)).data;
  await api('PUT', `/inventory/transfers/${tr.id}/receive`, {
    items: tr.items.map((i) => ({ product_id: i.product_id, quantity_received: i.quantity_sent })),
  });
  return tr;
}

async function dispatchAll(project, fromWarehouseId, items) {
  const d = await api('POST', `/projects/${project.id}/bom/dispatch`, { from_warehouse_id: fromWarehouseId, ...(items ? { items } : {}) });
  const tr = await receiveTransfer(d.data.transfer_id);
  log(`  despacho ${tr.transfer_number} recibido en obra (${tr.items.length} productos)`);
}

async function expense(project, { supplier, category, description, subtotal, tax_rate = 19, days_ago = 3 }) {
  const tax = Math.round(subtotal * tax_rate / 100);
  const e = (await api('POST', '/expenses', {
    category, description, subtotal, tax_rate, tax_amount: tax, total_amount: subtotal + tax,
    project_id: project.id, supplier_id: supplier?.id, expense_date: isoDaysAgo(days_ago),
  })).data;
  log(`  gasto ${e.expense_number || ''} ${description}: ${cop(subtotal + tax)}`);
  return e;
}

async function remision(project, customer, warehouseId, items, notes) {
  const sale = (await api('POST', '/sales', { customer_id: customer.id, warehouse_id: warehouseId, project_id: project.id, notes, items })).data;
  await api('POST', `/sales/${sale.id}/confirm`, { payment_method: 'credito', paid_amount: 0, document_type: 'remision', credit_days: 30 });
  const full = (await api('GET', `/sales/${sale.id}`)).data;
  log(`  remisión ${full.sale_number}: ${cop(full.total_amount)}`);
  return full;
}

// Recorre los estados en orden, saltando los que el proyecto ya alcanzó
// (el primer despacho pasa un proyecto aprobado a "en ejecución" solo).
async function setStatus(project, ...statuses) {
  const current = (await api('GET', `/projects/${project.id}`)).data.status;
  const from = statuses.indexOf(current);
  for (const status of statuses.slice(from + 1)) await api('PATCH', `/projects/${project.id}/status`, { status });
}

// Estudio solar → cotización (por ventas, como el frontend) → aprobada.
async function solarStudy(body, { quote = false, approve = false } = {}) {
  const study = (await api('POST', '/solar/studies', body)).data;
  log(`  estudio ${study.number || study.id}: ${body.title}`);
  if (!quote) return { study };
  const payload = (await api('GET', `/solar/studies/${study.id}/quote-payload`)).data;
  const sale = (await api('POST', '/sales', payload)).data;
  await api('POST', `/solar/studies/${study.id}/link-quote`, { quote_id: sale.id });
  log(`  cotización ${sale.quote_number || sale.sale_number}: ${cop(sale.total_amount)}`);
  if (approve) await api('POST', `/sales/${sale.id}/quote-status`, { status: 'aprobada', approved_by_name: body.approved_by || 'Cliente' });
  return { study, sale };
}

async function irradiance(lat, lon, fallback) {
  try {
    const r = await api('GET', `/solar/irradiance?lat=${lat}&lon=${lon}`);
    return { hsp: r.data.hsp, hsp_monthly: r.data.hsp_monthly, hsp_source: r.data.source || 'nasa_power' };
  } catch (e) {
    log(`  (radiación NASA no disponible: ${e.message}; uso HSP ${fallback})`);
    return { hsp: fallback, hsp_monthly: null, hsp_source: 'manual' };
  }
}

// ── Principal ─────────────────────────────────────────────────────────
async function main() {
  log(`API: ${API}${DRY_RUN ? '  (dry-run)' : ''}`);

  if (!token) {
    const { PITBOX_EMAIL: email, PITBOX_PASSWORD: password, PITBOX_TENANT_ID: tenant_id } = process.env;
    if (!email || !password) throw new Error('Define PITBOX_EMAIL y PITBOX_PASSWORD (o PITBOX_TOKEN)');
    const r = await api('POST', '/auth/login', { email, password, ...(tenant_id ? { tenant_id } : {}) });
    token = r.data.token;
    log(`Sesión: ${r.data.user.email} (${r.data.user.role})`);
  }

  // ── Requisitos ──
  step('Requisitos');
  const tenant = (await api('GET', '/tenant/config')).data;
  const modules = tenant.effective_modules || [];
  log(`Tenant: ${tenant.company_name || tenant.business_name || tenant.slug} · módulos: ${modules.join(', ')}`);
  const missing = ['projects', 'sales', 'inventory'].filter((m) => !modules.includes(m));
  if (missing.length) throw new Error(`El tenant no tiene activos los módulos: ${missing.join(', ')}. Actívalos desde el panel superadmin.`);
  const has = (m) => modules.includes(m);
  if (!has('treasury')) log('  sin Tesorería: se omiten los gastos');
  if (!has('receivables')) log('  sin Cartera: se omiten anticipos');
  if (!has('payroll')) log('  sin Nómina: se omiten técnicos y horas');

  const branches = rows(await api('GET', '/branches'));
  if (!branchId) branchId = (branches.find((b) => b.is_main) || branches[0])?.id;
  if (!branchId) throw new Error('El tenant no tiene sedes');
  const warehouses = rows(await api('GET', '/inventory/warehouses'));
  const mainWh = warehouses.find((w) => w.is_active !== false && !w.project_id && (w.is_main || w.is_default)) || warehouses.find((w) => w.is_active !== false && !w.project_id);
  if (!mainWh) throw new Error('El tenant no tiene bodega principal');
  log(`Sede: ${branches.find((b) => b.id === branchId)?.name} · bodega: ${mainWh.name}`);

  const existing = rows(await api('GET', `/projects?search=${encodeURIComponent('Bodega Logística El Dorado')}`));
  if (existing.some((p) => p.name === NAMES.A)) {
    log(`\nYa existe "${NAMES.A}" (${existing[0].code}): el seed ya corrió en este tenant. No hago nada.`);
    return;
  }
  if (DRY_RUN) { log('\nRequisitos OK. Sin --dry-run crea los datos.'); return; }

  // ── Maestros ──
  step('Clientes, proveedores y productos');
  const cust = {};
  for (const c of CUSTOMERS) cust[c.key] = await ensureCustomer({ ...c });
  const sup = {};
  for (const s of SUPPLIERS) sup[s.key] = { ...(await ensureSupplier(s)), payment_terms: s.payment_terms };
  const prod = {};
  for (const p of PRODUCTS) prod[p.key] = { ...(await ensureProduct(p)), cost: p.cost };
  log(`  ${CUSTOMERS.length} clientes · ${SUPPLIERS.length} proveedores · ${PRODUCTS.length} productos`);

  step('Compra de inventario a bodega principal');
  const stockItems = PRODUCTS.filter((p) => p.stock > 0).map((p) => ({ product: prod[p.key], quantity: p.stock, unit_cost: p.cost, tax_rate: p.tax }));
  const pcStock = await purchase({ supplier: sup.andina, warehouseId: mainWh.id, items: stockItems, notes: 'Compra de inventario para obras del trimestre' });
  log(`  compra ${pcStock.purchase_number} recibida`);

  step('Parámetros del cotizador solar');
  await api('PUT', '/solar/settings', {
    panel_product_id: prod.panel.id, inverter_product_id: prod.inv5.id, panel_watts: 645,
    price_per_kwp: 3900000, labor_pct: 18, electrical_pct: 9, consulting_pct: 5,
  });

  // Técnicos para horas y herramientas (solo con Nómina).
  let techs = [];
  if (has('payroll')) {
    step('Técnicos instaladores');
    let emps = rows(await api('GET', '/projects/labor/employees'));
    for (const e of EMPLOYEES) {
      if (emps.some((x) => x.document_number === e.document_number)) continue;
      await api('POST', '/payroll/employees', {
        document_type: '13', ...e, hire_date: '2026-02-02', contract_type: '2', salary_type: 'ordinario',
        payroll_periodicity: 'mensual', arl_risk_class: 4, payment_method: 'transfer', branch_id: branchId,
      });
      log(`  empleado ${e.first_name} ${e.first_surname}`);
    }
    emps = rows(await api('GET', '/projects/labor/employees'));
    techs = EMPLOYEES.map((e) => emps.find((x) => x.document_number === e.document_number)).filter(Boolean);
  }

  // ── PRY-A: desde el cotizador, en ejecución con corte aprobado ──
  step(`Proyecto A · ${NAMES.A}`);
  const hspA = await irradiance(4.7059, -74.2302, 4.4);
  const { study: studyA, sale: quoteA } = await solarStudy({
    customer_id: cust.dorado.id, title: NAMES.A, system_type: 'ongrid', city: 'Funza', department: 'Cundinamarca',
    address: 'Parque Industrial San Diego, bodega 14', latitude: 4.7059, longitude: -74.2302, ...hspA,
    monthly_kwh: 3900, tariff_kwh: 980, coverage_pct: 100, roof: 'plano', orientation: 'norte', tilt: 10, shading_pct: 3,
    extras: [{ product_id: prod.est.id, quantity: 47 }], approved_by: 'Ing. Sandra Milena Duarte',
  }, { quote: true, approve: true });
  const pA = (await api('POST', `/solar/studies/${studyA.id}/project`)).data;
  await api('PUT', `/projects/${pA.id}`, { retention_pct: 5, site_address: 'Parque Industrial San Diego, bodega 14', start_date: isoDaysAgo(18), end_date_planned: isoDaysAgo(-25), notes: 'Cubierta metálica tipo sándwich. Acceso de grúa por la vía interna.' });
  let projA = (await api('GET', `/projects/${pA.id}`)).data;
  if (projA.status !== 'approved') await setStatus(projA, 'approved');
  log(`  ${projA.code} · contrato ${cop(projA.contract_amount)}`);

  await api('POST', `/projects/${pA.id}/bom`, {
    mode: 'append', update_budget: true,
    rows: [
      { product_id: prod.inv10.id, quantity: 2, unit_cost: 6200000 },
      { product_id: prod.cable.id, quantity: 420, unit_cost: 4300, unit: 'MT' },
      { product_id: prod.mc4.id, quantity: 30, unit_cost: 6500 },
      { product_id: prod.dc.id, quantity: 2, unit_cost: 690000 },
      { product_id: prod.ac.id, quantity: 1, unit_cost: 520000 },
      { product_id: prod.meter.id, quantity: 1, unit_cost: 980000 },
    ],
  });
  // El cotizador propone inversores de 5 kW; para 30 kWp se cambian por dos de 10 kW.
  const bomA = rows(await api('GET', `/projects/${pA.id}/bom`));
  const inv5Line = bomA.find((l) => l.product_id === prod.inv5.id);
  if (inv5Line) await api('DELETE', `/projects/${pA.id}/bom/items/${inv5Line.id}`);
  await api('POST', `/projects/${pA.id}/bom/reserve`, {});
  await dispatchAll(projA, mainWh.id);

  if (has('treasury')) {
    await expense(projA, { supplier: sup.gruas, category: 'honorarios', description: 'Alquiler de grúa telescópica para izaje de paneles', subtotal: 2800000, days_ago: 9 });
    await expense(projA, { supplier: sup.gruas, category: 'transporte', description: 'Transporte de equipos Bogotá - Funza', subtotal: 650000, days_ago: 12 });
  }
  if (has('receivables')) {
    const advance = Math.round(Number(quoteA.total_amount) * 0.4);
    await api('POST', '/customer-advances', { customer_id: cust.dorado.id, amount: advance, method: 'Transferencia', project_id: pA.id, reference_note: `Anticipo 40 % ${projA.code}` });
    log(`  anticipo 40 %: ${cop(advance)}`);
  }

  // Corte 1: equipos en obra y estructura montada (aprobado por el cliente, sin facturar).
  const billingA = (await api('GET', `/projects/${pA.id}/billing`)).data;
  const lineBy = (re) => billingA.lines.find((l) => re.test(l.description));
  const cutItems = [];
  const panelLine = lineBy(/Panel/i);
  const estLine = lineBy(/Estructura/i);
  if (panelLine) cutItems.push({ sale_item_id: panelLine.sale_item_id, qty_cumulative: Math.round(Number(panelLine.qty_contract) * 0.6) });
  if (estLine) cutItems.push({ sale_item_id: estLine.sale_item_id, qty_cumulative: Math.round(Number(estLine.qty_contract) * 0.6) });
  const cut = (await api('POST', `/projects/${pA.id}/cuts`, {
    cut_date: isoDaysAgo(2), period_from: isoDaysAgo(18), period_to: isoDaysAgo(2),
    notes: 'Estructura montada y 60 % de los paneles instalados en cubierta.', items: cutItems,
  })).data;
  await api('POST', `/projects/${pA.id}/cuts/${cut.id}/approve`, { approved_by_name: 'Ing. Sandra Milena Duarte', approved_by_document: '52345678' });
  log(`  corte ${cut.cut_no} aprobado: ${cop(cut.total_amount)} (anticipo ${cop(cut.advance_amount)}, retención ${cop(cut.retention_amount)}) — listo para facturar`);

  // ── PRY-B: terminado y cerrado, facturado por remisión ──
  step(`Proyecto B · ${NAMES.B}`);
  let projB = (await api('POST', '/projects', {
    name: NAMES.B, type: 'offgrid', customer_id: cust.esperanza.id, capacity_kwp: 12, city: 'La Mesa',
    site_address: 'Vereda San Javier, km 4 vía La Mesa - Anapoima', contract_amount: 70333000,
    start_date: isoDaysAgo(45), end_date_planned: isoDaysAgo(10), create_warehouse: true, status: 'approved',
    notes: 'Finca sin red confiable: sistema híbrido con respaldo de baterías.',
  })).data;
  await api('POST', `/projects/${projB.id}/bom`, {
    mode: 'replace', update_budget: true,
    rows: [
      { product_id: prod.panel.id, quantity: 19, unit_cost: 400000 },
      { product_id: prod.hyb.id, quantity: 2, unit_cost: 4800000 },
      { product_id: prod.bat.id, quantity: 4, unit_cost: 5900000 },
      { product_id: prod.est.id, quantity: 19, unit_cost: 70000 },
      { product_id: prod.cable.id, quantity: 180, unit_cost: 4300, unit: 'MT' },
      { product_id: prod.mc4.id, quantity: 12, unit_cost: 6500 },
      { product_id: prod.dc.id, quantity: 1, unit_cost: 690000 },
    ],
  });
  await api('POST', `/projects/${projB.id}/budget`, { category: 'labor', description: 'Instalación y puesta en marcha', budget_amount: 9500000 });
  await api('POST', `/projects/${projB.id}/bom/reserve`, {});
  await dispatchAll(projB, mainWh.id);
  if (has('treasury')) {
    await expense(projB, { supplier: sup.ferre, category: 'otro', description: 'Tubería EMT, cajas y accesorios eléctricos', subtotal: 1350000, days_ago: 30 });
    await expense(projB, { supplier: sup.gruas, category: 'transporte', description: 'Transporte de equipos a la finca', subtotal: 480000, days_ago: 32 });
  }
  // La remisión saca de la bodega de la obra todo lo instalado (queda vacía para cerrar).
  const siteB = rows(await api('GET', `/projects/${projB.id}/site-stock`));
  const priceOf = (pid) => PRODUCTS.find((p) => prod[p.key].id === pid);
  await remision(projB, cust.esperanza, projB.warehouse_id, [
    ...siteB.filter((s) => Number(s.quantity) > 0).map((s) => {
      const p = priceOf(s.product_id);
      return { product_id: s.product_id, quantity: Number(s.quantity), unit_price: p?.base_price, tax_percentage: p?.tax ?? 19 };
    }),
    { item_type: 'free_line', product_name: 'Instalación, cableado y puesta en marcha del sistema híbrido 12 kWp', quantity: 1, unit_price: 14500000, tax_percentage: 19 },
  ], `Suministro e instalación ${projB.code}`);
  await setStatus(projB, 'in_progress', 'completed', 'closed');
  log(`  ${projB.code} cerrado`);

  // ── PRY-C: aprobado, BOM con faltantes y pedido ──
  step(`Proyecto C · ${NAMES.C}`);
  const projC = (await api('POST', '/projects', {
    name: NAMES.C, type: 'comercial', customer_id: cust.altos.id, city: 'Chía',
    site_address: 'Cra 9 # 21-40, parqueadero de visitantes', contract_amount: 46500000,
    start_date: isoDaysAgo(-7), end_date_planned: isoDaysAgo(-30), create_warehouse: true, status: 'approved',
    notes: 'Aprobado en asamblea. 24 luminarias solares en postes de 6 m.',
  })).data;
  // Se carga como el Excel del cliente: la última línea no existe en el catálogo.
  const bomText = [
    'Código\tDescripción\tCantidad\tUnidad\tCosto unitario',
    'SOL-LUM-100\tLuminaria solar 100 W\t24\tUND\t610000',
    'SOL-POS-6M\tPoste galvanizado 6 m\t24\tUND\t820000',
    'SOL-CAB-6MM\tCable 6 mm\t120\tMT\t4300',
    '\tDado en concreto para anclaje de poste\t24\tUND\t95000',
  ].join('\n');
  const previewC = (await api('POST', `/projects/${projC.id}/bom/preview`, { text: bomText })).data;
  await api('POST', `/projects/${projC.id}/bom`, { mode: 'replace', update_budget: true, rows: previewC.rows });
  await api('POST', `/projects/${projC.id}/bom/reserve`, {});
  const bomC = rows(await api('GET', `/projects/${projC.id}/bom`));
  const overrides = Object.fromEntries(bomC.filter((l) => l.product_id).map((l) => [l.id, sup.andina.id]));
  const ol = await api('POST', `/projects/${projC.id}/bom/order-lists`, { supplier_overrides: overrides });
  log(`  BOM ${bomC.length} líneas (1 sin producto) · ${ol.message || 'pedido generado'}`);
  await api('POST', `/projects/${projC.id}/budget`, { category: 'labor', description: 'Montaje de postes y luminarias', budget_amount: 6200000 });
  await api('POST', `/projects/${projC.id}/budget`, { category: 'services', description: 'Obra civil (dados de concreto)', budget_amount: 2280000 });

  // ── PRY-D: en ejecución con sobrecosto ──
  step(`Proyecto D · ${NAMES.D}`);
  let projD = (await api('POST', '/projects', {
    name: NAMES.D, type: 'comercial', customer_id: cust.colegio.id, capacity_kwp: 8, city: 'Cajicá',
    site_address: 'Calle 3 # 7-15, cubierta del bloque administrativo', contract_amount: 36000000,
    start_date: isoDaysAgo(25), end_date_planned: isoDaysAgo(3), create_warehouse: true, status: 'approved',
    alert_warning_pct: 80, alert_critical_pct: 100,
    notes: 'La cubierta de teja de barro exigió refuerzo de estructura no previsto.',
  })).data;
  await api('POST', `/projects/${projD.id}/bom`, {
    mode: 'replace', update_budget: true,
    rows: [
      { product_id: prod.panel.id, quantity: 13, unit_cost: 400000 },
      { product_id: prod.inv5.id, quantity: 1, unit_cost: 3300000 },
      { product_id: prod.est.id, quantity: 13, unit_cost: 70000 },
      { product_id: prod.cable.id, quantity: 90, unit_cost: 4300, unit: 'MT' },
      { product_id: prod.ac.id, quantity: 1, unit_cost: 520000 },
    ],
  });
  await api('POST', `/projects/${projD.id}/budget`, { category: 'labor', description: 'Instalación', budget_amount: 3800000 });
  await api('POST', `/projects/${projD.id}/budget`, { category: 'services', description: 'Refuerzo de cubierta', budget_amount: 1500000 });
  await api('POST', `/projects/${projD.id}/bom/reserve`, {});
  await dispatchAll(projD, mainWh.id);
  // Material comprado directo a la obra por el refuerzo no previsto.
  const pcD = await purchase({ supplier: sup.ferre, projectId: projD.id, items: [{ product: prod.est, quantity: 13, unit_cost: 78000, tax_rate: 19 }], notes: `Estructura adicional por refuerzo de cubierta ${projD.code}` });
  log(`  compra ${pcD.purchase_number} directa a la bodega de la obra`);
  if (has('treasury')) {
    await expense(projD, { supplier: sup.gruas, category: 'honorarios', description: 'Refuerzo estructural de cubierta (subcontrato)', subtotal: 4200000, days_ago: 10 });
    await expense(projD, { category: 'arriendo', description: 'Andamios certificados - alquiler 3 semanas', subtotal: 1100000, days_ago: 15 });
  }
  await remision(projD, cust.colegio, mainWh.id, [
    { item_type: 'free_line', product_name: 'Avance de obra 50 % - suministro de equipos', quantity: 1, unit_price: 18000000, tax_percentage: 0 },
  ], `Primer avance ${projD.code}`);

  // ── Horas de los técnicos ──
  if (techs.length) {
    step('Horas de mano de obra');
    const [t1, t2] = techs;
    for (const d of workdaysBack(10)) {
      await api('POST', `/projects/${pA.id}/time-entries`, { employee_id: t1.id, work_date: d, hours: 9, notes: 'Montaje de estructura y paneles' });
    }
    if (t2) {
      for (const d of workdaysBack(6)) await api('POST', `/projects/${pA.id}/time-entries`, { employee_id: t2.id, work_date: d, hours: 8, notes: 'Cableado DC' });
      for (const d of workdaysBack(6, 8)) await api('POST', `/projects/${projD.id}/time-entries`, { employee_id: t2.id, work_date: d, hours: 9, notes: 'Instalación y refuerzo' });
    }
    log(`  horas registradas en ${projA.code} y ${projD.code}`);
  }

  // ── Herramientas ──
  step('Herramientas');
  const tools = rows(await api('GET', '/tools'));
  const ensureTool = async (body) => tools.find((t) => t.name === body.name) || (await api('POST', '/tools', body)).data;
  const drill = await ensureTool({ name: 'Taladro percutor inalámbrico 1/2"', category: 'Eléctricas', brand: 'DeWalt', model: 'DCD996', serial_number: 'DW-554210', tracking: 'individual', cost_mode: 'zero', acquisition_cost: 980000, acquisition_date: '2026-03-10', usage_rate_daily: 6000, maintenance_interval_months: 6, next_maintenance_date: isoDaysAgo(-20) });
  const harness = await ensureTool({ name: 'Arnés de seguridad con eslinga doble', category: 'Alturas', tracking: 'quantity', quantity_total: 6, cost_mode: 'expense', acquisition_cost: 1800000 });
  await ensureTool({ name: 'Analizador de redes y pinza amperimétrica', category: 'Medición', brand: 'Fluke', model: '376 FC', tracking: 'individual', cost_mode: 'zero', acquisition_cost: 3400000, requires_calibration: true, calibration_interval_months: 12, next_calibration_date: isoDaysAgo(5) });
  const responsible = techs[0] ? { employee_id: techs[0].id } : { responsible_name: 'Cuadrilla de instalación' };
  await api('POST', `/tools/${drill.id}/assign`, { ...responsible, project_id: pA.id, assigned_at: isoDaysAgo(14), expected_return_date: isoDaysAgo(-10), delivery_notes: 'Con maletín, 2 baterías y cargador' }, { allow: [409] });
  await api('POST', `/tools/${harness.id}/assign`, { ...responsible, quantity: 3, project_id: pA.id, assigned_at: isoDaysAgo(14) }, { allow: [409] });
  log('  3 herramientas (taladro y arneses en obra, analizador con calibración vencida)');

  // ── Estudios adicionales del cotizador ──
  step('Estudios del cotizador');
  const hspBog = await irradiance(4.711, -74.0721, 4.2);
  await solarStudy({
    customer_id: cust.vargas.id, title: 'Sistema solar residencial - Casa Vargas', system_type: 'ongrid', city: 'Bogotá', department: 'Bogotá D.C.',
    address: 'Calle 145 # 12-30, casa 8', latitude: 4.711, longitude: -74.0721, ...hspBog,
    monthly_kwh: 420, tariff_kwh: 1010, coverage_pct: 90, roof: 'inclinado', orientation: 'norte', tilt: 15, shading_pct: 8,
  });
  const hspZip = await irradiance(5.0221, -74.0048, 4.3);
  await solarStudy({
    customer_id: cust.panaderia.id, title: 'Autoconsumo panadería - La Espiga Dorada', system_type: 'ongrid', city: 'Zipaquirá', department: 'Cundinamarca',
    address: 'Cra 10 # 4-22', latitude: 5.0221, longitude: -74.0048, ...hspZip,
    monthly_kwh: 1650, tariff_kwh: 950, coverage_pct: 80, roof: 'plano', orientation: 'norte', tilt: 10, shading_pct: 5,
    extras: [{ product_id: prod.est.id, quantity: 18 }],
  }, { quote: true });

  // ── Resumen ──
  step('Resumen');
  for (const p of [pA, projB, projC, projD]) {
    const d = (await api('GET', `/projects/${p.id}`)).data;
    const pnl = (await api('GET', `/projects/${p.id}/pnl`)).data;
    log(`  ${d.code} ${d.status.padEnd(11)} ingresos ${cop(pnl.revenue?.net)} · costos ${cop(pnl.costs?.total)} · margen ${cop(pnl.gross_margin)} — ${d.name}`);
  }
  log('\nListo.');
}

main().catch((e) => { console.error(`\nFALLÓ: ${e.message}`); process.exit(1); });
