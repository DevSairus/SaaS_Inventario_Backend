// backend/src/services/ensambladora/pdfBranding.js
//
// Cabecera de marca compartida entre cotizacionPdfService.js y
// comprobantePdfService.js -- antes cada uno dibujaba un título centrado
// sin logo ni datos del taller/CSA, muy por debajo del PDF de OT
// (workshopPdfService.js#drawHeader). No se importa drawHeader directo
// porque ese archivo está fuertemente acoplado a WorkOrder (ver comentario
// en cotizacionPdfService.js); esto replica el mismo resultado visual con
// una firma genérica (tenant, title, subtitle, docNumber).
const https = require('https');
const http = require('http');

const C = {
  primary: '#1e40af',
  dark: '#111827',
  gray: '#6b7280',
  lightGray: '#9ca3af',
  border: '#e5e7eb',
  soft: '#f8fafc',
  white: '#ffffff',
  green: '#059669',
  red: '#dc2626',
  orange: '#d97706',
};

const COP = (n) => `$${Number(n || 0).toLocaleString('es-CO')}`;

function fmtFecha(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch {
    return String(d);
  }
}

const downloadImage = (url) =>
  new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const chunks = [];
    proto
      .get(url, (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });

/**
 * Dibuja la cabecera de marca (banda superior + recuadro con logo, datos
 * del CSA/taller y caja de tipo de documento) y devuelve el Y siguiente
 * para seguir dibujando el contenido del documento. `tenant` puede venir
 * null/undefined (ej. si el registro público no logró resolver el tenant) --
 * en ese caso se dibuja igual, solo sin logo ni datos de contacto.
 */
async function drawBrandedHeader(doc, tenant, title, subtitle, docNumber) {
  const MARGIN = 50;
  const PAGE_W = doc.page.width;
  const INNER = PAGE_W - MARGIN * 2;

  doc.rect(0, 0, PAGE_W, 6).fill(C.primary);

  let y = 20;
  doc.roundedRect(MARGIN, y, INNER, 72, 5).strokeColor(C.border).lineWidth(0.5).stroke();
  doc.rect(MARGIN, y, INNER, 72).fill(C.soft);

  let logoW = 0;
  if (tenant?.logo_url) {
    try {
      const src = tenant.logo_url.startsWith('http') ? await downloadImage(tenant.logo_url) : null;
      if (src) {
        doc.image(src, MARGIN + 10, y + 8, { fit: [80, 52], align: 'left', valign: 'center' });
        logoW = 90;
      }
    } catch {
      // sin logo -- se sigue con el nombre solo, no bloquea el PDF
    }
  }

  const EX = MARGIN + logoW + 10;
  const EW = INNER * 0.55;
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(C.dark)
    .text(tenant?.company_name || 'Centro de Servicio Autorizado', EX, y + 10, { width: EW });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.gray);
  let ey = y + 24;
  [tenant?.tax_id ? `NIT: ${tenant.tax_id}` : null, tenant?.phone, tenant?.address, tenant?.email]
    .filter(Boolean)
    .slice(0, 3)
    .forEach((l) => {
      doc.text(l, EX, ey, { width: EW });
      ey += 11;
    });

  const DX = MARGIN + INNER - 155;
  const DOC_BOX_W = 155;
  doc.font('Helvetica-Bold');
  let titleSize = 14;
  while (titleSize > 9 && doc.fontSize(titleSize).widthOfString(title) > DOC_BOX_W - 8) {
    titleSize -= 1;
  }
  doc.fontSize(titleSize).fillColor(C.primary).text(title, DX, y + 6, { width: DOC_BOX_W, align: 'center' });
  const titleH = doc.heightOfString(title, { width: DOC_BOX_W, align: 'center' });
  const subtitleY = y + 6 + titleH + 4;
  if (subtitle) {
    doc.font('Helvetica').fontSize(7.5).fillColor(C.gray).text(subtitle, DX, subtitleY, { width: DOC_BOX_W, align: 'center' });
  }
  if (docNumber) {
    const numY = (subtitle ? subtitleY + 12 : subtitleY) + 4;
    doc.roundedRect(DX, numY, DOC_BOX_W, 22, 4).fill(C.primary);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.white).text(docNumber, DX, numY + 6, { width: DOC_BOX_W, align: 'center' });
  }

  return y + 72 + 14;
}

module.exports = { C, COP, fmtFecha, drawBrandedHeader, downloadImage };
