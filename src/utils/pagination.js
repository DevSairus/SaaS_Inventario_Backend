// Contrato común de paginación para listados:
//   query:     ?page=1&limit=50
//   respuesta: { data: [...], pagination: { page, limit, total, pages } }
// Aunque el cliente no mande nada, siempre se aplica un limit por defecto y
// un tope máximo, para que un listado olvidado nunca devuelva miles de filas.

const MAX_LIMIT = 200;

function parsePagination(query = {}, { defaultLimit = 50, maxLimit = MAX_LIMIT } = {}) {
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), maxLimit);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  return { page, limit, offset: (page - 1) * limit };
}

function buildPagination({ page, limit }, total) {
  const count = Number(total) || 0;
  return { page, limit, total: count, pages: Math.max(1, Math.ceil(count / limit)) };
}

// Pagina un arreglo ya calculado en memoria (listados que se arman uniendo
// varias fuentes o con cálculos que no se pueden hacer en SQL).
function paginateArray(rows, pg) {
  return {
    data: rows.slice(pg.offset, pg.offset + pg.limit),
    pagination: buildPagination(pg, rows.length),
  };
}

module.exports = { MAX_LIMIT, parsePagination, buildPagination, paginateArray };
