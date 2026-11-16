// backend/src/utils/fiscalResponsibilities.js
//
// Responsabilidades fiscales del emisor (Anexo Técnico FE 1.9, tabla
// 13.2.6.1) y tributo del grupo PartyTaxScheme (tabla 13.2.6.2).
//
// dian_config.tax_level_code guarda una o varias responsabilidades separadas
// por ';' (así las pide la DIAN en cbc:TaxLevelCode: "O-15;O-47"). Antes era
// un solo código escrito a mano y, vacío, la factura salía con O-13 (Gran
// contribuyente).

const FISCAL_RESPONSIBILITIES = [
  { code: 'O-13', label: 'Gran contribuyente' },
  { code: 'O-15', label: 'Autorretenedor' },
  { code: 'O-23', label: 'Agente de retención de IVA' },
  { code: 'O-47', label: 'Régimen Simple de Tributación' },
  { code: 'R-99-PN', label: 'No aplica – Otros' },
];
const VALID = FISCAL_RESPONSIBILITIES.map((r) => r.code);

/** Lista ordenada de códigos válidos. Vacío -> ['R-99-PN']. R-99-PN no se combina. */
function parseResponsibilities(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[;,\s]+/);
  const set = new Set(raw.map((c) => String(c).trim().toUpperCase()).filter((c) => VALID.includes(c)));
  if (set.size > 1) set.delete('R-99-PN');
  if (!set.size) return ['R-99-PN'];
  return VALID.filter((c) => set.has(c));
}

function formatResponsibilities(value) {
  return parseResponsibilities(value).join(';');
}

/**
 * Responsable de IVA para la CONTABILIDAD (asientos automáticos). Misma regla
 * que se usaba antes de aceptar varias responsabilidades: sin configurar =
 * responsable; R-99-PN = no responsable.
 */
function isIvaResponsibleForAccounting(cfg) {
  if (!cfg?.tax_level_code) return true;
  return !parseResponsibilities(cfg.tax_level_code).includes('R-99-PN');
}

/**
 * Responsable de IVA para lo que se muestra o se envía a la DIAN: lo dice el
 * "Régimen" de la configuración DIAN (48 responsable / 49 no responsable);
 * sin elegir, se deduce de las responsabilidades.
 */
function isIvaResponsible(cfg) {
  if (cfg?.regime_code === '49') return false;
  if (cfg?.regime_code === '48') return true;
  return isIvaResponsibleForAccounting(cfg);
}

/** Tributo del emisor (tabla 13.2.6.2): 01 IVA, 04 INC, ZA IVA e INC, ZZ No aplica. */
function partyTaxScheme(cfg) {
  const iva = isIvaResponsible(cfg);
  const inc = !!cfg?.inc_responsible;
  if (iva && inc) return { code: 'ZA', name: 'IVA e INC' };
  if (iva) return { code: '01', name: 'IVA' };
  if (inc) return { code: '04', name: 'INC' };
  return { code: 'ZZ', name: 'No aplica' };
}

/**
 * Texto del régimen para la representación gráfica (factura, tirilla):
 * "Responsable de IVA · Régimen Simple de Tributación · Autorretenedor".
 * null si el tenant nunca configuró nada.
 */
function regimeLabel(cfg) {
  if (!cfg?.tax_level_code && !cfg?.regime_code) return null;
  const parts = [isIvaResponsible(cfg) ? 'Responsable de IVA' : 'No responsable de IVA'];
  if (cfg?.inc_responsible) parts.push('Responsable de INC');
  for (const code of parseResponsibilities(cfg?.tax_level_code)) {
    if (code === 'R-99-PN') continue;
    parts.push(FISCAL_RESPONSIBILITIES.find((r) => r.code === code).label);
  }
  return parts.join(' · ');
}

module.exports = {
  FISCAL_RESPONSIBILITIES,
  parseResponsibilities,
  formatResponsibilities,
  isIvaResponsible,
  isIvaResponsibleForAccounting,
  partyTaxScheme,
  regimeLabel,
};
