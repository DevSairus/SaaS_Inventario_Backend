const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const DOCUMENT_TYPES = {
  factura: { title: 'FACTURA', numberLabel: 'FACTURA No.' },
  remision: { title: 'REMISIÓN', numberLabel: 'REMISIÓN No.' },
  cotizacion: { title: 'COTIZACIÓN', numberLabel: 'COTIZACIÓN No.' }
};

const generateSalePDF = (res, sale, tenant) => {
  try {
    const docType =
      DOCUMENT_TYPES[sale.document_type] || DOCUMENT_TYPES.factura;

    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 40,
      bufferPages: true
    });

    /* ================= HEADERS ================= */
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${docType.title}-${sale.sale_number}.pdf"`
    );
    doc.pipe(res);

    /* ================= COLORES ================= */
    const red = '#8b0000';
    const gray = '#6b7280';
    const lightGray = '#f3f4f6';
    const border = '#d1d5db';
    const black = '#000000';

    /* ================= BARRA SUPERIOR ================= */
    doc.rect(0, 0, doc.page.width, 18).fill(red);

    /* ================= ENCABEZADO ================= */
    let y = 40;

    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .fillColor(black)
      .text(tenant.company_name || 'Nombre de la Empresa', 40, y);

    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(gray)
      .text(`NIT: ${tenant.tax_id || ''}`, 40, y + 14)
      .text(tenant.address || '', 40, y + 28)
      .text(tenant.phone || '', 40, y + 42)
      .text(tenant.email || '', 40, y + 56);

    // Logo
    const logoPath = path.join(
      __dirname,
      '../../uploads/logos',
      tenant.logo_url || ''
    );

    if (tenant.logo_url && fs.existsSync(logoPath)) {
      doc.image(logoPath, 460, y, { width: 60 });
    }

    // Meta documento
    const rightLabelX = 360;
    const rightValueX = 430;
    const rightWidth = 90;

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(gray)
      .text('FECHA', rightLabelX, y + 70, { width: 120 })
      .text(docType.numberLabel, rightLabelX, y + 88, { width: 120 });

    doc
      .font('Helvetica-Bold')
      .fillColor(black)
      .text(formatDate(sale.sale_date), rightValueX, y + 70, {
        width: rightWidth,
        align: 'right'
      })
      .text(sale.sale_number, rightValueX, y + 88, {
        width: rightWidth,
        align: 'right'
      });

    /* ================= TÍTULO ================= */
    y += 120;

    doc
      .font('Helvetica-Bold')
      .fontSize(26)
      .fillColor(gray)
      .text(docType.title, 40, y);

    /* ================= FACTURAR A ================= */
    y += 40;

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(gray)
      .text('FACTURAR A', 40, y);

    doc
      .moveTo(40, y + 12)
      .lineTo(260, y + 12)
      .strokeColor(border)
      .stroke();

    y += 18;

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(black)
      .text(sale.Customer?.name || sale.customer_name || '', 40, y)
      .text(sale.Customer?.address || sale.customer_address || '', 40, y + 14)
      .text(sale.Customer?.phone || sale.customer_phone || '', 40, y + 28)
      .text(sale.Customer?.email || sale.customer_email || '', 40, y + 42);

    /* ================= TABLA ================= */
    y += 80;

    const cols = {
      desc: 40,
      qty: 330,
      price: 390,
      total: 470
    };

    doc.rect(40, y, 480, 22).fill(red);

    doc
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor('#ffffff')
      .text('DESCRIPCIÓN', cols.desc, y + 6)
      .text('CANT.', cols.qty, y + 6)
      .text('PRECIO UNITARIO', cols.price, y + 6)
      .text('TOTAL', cols.total, y + 6);

    y += 24;

    const items = sale.SaleItems || sale.items || [];

    items.forEach((item, index) => {
      if (y > 620) {
        doc.addPage();
        y = 40;
      }

      if (index % 2 === 0) {
        doc.rect(40, y, 480, 20).fill(lightGray);
      }

      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(black)
        .text(item.Product?.name || item.product_name, cols.desc, y + 5, {
          width: 270
        })
        .text(item.quantity, cols.qty, y + 5)
        .text(formatCurrency(item.unit_price), cols.price, y + 5)
        .text(formatCurrency(item.total), cols.total, y + 5);

      doc.rect(40, y, 480, 20).strokeColor(border).stroke();
      y += 20;
    });

    /* ================= TOTALES ================= */
    y += 20;

    const labelX = 330;
    const valueX = 430;
    const valueWidth = 90;

    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(black)
      .text('SUBTOTAL', labelX, y, { width: 90 })
      .text(formatCurrency(sale.subtotal), valueX, y, {
        width: valueWidth,
        align: 'right'
      });

    y += 14;
    doc
      .text('IVA', labelX, y, { width: 90 })
      .text(formatCurrency(sale.tax_amount), valueX, y, {
        width: valueWidth,
        align: 'right'
      });

    y += 14;
    doc
      .text('DESCUENTO', labelX, y, { width: 90 })
      .text(formatCurrency(sale.discount_amount || 0), valueX, y, {
        width: valueWidth,
        align: 'right'
      });

    y += 18;

    doc.moveTo(labelX, y).lineTo(520, y).strokeColor(border).stroke();
    y += 10;

    // TOTAL en UNA sola línea (garantizado)
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(
        sale.document_type === 'cotizacion'
          ? 'TOTAL COTIZADO'
          : 'TOTAL A PAGAR',
        labelX,
        y,
        { width: 120 }
      )
      .text(formatCurrency(sale.total_amount), valueX, y, {
        width: valueWidth,
        align: 'right'
      });

    /* ================= BARRA INFERIOR ================= */
    doc.rect(0, doc.page.height - 18, doc.page.width, 18).fill(red);

    doc.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Error generando PDF' });
    }
  }
};

/* ================= HELPERS ================= */
function formatDate(date) {
  return new Date(date).toLocaleDateString('es-CO');
}

function formatCurrency(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0
  }).format(value || 0);
}

module.exports = { generateSalePDF };
