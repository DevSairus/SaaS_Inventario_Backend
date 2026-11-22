/**
 * Rubros de presentación NIIF para Pymes (Grupo 2, DUR 2420 de 2015, anexo 2).
 *
 * Pitbox lleva UN solo libro (NIIF) con códigos tipo PUC. Cada cuenta se
 * presenta en los estados financieros bajo un rubro:
 *   - Estado de situación financiera (sección 4): activo/pasivo corriente y
 *     no corriente, patrimonio.
 *   - Estado del resultado integral (sección 5): por función del gasto.
 *
 * El rubro de una cuenta se resuelve así (resolveRubro):
 *   1. chart_of_accounts.niif_rubro de la cuenta, si el contador lo fijó.
 *   2. el de su cuenta padre más cercana que lo tenga (heredado).
 *   3. la regla por prefijo PUC más larga que coincida (DEFAULT_RULES).
 *   4. un rubro genérico por account_type (queda marcado como "sin clasificar").
 *
 * Lo que la regla por prefijo no puede saber es el vencimiento: una
 * obligación financiera a más de 12 meses es no corriente. Para eso el
 * contador fija el rubro en la cuenta (o en una subcuenta propia).
 */

// section: grupo dentro del estado. sign: 'debit' si el saldo normal es débito.
const NIIF_RUBROS = [
  // ── Estado de situación financiera ──
  { code: 'efectivo', label: 'Efectivo y equivalentes al efectivo', statement: 'esf', section: 'activo_corriente' },
  { code: 'inversiones_corrientes', label: 'Inversiones corrientes', statement: 'esf', section: 'activo_corriente' },
  { code: 'deudores_comerciales', label: 'Deudores comerciales y otras cuentas por cobrar', statement: 'esf', section: 'activo_corriente' },
  { code: 'activos_impuestos_corrientes', label: 'Activos por impuestos corrientes', statement: 'esf', section: 'activo_corriente' },
  { code: 'inventarios', label: 'Inventarios', statement: 'esf', section: 'activo_corriente' },
  { code: 'otros_activos_corrientes', label: 'Otros activos corrientes', statement: 'esf', section: 'activo_corriente' },

  { code: 'inversiones_no_corrientes', label: 'Inversiones no corrientes', statement: 'esf', section: 'activo_no_corriente' },
  { code: 'deudores_no_corrientes', label: 'Deudores y cuentas por cobrar no corrientes', statement: 'esf', section: 'activo_no_corriente' },
  { code: 'ppe', label: 'Propiedades, planta y equipo', statement: 'esf', section: 'activo_no_corriente' },
  { code: 'propiedades_inversion', label: 'Propiedades de inversión', statement: 'esf', section: 'activo_no_corriente' },
  { code: 'intangibles', label: 'Activos intangibles', statement: 'esf', section: 'activo_no_corriente' },
  { code: 'activo_impuesto_diferido', label: 'Activos por impuestos diferidos', statement: 'esf', section: 'activo_no_corriente' },
  { code: 'otros_activos_no_corrientes', label: 'Otros activos no corrientes', statement: 'esf', section: 'activo_no_corriente' },

  { code: 'obligaciones_financieras_corrientes', label: 'Obligaciones financieras corrientes', statement: 'esf', section: 'pasivo_corriente' },
  { code: 'proveedores_cxp', label: 'Acreedores comerciales y otras cuentas por pagar', statement: 'esf', section: 'pasivo_corriente' },
  { code: 'pasivos_impuestos_corrientes', label: 'Pasivos por impuestos corrientes', statement: 'esf', section: 'pasivo_corriente' },
  { code: 'beneficios_empleados_corrientes', label: 'Beneficios a empleados', statement: 'esf', section: 'pasivo_corriente' },
  { code: 'provisiones_corrientes', label: 'Provisiones corrientes', statement: 'esf', section: 'pasivo_corriente' },
  { code: 'otros_pasivos_corrientes', label: 'Otros pasivos corrientes (anticipos e ingresos diferidos)', statement: 'esf', section: 'pasivo_corriente' },

  { code: 'obligaciones_financieras_no_corrientes', label: 'Obligaciones financieras no corrientes', statement: 'esf', section: 'pasivo_no_corriente' },
  { code: 'cxp_no_corrientes', label: 'Cuentas por pagar no corrientes', statement: 'esf', section: 'pasivo_no_corriente' },
  { code: 'beneficios_empleados_no_corrientes', label: 'Beneficios a empleados no corrientes', statement: 'esf', section: 'pasivo_no_corriente' },
  { code: 'provisiones_no_corrientes', label: 'Provisiones no corrientes', statement: 'esf', section: 'pasivo_no_corriente' },
  { code: 'pasivo_impuesto_diferido', label: 'Pasivos por impuestos diferidos', statement: 'esf', section: 'pasivo_no_corriente' },
  { code: 'otros_pasivos_no_corrientes', label: 'Otros pasivos no corrientes', statement: 'esf', section: 'pasivo_no_corriente' },

  { code: 'capital', label: 'Capital social', statement: 'esf', section: 'patrimonio' },
  { code: 'prima_superavit', label: 'Superávit de capital / prima en colocación', statement: 'esf', section: 'patrimonio' },
  { code: 'reservas', label: 'Reservas', statement: 'esf', section: 'patrimonio' },
  { code: 'resultado_ejercicio', label: 'Resultado del ejercicio', statement: 'esf', section: 'patrimonio' },
  { code: 'ganancias_acumuladas', label: 'Ganancias (pérdidas) acumuladas', statement: 'esf', section: 'patrimonio' },
  { code: 'adopcion_niif', label: 'Ganancias acumuladas por adopción NIIF', statement: 'esf', section: 'patrimonio' },
  { code: 'ori_acumulado', label: 'Otro resultado integral acumulado', statement: 'esf', section: 'patrimonio' },
  { code: 'otras_partidas_patrimonio', label: 'Otras partidas del patrimonio', statement: 'esf', section: 'patrimonio' },

  // ── Estado del resultado integral (por función) ──
  { code: 'ingresos_ordinarios', label: 'Ingresos de actividades ordinarias', statement: 'eri', section: 'ingresos_ordinarios' },
  { code: 'costo_ventas', label: 'Costo de ventas', statement: 'eri', section: 'costo_ventas' },
  { code: 'otros_ingresos', label: 'Otros ingresos', statement: 'eri', section: 'otros_ingresos' },
  { code: 'gastos_ventas', label: 'Gastos de distribución y ventas', statement: 'eri', section: 'gastos_operacionales' },
  { code: 'gastos_administracion', label: 'Gastos de administración', statement: 'eri', section: 'gastos_operacionales' },
  { code: 'otros_gastos', label: 'Otros gastos', statement: 'eri', section: 'otros_gastos' },
  { code: 'ingresos_financieros', label: 'Ingresos financieros', statement: 'eri', section: 'financiero' },
  { code: 'costos_financieros', label: 'Costos financieros', statement: 'eri', section: 'financiero' },
  { code: 'impuesto_ganancias', label: 'Gasto por impuesto a las ganancias', statement: 'eri', section: 'impuesto' },
];

const RUBRO_BY_CODE = Object.fromEntries(NIIF_RUBROS.map((r) => [r.code, r]));

// [prefijo PUC, rubro]. Gana el prefijo más largo.
const DEFAULT_RULES = [
  ['11', 'efectivo'],
  ['12', 'inversiones_corrientes'],
  ['13', 'deudores_comerciales'],
  ['1355', 'activos_impuestos_corrientes'],
  ['14', 'inventarios'],
  ['15', 'ppe'],
  ['16', 'intangibles'],
  ['17', 'otros_activos_no_corrientes'],
  ['1705', 'otros_activos_corrientes'], // gastos pagados por anticipado
  ['171076', 'activo_impuesto_diferido'],
  ['18', 'otros_activos_no_corrientes'],
  ['19', 'otros_activos_no_corrientes'],

  ['21', 'obligaciones_financieras_corrientes'],
  ['22', 'proveedores_cxp'],
  ['23', 'proveedores_cxp'],
  ['2365', 'pasivos_impuestos_corrientes'], // retención en la fuente
  ['2367', 'pasivos_impuestos_corrientes'], // IVA retenido
  ['2368', 'pasivos_impuestos_corrientes'], // ICA retenido
  ['2370', 'beneficios_empleados_corrientes'], // aportes de nómina
  ['2380', 'beneficios_empleados_corrientes'],
  ['24', 'pasivos_impuestos_corrientes'],
  ['25', 'beneficios_empleados_corrientes'],
  ['26', 'provisiones_corrientes'],
  ['27', 'otros_pasivos_corrientes'],
  ['2725', 'pasivo_impuesto_diferido'],
  ['28', 'otros_pasivos_corrientes'],
  ['29', 'otros_pasivos_corrientes'],

  ['31', 'capital'],
  ['32', 'prima_superavit'],
  ['33', 'reservas'],
  ['34', 'otras_partidas_patrimonio'],
  ['35', 'otras_partidas_patrimonio'],
  ['36', 'resultado_ejercicio'],
  ['37', 'ganancias_acumuladas'],
  ['3730', 'adopcion_niif'],
  ['38', 'ori_acumulado'],
  ['380505', 'otras_partidas_patrimonio'], // cuenta puente de saldos de apertura (PUC sembrado de Pitbox)

  ['41', 'ingresos_ordinarios'],
  ['42', 'otros_ingresos'],
  ['4210', 'ingresos_financieros'],
  ['51', 'gastos_administracion'],
  ['52', 'gastos_ventas'],
  ['53', 'otros_gastos'],
  ['5305', 'costos_financieros'],
  ['54', 'impuesto_ganancias'],
  ['6', 'costo_ventas'],
  ['7', 'costo_ventas'],
];

const FALLBACK_BY_TYPE = {
  activo: 'otros_activos_corrientes',
  pasivo: 'otros_pasivos_corrientes',
  patrimonio: 'otras_partidas_patrimonio',
  ingreso: 'otros_ingresos',
  gasto: 'otros_gastos',
  costo: 'costo_ventas',
};

// Qué estado admite cada account_type (un rubro de ESF no sirve para una cuenta de gasto).
const STATEMENT_BY_TYPE = { activo: 'esf', pasivo: 'esf', patrimonio: 'esf', ingreso: 'eri', gasto: 'eri', costo: 'eri' };
const SECTIONS_BY_TYPE = {
  activo: ['activo_corriente', 'activo_no_corriente'],
  pasivo: ['pasivo_corriente', 'pasivo_no_corriente'],
  patrimonio: ['patrimonio'],
  ingreso: ['ingresos_ordinarios', 'otros_ingresos', 'financiero'],
  gasto: ['gastos_operacionales', 'otros_gastos', 'financiero', 'impuesto', 'costo_ventas'],
  costo: ['costo_ventas'],
};

function isRubroValidForType(rubroCode, accountType) {
  const r = RUBRO_BY_CODE[rubroCode];
  if (!r) return false;
  if (r.statement !== STATEMENT_BY_TYPE[accountType]) return false;
  if (rubroCode === 'ingresos_financieros') return accountType === 'ingreso';
  if (rubroCode === 'costos_financieros') return accountType === 'gasto';
  return (SECTIONS_BY_TYPE[accountType] || []).includes(r.section);
}

function ruleRubro(code, accountType) {
  const digits = String(code || '').replace(/\D/g, '');
  let best = null;
  for (const [prefix, rubro] of DEFAULT_RULES) {
    if (digits.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, rubro];
  }
  if (best && isRubroValidForType(best[1], accountType)) return best[1];
  return null;
}

/**
 * Resuelve el rubro de cada cuenta del plan.
 * @param {Array<{id, code, account_type, parent_id, niif_rubro}>} accounts
 * @returns {Map<id, {rubro, source: 'cuenta'|'heredado'|'regla'|'clase'|'sin_clasificar'}>}
 */
function resolveRubros(accounts) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map();
  for (const a of accounts) {
    let rubro = null;
    let source = null;
    if (a.niif_rubro && isRubroValidForType(a.niif_rubro, a.account_type)) {
      rubro = a.niif_rubro; source = 'cuenta';
    } else {
      let p = a.parent_id ? byId.get(a.parent_id) : null;
      const seen = new Set();
      while (p && !seen.has(p.id)) {
        seen.add(p.id);
        if (p.niif_rubro && isRubroValidForType(p.niif_rubro, a.account_type)) { rubro = p.niif_rubro; source = 'heredado'; break; }
        p = p.parent_id ? byId.get(p.parent_id) : null;
      }
    }
    if (!rubro) {
      rubro = ruleRubro(a.code, a.account_type);
      if (rubro) source = 'regla';
    }
    if (!rubro) {
      rubro = FALLBACK_BY_TYPE[a.account_type] || 'otras_partidas_patrimonio';
      // Las clases (1 ACTIVO, 2 PASIVO...) agrupan varios rubros: no son "sin clasificar".
      source = String(a.code || '').replace(/\D/g, '').length <= 1 ? 'clase' : 'sin_clasificar';
    }
    out.set(a.id, { rubro, source });
  }
  return out;
}

// Grupo NIIF de la empresa. Pitbox apunta a Grupo 2 (Pymes); el 3
// (microempresas, contabilidad simplificada) no exige impuesto diferido.
function niifGroupOf(tenant) {
  const g = String(tenant?.business_config?.niif_group || '2');
  return ['2', '3'].includes(g) ? g : '2';
}

module.exports = { NIIF_RUBROS, RUBRO_BY_CODE, DEFAULT_RULES, resolveRubros, isRubroValidForType, ruleRubro, niifGroupOf };
