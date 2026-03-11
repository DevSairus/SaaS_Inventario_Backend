// backend/src/routes/publicPdf.routes.js
// Ruta pública (sin auth) para servir PDFs de ventas via enlace temporal.
// El token JWT contiene saleId + tenantId y expira en 48h.

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const { Sale, Customer, SaleItem, Product, Tenant } = require('../models');
const { generateSalePDFBuffer } = require('../services/pdfService');
const logger  = require('../config/logger');

// GET /api/public/pdf/:token
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Verificar y decodificar el token
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Enlace inválido o expirado.' });
    }

    if (payload.type !== 'pdf_share') {
      return res.status(401).json({ success: false, message: 'Token no válido para este recurso.' });
    }

    const { saleId, tenantId } = payload;

    const sale = await Sale.findOne({
      where: { id: saleId, tenant_id: tenantId },
      include: [
        { model: Customer, as: 'customer' },
        { model: SaleItem, as: 'items', include: [{ model: Product, as: 'product' }] },
      ],
    });

    if (!sale) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });

    const tenant = await Tenant.findByPk(tenantId);
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
  } catch (error) {
    logger.error('[PDF público] Error:', error.message);
    res.status(500).json({ success: false, message: 'Error generando el documento.' });
  }
});

module.exports = router;