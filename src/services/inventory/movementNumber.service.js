// backend/src/services/inventory/movementNumber.service.js
//
// Números de movimiento de inventario (MOV-AAAA-NNNNN) desde una secuencia de
// Postgres por año, en el schema del tenant.
//
// Antes cada movimiento buscaba el último número del año con FOR UPDATE: ese
// lock duraba hasta el commit de TODO el documento (venta, compra, traslado,
// conteo), así que dos documentos del mismo tenant no podían confirmarse a la
// vez -- el segundo esperaba al primero completo. Además el orden era por
// texto (después de MOV-AAAA-99999 la numeración se rompía) y el generador de
// OT ni siquiera tomaba el lock (números duplicados bajo concurrencia).
//
// nextval() no bloquea a nadie ni depende del commit. Contrapartida: un número
// tomado por una transacción que después se revierte queda sin usar (huecos).
// Es numeración interna del kárdex, no fiscal, así que no importa.

const { sequelize } = require('../../config/database');
const { getCurrentSchema } = require('../../config/tenantContext');

const ensured = new Set(); // `${schema}.${secuencia}` que ya existen

const sequenceName = (year) => `inventory_movement_number_${year}_seq`;
const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Crea la secuencia del año si no existe, arrancando después del mayor número
// ya usado ese año. Va por fuera de la transacción del llamador: un error de
// DDL ahí la dejaría abortada.
async function ensureSequence(schema, year) {
  const key = `${schema}.${sequenceName(year)}`;
  if (ensured.has(key)) return;
  const qualified = `${quoteIdent(schema)}.${quoteIdent(sequenceName(year))}`;
  const [[{ exists }]] = await sequelize.query(`SELECT to_regclass(:name) IS NOT NULL AS exists`, {
    replacements: { name: qualified },
  });
  if (!exists) {
    const [[{ max }]] = await sequelize.query(`
      SELECT COALESCE(MAX((substring(movement_number FROM :pattern))::bigint), 0) AS max
        FROM ${quoteIdent(schema)}.inventory_movements
       WHERE movement_number LIKE :prefix
    `, { replacements: { pattern: `^MOV-${year}-(\\d+)$`, prefix: `MOV-${year}-%` } });
    try {
      await sequelize.query(`CREATE SEQUENCE IF NOT EXISTS ${qualified} START WITH ${Number(max) + 1}`);
    } catch (err) {
      // Dos procesos creándola a la vez: el segundo choca con el catálogo
      // (unique_violation) aunque use IF NOT EXISTS. Ya existe, que es lo que importa.
      if (err.original?.code !== '23505' && err.parent?.code !== '23505') throw err;
    }
  }
  ensured.add(key);
}

/**
 * Reserva `count` números de movimiento para el tenant activo (schema del
 * contexto). Devuelve un array de strings MOV-AAAA-NNNNN, en orden.
 */
async function nextMovementNumbers(count = 1, { transaction } = {}) {
  if (count <= 0) return [];
  const schema = getCurrentSchema() || 'public';
  const year = new Date().getFullYear();
  await ensureSequence(schema, year);
  let rows;
  try {
    [rows] = await sequelize.query(
      `SELECT nextval(:seq) AS n FROM generate_series(1, :count)`,
      { replacements: { seq: `${quoteIdent(schema)}.${quoteIdent(sequenceName(year))}`, count }, transaction }
    );
  } catch (err) {
    // La secuencia desapareció (schema recreado): olvidarla para que el
    // próximo intento la vuelva a crear.
    if ((err.original?.code || err.parent?.code) === '42P01') ensured.delete(`${schema}.${sequenceName(year)}`);
    throw err;
  }
  return rows
    .map((r) => Number(r.n))
    .sort((a, b) => a - b)
    .map((n) => `MOV-${year}-${String(n).padStart(5, '0')}`);
}

async function nextMovementNumber(options) {
  const [number] = await nextMovementNumbers(1, options);
  return number;
}

module.exports = { nextMovementNumber, nextMovementNumbers };
