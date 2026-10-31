// backend/src/controllers/sales/quotes.controller.js
const { Sale, Branch } = require('../../models');
const logger = require('../../config/logger');
const { buildSaleListWhere } = require('./sales.controller');
const { listWorkshopQuoteRows } = require('../workshop/workOrders.controller');
const { parsePagination, buildPagination } = require('../../utils/pagination');

// Profundidad máxima del listado unificado (page * limit). Más allá de esto
// hay que acotar con filtros de fecha.
const MAX_DEPTH = 10000;

// Cotización de venta (document_type='cotizacion' o ya convertida, que
// conserva su COT- en quote_number) al shape de la tabla de QuotesPage.
function fromSale(sale) {
  const converted = sale.document_type !== 'cotizacion' && !!sale.quote_number;
  return {
    id: sale.id,
    source: 'sale',
    converted,
    number: converted ? sale.quote_number : sale.sale_number,
    sale_number: converted ? sale.sale_number : null,
    customer_name: sale.customer_name,
    vehicle_plate: sale.vehicle_plate,
    branch_name: sale.branch?.name || null,
    date: sale.sale_date,
    valid_until: sale.quote_valid_until,
    total_amount: sale.total_amount,
    quote_status: converted ? 'convertida' : sale.quote_status,
  };
}

// Ronda de cotización hecha dentro de una Orden de Trabajo.
function fromWorkshopQuote(q) {
  return {
    id: q.id,
    source: 'workshop',
    work_order_id: q.work_order_id,
    number: q.order_number,
    customer_name: q.customer_name,
    vehicle_plate: q.vehicle_plate,
    branch_name: null,
    date: q.sent_at,
    total_amount: q.total_amount,
    quote_status: q.quote_status,
  };
}

const ts = (d) => (d ? new Date(d).getTime() : 0);

/**
 * GET /api/sales/quotes?page=&limit=&quote_status=&from_date=&to_date=&branch_id=&vehicle_plate=&customer_name=&include_workshop=true
 * Cotizaciones de Ventas + de Taller en un solo listado paginado, ordenado
 * por fecha (más reciente primero). Para la página N se toman las primeras
 * N*limit de cada fuente (de ventas solo id y fecha; de taller ya en SQL),
 * se mezclan y se corta la página; luego se cargan completas solo las
 * ventas de esa página.
 */
const list = async (req, res) => {
  try {
    const pg = parsePagination(req.query);
    const depth = pg.offset + pg.limit;
    if (depth > MAX_DEPTH) {
      return res.status(400).json({ success: false, message: 'Página demasiado lejana: acota la búsqueda con un rango de fechas' });
    }
    const { quote_status, include_workshop } = req.query;

    // Mismos filtros que GET /sales?quote_view=true (sede, remisiones, etc.)
    const saleReq = Object.create(req);
    saleReq.query = { ...req.query, quote_view: 'true' };
    const { where } = buildSaleListWhere(saleReq);

    const saleOrder = [['sale_date', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']];
    const [saleKeys, saleTotal] = await Promise.all([
      Sale.findAll({ where, attributes: ['id', 'sale_date'], order: saleOrder, limit: depth, raw: true }),
      Sale.count({ where }),
    ]);

    // 'convertida' solo existe en cotizaciones de venta.
    const withWorkshop = include_workshop === 'true' && quote_status !== 'convertida';
    const { rows: workshopRows, total: workshopTotal } = withWorkshop
      ? await listWorkshopQuoteRows(req.user.tenant_id, { ...req.query, status: quote_status }, { limit: depth, offset: 0 })
      : { rows: [], total: 0 };

    // Mezcla de dos listas ya ordenadas (las ventas ganan en empate, como
    // el sort estable que hacía antes el navegador).
    const merged = [];
    let i = 0;
    let j = 0;
    while (merged.length < depth && (i < saleKeys.length || j < workshopRows.length)) {
      const s = saleKeys[i];
      const w = workshopRows[j];
      if (s && (!w || ts(s.sale_date) >= ts(w.sent_at))) { merged.push({ source: 'sale', id: s.id }); i++; }
      else { merged.push({ source: 'workshop', row: w }); j++; }
    }
    const pageItems = merged.slice(pg.offset, depth);

    const saleIds = pageItems.filter(x => x.source === 'sale').map(x => x.id);
    const sales = saleIds.length
      ? await Sale.findAll({
        where: { id: saleIds },
        attributes: ['id', 'document_type', 'quote_number', 'sale_number', 'customer_name', 'vehicle_plate', 'sale_date', 'quote_valid_until', 'total_amount', 'quote_status'],
        include: [{ model: Branch, as: 'branch', attributes: ['id', 'name'] }],
      })
      : [];
    const saleById = new Map(sales.map(s => [s.id, s.toJSON()]));

    const data = pageItems
      .map(x => (x.source === 'sale' ? (saleById.has(x.id) ? fromSale(saleById.get(x.id)) : null) : fromWorkshopQuote(x.row)))
      .filter(Boolean);

    res.json({ success: true, data, pagination: buildPagination(pg, saleTotal + workshopTotal) });
  } catch (error) {
    logger.error('Error listando cotizaciones:', error);
    res.status(500).json({ success: false, message: 'Error al obtener cotizaciones' });
  }
};

module.exports = { list };
