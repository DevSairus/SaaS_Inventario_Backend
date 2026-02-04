// backend/src/services/pdfService.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * Genera un PDF de venta/factura/remisión y lo envía directamente a la respuesta HTTP
 * @param {Object} res - Objeto de respuesta HTTP de Express
 * @param {Object} sale - Objeto de venta con sus items
 * @param {Object} tenant - Objeto del tenant con datos de la empresa
 */
const generateSalePDF = (res, sale, tenant) => {
  try {
    // Crear documento PDF con márgenes personalizados
    const doc = new PDFDocument({ 
      margin: 40,
      size: 'LETTER',
      bufferPages: true,
      compress: false  // ✨ NUEVO: Desactivar compresión para mejor compatibilidad de impresión
    });

    // ✨ NUEVO: Configurar headers para visualización e impresión directa
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${sale.sale_number}.pdf"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Hacer pipe del PDF directamente a la respuesta
    doc.pipe(res);

    // Colores corporativos
    const primaryColor = '#2563eb';
    const secondaryColor = '#475569';
    const accentColor = '#0ea5e9';
    const lightGray = '#f1f5f9';
    const darkGray = '#1e293b';

    // ==================== ENCABEZADO ====================
    const headerHeight = 120;
    
    // Fondo del encabezado
    doc.rect(0, 0, doc.page.width, headerHeight)
       .fill(primaryColor);

    // Logo del tenant (si existe)
    const logoPath = path.join(__dirname, '../../uploads/logos', tenant.logo_url || 'default-logo.png');
    if (tenant.logo_url && fs.existsSync(logoPath)) {
      try {
        doc.image(logoPath, 50, 20, { 
          width: 80,
          height: 80,
          fit: [80, 80]
        });
      } catch (error) {
        console.error('Error cargando logo:', error);
        // Si falla, continúa sin logo
      }
    }

    // Información de la empresa
    const companyInfoX = tenant.logo_url ? 150 : 50;
    doc.fillColor('#ffffff')
       .fontSize(20)
       .font('Helvetica-Bold')
       .text(tenant.company_name || 'MI EMPRESA', companyInfoX, 30);
    
    doc.fontSize(10)
       .font('Helvetica')
       .text(`NIT: ${tenant.tax_id || 'N/A'}`, companyInfoX, 55);
    
    if (tenant.address) {
      doc.text(tenant.address, companyInfoX, 70);
    }
    
    if (tenant.phone) {
      doc.text(`Tel: ${tenant.phone}`, companyInfoX, 85);
    }
    
    if (tenant.email) {
      doc.text(`Email: ${tenant.email}`, companyInfoX, 100);
    }

    // Tipo de documento y número (lado derecho)
    const docTypeMap = {
      'factura': 'FACTURA DE VENTA',
      'remision': 'REMISIÓN',
      'cotizacion': 'COTIZACIÓN'
    };
    
    const docType = docTypeMap[sale.document_type] || 'DOCUMENTO DE VENTA';
    
    doc.fontSize(16)
       .font('Helvetica-Bold')
       .fillColor('#ffffff')
       .text(docType, 350, 35, { align: 'right', width: 200 });
    
    doc.fontSize(14)
       .font('Helvetica')
       .text(sale.sale_number, 350, 60, { align: 'right', width: 200 });
    
    doc.fontSize(10)
       .text(`Fecha: ${formatDate(sale.sale_date)}`, 350, 85, { align: 'right', width: 200 });

    // ==================== INFORMACIÓN DEL CLIENTE ====================
    let yPos = headerHeight + 30;
    
    // ✨ NUEVO: Calcular altura dinámica del recuadro según los campos presentes
    let clientBoxHeight = 70; // Altura base
    if (sale.Customer?.address || sale.customer_address) clientBoxHeight += 18;
    if (sale.Customer?.phone || sale.customer_phone) clientBoxHeight += 18;
    if (sale.vehicle_plate) clientBoxHeight += 18; // ✨ Espacio para placa
    
    // Recuadro del cliente
    doc.rect(40, yPos, doc.page.width - 80, clientBoxHeight)
       .fillAndStroke(lightGray, secondaryColor)
       .lineWidth(1);
    
    yPos += 15;
    
    doc.fillColor(darkGray)
       .fontSize(12)
       .font('Helvetica-Bold')
       .text('INFORMACIÓN DEL CLIENTE', 55, yPos);
    
    yPos += 20;
    
    doc.fontSize(10)
       .font('Helvetica')
       .text(`Nombre:`, 55, yPos, { continued: true })
       .font('Helvetica-Bold')
       .text(` ${sale.Customer?.name || sale.customer_name || 'N/A'}`, { width: 250 });
    
    doc.font('Helvetica')
       .text(`Identificación:`, 320, yPos, { continued: true })
       .font('Helvetica-Bold')
       .text(` ${sale.Customer?.tax_id || sale.customer_tax_id || 'N/A'}`);
    
    yPos += 18;
    
    // ✨ NUEVO: Mostrar placa de vehículo si existe
    if (sale.vehicle_plate) {
      doc.font('Helvetica')
         .text(`Placa:`, 55, yPos, { continued: true })
         .font('Helvetica-Bold')
         .fillColor(primaryColor)  // Color distintivo para la placa
         .text(` ${sale.vehicle_plate}`, { width: 250 });
      
      doc.fillColor(darkGray);  // Restaurar color
      yPos += 18;
    }
    
    if (sale.Customer?.address || sale.customer_address) {
      doc.font('Helvetica')
         .text(`Dirección:`, 55, yPos, { continued: true })
         .font('Helvetica-Bold')
         .text(` ${sale.Customer?.address || sale.customer_address}`, { width: 500 });
      yPos += 18;
    }
    
    if (sale.Customer?.phone || sale.customer_phone) {
      doc.font('Helvetica')
         .text(`Teléfono:`, 55, yPos, { continued: true })
         .font('Helvetica-Bold')
         .text(` ${sale.Customer?.phone || sale.customer_phone}`);
    }

    // ==================== TABLA DE PRODUCTOS ====================
    yPos += 50;
    
    // Encabezado de la tabla
    const tableTop = yPos;
    const col1X = 50;
    const col2X = 250;
    const col3X = 320;
    const col4X = 390;
    const col5X = 460;
    const col6X = 520;
    
    // Fondo del encabezado
    doc.rect(col1X - 5, tableTop - 5, doc.page.width - 90, 25)
       .fill(accentColor);
    
    // Textos del encabezado
    doc.fillColor('#ffffff')
       .fontSize(10)
       .font('Helvetica-Bold')
       .text('PRODUCTO', col1X, tableTop + 5)
       .text('CANT.', col2X, tableTop + 5)
       .text('PRECIO', col3X, tableTop + 5)
       .text('IVA', col4X, tableTop + 5)
       .text('DESC.', col5X, tableTop + 5)
       .text('TOTAL', col6X, tableTop + 5);
    
    yPos = tableTop + 30;
    
    // Items de la venta
    doc.fillColor(darkGray)
       .font('Helvetica');
    
    const items = sale.SaleItems || sale.items || [];
    
    items.forEach((item, index) => {
      // Alternar color de fondo para mejor lectura
      if (index % 2 === 0) {
        doc.rect(col1X - 5, yPos - 5, doc.page.width - 90, 20)
           .fill('#f8fafc');
        doc.fillColor(darkGray);
      }
      
      const productName = item.Product?.name || item.product_name || 'N/A';
      
      doc.fontSize(9)
         .text(truncateText(productName, 30), col1X, yPos, { width: 190 })
         .text(item.quantity.toString(), col2X, yPos)
         .text(formatCurrency(item.unit_price), col3X, yPos)
         .text(formatCurrency(item.tax_amount), col4X, yPos)
         .text(formatCurrency(item.discount_amount || 0), col5X, yPos)
         .text(formatCurrency(item.total), col6X, yPos);
      
      yPos += 20;
      
      // Nueva página si es necesario
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }
    });
    
    // Línea de separación
    yPos += 10;
    doc.moveTo(col1X - 5, yPos)
       .lineTo(doc.page.width - 45, yPos)
       .strokeColor(secondaryColor)
       .lineWidth(1)
       .stroke();
    
    // ==================== TOTALES ====================
    yPos += 20;
    
    const totalsX = 380;
    
    doc.fillColor(darkGray)
       .fontSize(10)
       .font('Helvetica');
    
    // Subtotal
    doc.text('Subtotal:', totalsX, yPos, { width: 100 })
       .text(formatCurrency(sale.subtotal), totalsX + 100, yPos, { align: 'right', width: 100 });
    
    yPos += 18;
    
    // Descuento
    if (sale.discount_amount > 0) {
      doc.fillColor('#dc2626')
         .text('Descuento:', totalsX, yPos, { width: 100 })
         .text(`-${formatCurrency(sale.discount_amount)}`, totalsX + 100, yPos, { align: 'right', width: 100 });
      yPos += 18;
      doc.fillColor(darkGray);
    }
    
    // IVA
    doc.text('IVA:', totalsX, yPos, { width: 100 })
       .text(formatCurrency(sale.tax_amount), totalsX + 100, yPos, { align: 'right', width: 100 });
    
    yPos += 18;
    
    // Línea antes del total
    doc.moveTo(totalsX, yPos)
       .lineTo(doc.page.width - 45, yPos)
       .strokeColor(secondaryColor)
       .lineWidth(1)
       .stroke();
    
    yPos += 15;
    
    // Total
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor(primaryColor)
       .text('TOTAL:', totalsX, yPos, { width: 100 })
       .text(formatCurrency(sale.total_amount), totalsX + 100, yPos, { align: 'right', width: 100 });

    // ==================== NOTAS ====================
    if (sale.notes) {
      yPos += 40;
      
      doc.fontSize(11)
         .fillColor(darkGray)
         .font('Helvetica-Bold')
         .text('NOTAS:', 50, yPos);
      
      yPos += 20;
      
      doc.fontSize(9)
         .font('Helvetica')
         .text(sale.notes, 50, yPos, { 
           width: doc.page.width - 100,
           align: 'justify'
         });
    }

    // ==================== PIE DE PÁGINA ====================
    const footerY = doc.page.height - 80;
    
    // Línea decorativa
    doc.moveTo(50, footerY)
       .lineTo(doc.page.width - 50, footerY)
       .strokeColor(accentColor)
       .lineWidth(2)
       .stroke();
    
    // Texto del pie
    doc.fontSize(9)
       .fillColor(secondaryColor)
       .font('Helvetica')
       .text('Gracias por su preferencia', 50, footerY + 15, { 
         align: 'center',
         width: doc.page.width - 100
       });
    
    if (tenant.website) {
      doc.fontSize(8)
         .text(tenant.website, 50, footerY + 35, { 
           align: 'center',
           width: doc.page.width - 100
         });
    }
    
    // Número de página
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8)
         .fillColor(secondaryColor)
         .text(
           `Página ${i + 1} de ${range.count}`,
           50,
           doc.page.height - 50,
           { align: 'center', width: doc.page.width - 100 }
         );
    }

    // Finalizar el documento
    doc.end();

  } catch (error) {
    console.error('Error en generateSalePDF:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Error generando PDF',
        error: error.message
      });
    }
  }
};

// ==================== FUNCIONES AUXILIARES ====================

/**
 * Formatea una fecha a formato legible
 */
function formatDate(date) {
  if (!date) return 'N/A';
  const d = new Date(date);
  return d.toLocaleDateString('es-CO', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * Formatea un número como moneda
 */
function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '$0';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
}

/**
 * Trunca texto si es muy largo
 */
function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// ==================== CLASE PDFService (para compatibilidad) ====================

class PDFService {
  async generateRemisionPDF(sale, tenant) {
    return new Promise((resolve, reject) => {
      try {
        const fileName = `${sale.sale_number}.pdf`;
        const uploadDir = path.join(__dirname, '../../uploads/pdfs');
        
        // Crear directorio si no existe
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        
        const filePath = path.join(uploadDir, fileName);
        
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filePath);
        
        doc.pipe(stream);
        
        // Usar la misma lógica mejorada pero escribiendo a archivo
        // (simplificado para este caso)
        
        // Header
        doc.fontSize(20).text(tenant.company_name || 'MI EMPRESA', 50, 50);
        doc.fontSize(10).text(`NIT: ${tenant.tax_id || 'N/A'}`, 50, 75);
        if (tenant.address) {
          doc.text(tenant.address, 50, 90);
        }
        
        // Título
        doc.fontSize(18).text('REMISIÓN DE VENTA', 400, 50);
        doc.fontSize(12).text(sale.sale_number, 400, 75);
        doc.fontSize(10).text(`Fecha: ${formatDate(sale.sale_date)}`, 400, 95);
        
        // Cliente
        doc.fontSize(12).text('CLIENTE:', 50, 150);
        doc.fontSize(10).text(sale.Customer?.name || sale.customer_name || 'N/A', 50, 170);
        doc.text(sale.Customer?.tax_id || sale.customer_tax_id || 'N/A', 50, 185);
        
        // ✨ NUEVO: Placa si existe
        if (sale.vehicle_plate) {
          doc.text(`Placa: ${sale.vehicle_plate}`, 50, 200);
        }
        
        if (sale.Customer?.address || sale.customer_address) {
          doc.text(sale.Customer?.address || sale.customer_address, 50, sale.vehicle_plate ? 215 : 200);
        }
        
        // Tabla de productos
        const tableTop = 280;
        doc.fontSize(10).text('Producto', 50, tableTop);
        doc.text('Cant.', 250, tableTop);
        doc.text('Precio', 320, tableTop);
        doc.text('IVA', 400, tableTop);
        doc.text('Total', 480, tableTop);
        
        doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
        
        let yPosition = tableTop + 25;
        
        const items = sale.SaleItems || sale.items || [];
        items.forEach((item) => {
          doc.text(item.Product?.name || item.product_name || 'N/A', 50, yPosition, { width: 190 });
          doc.text(item.quantity.toString(), 250, yPosition);
          doc.text(formatCurrency(item.unit_price), 320, yPosition);
          doc.text(formatCurrency(item.tax_amount), 400, yPosition);
          doc.text(formatCurrency(item.total), 480, yPosition);
          yPosition += 20;
        });
        
        // Totales
        yPosition += 20;
        doc.moveTo(50, yPosition).lineTo(550, yPosition).stroke();
        yPosition += 15;
        
        doc.text(`Subtotal: ${formatCurrency(sale.subtotal)}`, 400, yPosition);
        yPosition += 20;
        doc.text(`Descuento: -${formatCurrency(sale.discount_amount)}`, 400, yPosition);
        yPosition += 20;
        doc.text(`IVA: ${formatCurrency(sale.tax_amount)}`, 400, yPosition);
        yPosition += 20;
        doc.fontSize(12).text(`TOTAL: ${formatCurrency(sale.total_amount)}`, 400, yPosition);
        
        // Notas
        if (sale.notes) {
          yPosition += 50;
          doc.fontSize(10).text('Notas:', 50, yPosition);
          doc.fontSize(9).text(sale.notes, 50, yPosition + 15, { width: 500 });
        }
        
        // Footer
        doc.fontSize(8).text('Gracias por su compra', 50, 700, { align: 'center' });
        
        doc.end();
        
        stream.on('finish', () => {
          resolve({ filePath, fileName });
        });
        
      } catch (error) {
        reject(error);
      }
    });
  }
}

// Exportar tanto la función como la clase
module.exports = {
  generateSalePDF,
  PDFService: new PDFService()
};