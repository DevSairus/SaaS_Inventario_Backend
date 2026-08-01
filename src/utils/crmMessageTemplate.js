// backend/src/utils/crmMessageTemplate.js
//
// CRM Fase B.3 — resuelve las variables {{cliente}}/{{asesor}}/{{monto}} de
// una plantilla de mensaje. Reemplazo simple de texto, sin motor de
// plantillas: son solo 3 variables conocidas.
const COP = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);

function renderTemplate(body, { cliente, asesor, monto } = {}) {
  return (body || '')
    .replace(/\{\{\s*cliente\s*\}\}/gi, cliente || '')
    .replace(/\{\{\s*asesor\s*\}\}/gi, asesor || '')
    .replace(/\{\{\s*monto\s*\}\}/gi, monto != null ? COP(monto) : '');
}

module.exports = { renderTemplate };
