// src/utils/searchText.js
//
// Búsqueda de texto libre ('%palabra%') servida por índices trigram.
//
// Un OR de ILIKE sobre varias columnas solo usa índices si CADA columna
// tiene el suyo; si falta uno, Postgres recorre la tabla completa en cada
// búsqueda (en el POS, en cada tecla). En vez de un índice por columna, se
// indexa UNA expresión que concatena las columnas buscables
// (migración 2026102901-add-search-trgm-indexes.js) y la búsqueda filtra
// por esa misma expresión.
//
// IMPORTANTE: la expresión de la query tiene que ser idéntica a la del
// índice, si no Postgres no lo usa. Por eso ambas salen de SEARCH_COLUMNS:
// si cambias las columnas de una tabla, agrega una migración nueva que
// recree su índice con searchExpression(table).

const { Op } = require('sequelize');
const { sequelize } = require('../config/database');

const SEARCH_COLUMNS = {
  products: ['name', 'sku', 'barcode', 'description'],
  sales: ['sale_number', 'customer_name', 'customer_tax_id', 'customer_email', 'customer_phone', 'vehicle_plate', 'dian_invoice_number'],
  // first_name y last_name juntos y en ese orden: así "juan perez" sigue
  // encontrando a "Juan" + "Perez" igual que el concat_ws de antes.
  customers: ['first_name', 'last_name', 'business_name', 'tax_id', 'email', 'phone'],
  vehicles: ['plate', 'brand', 'model'],
};

// Sin alias: para el CREATE INDEX. Con alias: para la query ("Product"."name").
function searchExpression(table, alias = null) {
  const columns = SEARCH_COLUMNS[table];
  if (!columns) throw new Error(`searchText: tabla sin columnas de búsqueda: ${table}`);
  return columns
    .map((c) => `coalesce(${alias ? `"${alias}".` : ''}"${c}", '')`)
    .join(` || ' ' || `);
}

/**
 * Condición `where` que exige que `term` aparezca en alguna de las columnas
 * buscables de `table`. `alias` es el nombre del modelo en la query
 * (ej. 'Product'), necesario cuando hay includes con columnas homónimas.
 */
function searchMatch(table, alias, term) {
  return sequelize.where(
    sequelize.literal(`(${searchExpression(table, alias)})`),
    { [Op.iLike]: `%${term}%` }
  );
}

module.exports = { SEARCH_COLUMNS, searchExpression, searchMatch };
