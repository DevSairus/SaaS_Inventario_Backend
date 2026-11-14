// backend/src/services/inventory/warehouseLocations.service.js
//
// Ubicación física en bodega (req. 2.2). Reglas de negocio compartidas por el
// controlador de ubicaciones, el de productos y el conteo físico.

'use strict';

const { Op } = require('sequelize');

const httpError = (status, message) => Object.assign(new Error(message), { status });

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/**
 * Código de la ubicación: el que escribió el usuario, o pasillo-estante-nivel.
 * Devuelve null si no hay de dónde sacarlo.
 */
function buildCode({ code, aisle, shelf, level }) {
  const explicit = clean(code);
  if (explicit) return explicit.toUpperCase();
  const parts = [clean(aisle), clean(shelf), clean(level)].filter(Boolean);
  return parts.length ? parts.join('-').toUpperCase() : null;
}

/** Normaliza el cuerpo de crear/editar una ubicación; lanza 400 si es inválido. */
function normalizeLocationInput(body = {}) {
  const aisle = clean(body.aisle);
  const shelf = clean(body.shelf);
  const level = clean(body.level);
  const code = buildCode({ code: body.code, aisle, shelf, level });
  if (!code) throw httpError(400, 'Indica el código de la ubicación o al menos el pasillo, el estante o el nivel');
  if (code.length > 40) throw httpError(400, 'El código de la ubicación no puede superar 40 caracteres');
  const description = clean(body.description);
  if (description && description.length > 200) throw httpError(400, 'La descripción no puede superar 200 caracteres');
  return { code, aisle, shelf, level, description };
}

/**
 * Valida la ubicación que se le quiere asignar a un producto:
 *  - existe y es de la empresa,
 *  - está activa,
 *  - es de la bodega del producto (sin bodega no hay ubicación posible).
 * Devuelve el id a guardar (null = sin ubicación).
 */
async function resolveProductLocation({ WarehouseLocation, tenantId, warehouseId, locationId, transaction }) {
  if (!locationId) return null;
  if (!warehouseId) throw httpError(400, 'Para asignar una ubicación el producto debe tener bodega');
  const loc = await WarehouseLocation.findOne({ where: { id: locationId, tenant_id: tenantId }, transaction });
  if (!loc) throw httpError(400, 'La ubicación indicada no existe');
  if (!loc.is_active) throw httpError(400, `La ubicación ${loc.code} está inactiva`);
  if (loc.warehouse_id !== warehouseId) throw httpError(400, `La ubicación ${loc.code} pertenece a otra bodega distinta a la del producto`);
  return loc.id;
}

/**
 * Genera las combinaciones pasillo × estante × nivel de una carga masiva.
 * aisles: ['A','B']   shelves / levels: cantidad (1..n) o lista explícita.
 * Máximo 500 ubicaciones por carga. Los estantes se rellenan a 2 dígitos
 * ("A-01-1") para que ordenen bien como texto.
 */
function expandRanges({ aisles, shelves, levels }) {
  const list = (v, pad) => {
    if (Array.isArray(v)) return v.map(clean).filter(Boolean);
    const n = parseInt(v, 10);
    if (Number.isInteger(n) && n > 0) return Array.from({ length: n }, (_, i) => (pad ? String(i + 1).padStart(2, '0') : String(i + 1)));
    return [];
  };
  const A = list(aisles, false);
  const S = list(shelves, true);
  const L = list(levels, false);
  if (!A.length) throw httpError(400, 'Indica al menos un pasillo');
  const total = A.length * Math.max(S.length, 1) * Math.max(L.length, 1);
  if (total > 500) throw httpError(400, `La carga genera ${total} ubicaciones; el máximo por carga es 500`);
  const out = [];
  for (const a of A) {
    for (const s of (S.length ? S : [null])) {
      for (const l of (L.length ? L : [null])) {
        out.push({ aisle: a, shelf: s, level: l, code: buildCode({ aisle: a, shelf: s, level: l }) });
      }
    }
  }
  return out;
}

/** Orden natural por código ("A-2" antes de "A-10"); sin ubicación al final. */
function compareLocationCodes(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' });
}

/**
 * Ids de la categoría y de todas sus subcategorías (la "familia").
 * Recorre el árbol por niveles con un límite de profundidad por si hubiera un ciclo.
 */
async function categoryFamilyIds({ Category, tenantId, categoryId, transaction }) {
  const ids = new Set([categoryId]);
  let frontier = [categoryId];
  for (let depth = 0; depth < 10 && frontier.length; depth++) {
    const children = await Category.findAll({
      where: { tenant_id: tenantId, parent_id: { [Op.in]: frontier } },
      attributes: ['id'],
      transaction
    });
    frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
    frontier.forEach((id) => ids.add(id));
  }
  return [...ids];
}

module.exports = {
  httpError,
  buildCode,
  normalizeLocationInput,
  resolveProductLocation,
  expandRanges,
  compareLocationCodes,
  categoryFamilyIds,
};
