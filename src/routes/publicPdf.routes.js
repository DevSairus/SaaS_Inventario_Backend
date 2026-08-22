// backend/src/routes/publicPdf.routes.js
// Ruta pública (sin auth) para servir PDFs de ventas via enlace persistente.
// El token es el Sale.share_token (UUID) guardado en BD -- se genera una
// sola vez (ver sales.controller.js#sendWhatsApp) y sigue sirviendo el PDF
// indefinidamente, sin expiración. Para revocarlo basta con limpiar
// share_token de la venta.
//
// Sin sesión de tenant no sabemos a qué schema pertenece la venta (mismo
// problema que resuelve resolveWorkOrderSchemaByToken en
// workOrders.controller.js): hay que buscar el token en "public"."sales" y,
// si no aparece, recorrer el schema de cada tenant ya migrado.

const express = require('express');
const router  = express.Router();
const { runWithTenantSchema } = require('../config/tenantContext');
const { Sale, Customer, SaleItem, Product, Vehicle, Tenant, SaleDiagnosisMark, DiagramTemplate } = require('../models');
const { generateSalePDFBuffer } = require('../services/pdfService');
const { resolveSaleSchemaByToken } = require('../controllers/sales/sales.controller');
const logger  = require('../config/logger');

// GET /api/public/pdf/:token
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    let resolved;
    try {
      resolved = await resolveSaleSchemaByToken(token);
    } catch {
      return res.status(503).json({ success: false, message: 'Función no disponible aún' });
    }

    if (!resolved) {
      return res.status(404).json({ success: false, message: 'Documento no encontrado.' });
    }

    return runWithTenantSchema(resolved.schemaName, () => servePdfBody(resolved.saleId, res));
  } catch (error) {
    logger.error('[PDF público] Error:', error.message);
    res.status(500).json({ success: false, message: 'Error generando el documento.' });
  }
});

// Cuerpo real, corriendo ya dentro del schema correcto (ver runWithTenantSchema
// arriba) -- todas las queries ORM de acá para abajo resuelven solas contra
// ese schema vía el getter dinámico de registerTenantSchemaHooks.js.
async function servePdfBody(saleId, res) {
  const sale = await Sale.findOne({
    where: { id: saleId },
    include: [
      { model: Customer, as: 'customer' },
      { model: SaleItem, as: 'items', include: [{ model: Product, as: 'product', include: [{ model: Vehicle, as: 'vehicle' }] }] },
      { model: SaleDiagnosisMark, as: 'diagnosis_marks', include: [{ model: DiagramTemplate, as: 'diagram_template' }] },
    ],
  });

  if (!sale) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

  const tenant = await Tenant.findByPk(sale.tenant_id);
  if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado.' });

  const TYPES = { factura: 'Factura', remision: 'Remision', cotizacion: 'Cotizacion' };
  const docLabel = TYPES[sale.document_type] || 'Documento';
  const filename = `${docLabel}-${sale.sale_number}.pdf`;

  const pdfBuffer = await generateSalePDFBuffer(sale, tenant);

  res.set({
    'Content-Type':        'application/pdf',
    'Content-Disposition': `inline; filename="${filename}"`,
    'Content-Length':      pdfBuffer.length,
    'Cache-Control':       'no-store',
  });

  res.send(pdfBuffer);
  logger.info(`[PDF público] Servido: ${filename}`);
}

module.exports = router;
