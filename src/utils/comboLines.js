// backend/src/utils/comboLines.js
//
// Helpers para las líneas de documentos (sale_items / work_order_items) que
// vienen de un Combo. El combo NO es una línea propia: sus componentes se
// guardan como líneas normales que comparten combo_group_id (ver migración
// 2026092901-create-combos). Estos helpers solo cambian la PRESENTACIÓN
// (PDF / XML DIAN) cuando combo_show_breakdown = false.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Campos combo_* saneados desde el body de un ítem. Si no trae un
// combo_group_id válido, la línea es una línea normal.
function pickComboFields(item) {
  const groupId = item?.combo_group_id;
  if (!groupId || !UUID_RE.test(String(groupId))) {
    return { combo_id: null, combo_group_id: null, combo_name: null, combo_quantity: null, combo_show_breakdown: null };
  }
  const qty = parseFloat(item.combo_quantity);
  return {
    combo_id: item.combo_id && UUID_RE.test(String(item.combo_id)) ? item.combo_id : null,
    combo_group_id: groupId,
    combo_name: String(item.combo_name || 'Combo').trim().slice(0, 200) || 'Combo',
    combo_quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
    combo_show_breakdown: item.combo_show_breakdown !== false,
  };
}

// Agrupa líneas en el orden en que aparecen. Devuelve una lista de
// { type: 'line', item } | { type: 'combo', groupId, name, quantity,
// showBreakdown, items, subtotal, taxAmount, total }.
function groupComboLines(items) {
  const entries = [];
  const byGroup = new Map();
  for (const item of items || []) {
    const groupId = item.combo_group_id;
    if (!groupId) {
      entries.push({ type: 'line', item });
      continue;
    }
    let entry = byGroup.get(groupId);
    if (!entry) {
      entry = {
        type: 'combo',
        groupId,
        name: item.combo_name || 'Combo',
        quantity: Number(item.combo_quantity) || 1,
        showBreakdown: item.combo_show_breakdown !== false,
        items: [],
        subtotal: 0,
        taxAmount: 0,
        total: 0,
      };
      byGroup.set(groupId, entry);
      entries.push(entry);
    }
    entry.items.push(item);
    entry.subtotal += Number(item.subtotal) || 0;
    entry.taxAmount += (Number(item.tax_amount) || 0) + (Number(item.inc_amount) || 0);
    entry.total += Number(item.total) || 0;
  }
  return entries;
}

// Para el XML DIAN: los combos con combo_show_breakdown = false se
// convierten en UNA línea por combinación de tarifas (IVA/INC/ICA) -- cada
// InvoiceLine lleva una sola tarifa. Las sumas por tarifa se conservan
// exactas, así que los totales del documento no cambian. Las líneas normales
// y los combos desglosados pasan tal cual.
function collapseComboLinesForDian(items) {
  const out = [];
  for (const entry of groupComboLines(items)) {
    if (entry.type === 'line' || entry.showBreakdown) {
      out.push(...(entry.type === 'line' ? [entry.item] : entry.items));
      continue;
    }

    const buckets = new Map();
    for (const item of entry.items) {
      const key = [Number(item.tax_percentage) || 0, Number(item.inc_rate) || 0, Number(item.ica_rate) || 0].join('|');
      let b = buckets.get(key);
      if (!b) {
        b = {
          tax_percentage: Number(item.tax_percentage) || 0,
          inc_rate: Number(item.inc_rate) || 0,
          ica_rate: Number(item.ica_rate) || 0,
          subtotal: 0, tax_amount: 0, inc_amount: 0, ica_amount: 0, total: 0,
        };
        buckets.set(key, b);
      }
      b.subtotal += Number(item.subtotal) || 0;
      b.tax_amount += Number(item.tax_amount) || 0;
      b.inc_amount += Number(item.inc_amount) || 0;
      b.ica_amount += Number(item.ica_amount) || 0;
      b.total += Number(item.total) || 0;
    }

    const multipleRates = buckets.size > 1;
    let n = 0;
    for (const b of buckets.values()) {
      n += 1;
      const subtotal = round2(b.subtotal);
      // cantidad = nº de combos si el precio unitario queda exacto; si no, 1
      // (LineExtensionAmount debe ser cantidad × precio).
      let quantity = entry.quantity;
      let unitPrice = round2(subtotal / quantity);
      if (round2(unitPrice * quantity) !== subtotal) { quantity = 1; unitPrice = subtotal; }
      out.push({
        id: `${entry.groupId}-${n}`,
        item_type: 'combo',
        product_name: multipleRates ? `${entry.name} (IVA ${b.tax_percentage}%)` : entry.name,
        quantity,
        unit_price: unitPrice,
        subtotal,
        tax_percentage: b.tax_percentage,
        tax_amount: round2(b.tax_amount),
        inc_rate: b.inc_rate,
        inc_amount: round2(b.inc_amount),
        ica_rate: b.ica_rate,
        ica_amount: round2(b.ica_amount),
        total: round2(b.total),
        combo_group_id: entry.groupId,
      });
    }
  }
  return out;
}

// Prefijo del id con que se presenta al cliente un combo "solo nombre y
// total" (cotización pública de venta / ronda de cotización de OT). Al
// responder, expandComboApprovals lo convierte en las líneas del combo.
const COMBO_APPROVAL_PREFIX = 'combo:';

// Líneas tal como las ve el cliente: los combos "solo nombre y total" se
// resumen en una línea (id `combo:<groupId>`, approval_status común o
// 'pendiente' si está mezclado); los desglosados llevan el nombre del combo
// como prefijo. mapItem(item) arma el objeto de cada línea normal.
function presentComboLines(items, mapItem) {
  const out = [];
  for (const entry of groupComboLines(items)) {
    if (entry.type === 'combo' && !entry.showBreakdown) {
      const statuses = new Set(entry.items.map(i => i.approval_status || 'aprobado'));
      out.push({
        id: `${COMBO_APPROVAL_PREFIX}${entry.groupId}`,
        item_type: 'combo',
        product_name: entry.name,
        product_sku: null,
        image_url: null,
        quantity: entry.quantity,
        unit_price: round2(entry.subtotal / (entry.quantity || 1)),
        subtotal: round2(entry.subtotal),
        tax_amount: round2(entry.taxAmount),
        total: round2(entry.total),
        approval_status: statuses.size === 1 ? [...statuses][0] : 'pendiente',
      });
      continue;
    }
    for (const item of entry.type === 'line' ? [entry.item] : entry.items) {
      const mapped = mapItem(item);
      if (entry.type === 'combo') mapped.product_name = `${entry.name} · ${mapped.product_name || ''}`;
      out.push(mapped);
    }
  }
  return out;
}

// approvals [{ item_id, approved, ... }] -> mismas decisiones con los ids
// `combo:<groupId>` reemplazados por cada línea del combo.
function expandComboApprovals(approvals, items) {
  return (approvals || []).flatMap(a => {
    const itemId = String(a?.item_id || '');
    if (!itemId.startsWith(COMBO_APPROVAL_PREFIX)) return [a];
    const groupId = itemId.slice(COMBO_APPROVAL_PREFIX.length);
    return (items || [])
      .filter(i => i.combo_group_id === groupId)
      .map(i => ({ ...a, item_id: i.id }));
  });
}

module.exports = {
  pickComboFields, groupComboLines, collapseComboLinesForDian, presentComboLines, expandComboApprovals,
};
