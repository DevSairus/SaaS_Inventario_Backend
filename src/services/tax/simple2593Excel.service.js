// Excel del formulario 2593: hoja 1 (liquidación) y una hoja 2 por municipio,
// con número de casilla, nombre y valor, para copiarlo en el servicio de la DIAN.
const ExcelJS = require('exceljs');
const { SHEET1, SHEET2 } = require('./simple2593Layout');

const MONEY = '#,##0';

function header(ws, title, data, receipt) {
  ws.addRow([title]).font = { bold: true, size: 13 };
  ws.addRow([`Año ${data.year} · Bimestre ${String(data.period).padStart(2, '0')} (${data.period_label}) · ${data.date_from} a ${data.date_to}`]);
  ws.addRow([`Estado: ${receipt?.status === 'presentado' ? `presentado${receipt.form_number ? ` (No. ${receipt.form_number})` : ''}` : 'borrador'} · UVT ${data.uvt.toLocaleString('es-CO')} · Valores aproximados al múltiplo de mil`]);
  ws.addRow([]);
}

function sectionRows(ws, sections, boxes) {
  for (const section of sections) {
    const t = ws.addRow(['', section.title]);
    t.font = { bold: true };
    t.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } };
    for (const b of section.boxes) {
      const v = boxes[b.box];
      const row = ws.addRow([b.box, b.label, b.percent ? `${v}%` : Number(v) || 0, b.input ? 'Digitado' : '']);
      if (!b.percent) row.getCell(3).numFmt = MONEY;
    }
  }
}

async function buildSimple2593Excel(data, receipt) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hoja 1 - Liquidación');
  ws.columns = [{ width: 9 }, { width: 78 }, { width: 18 }, { width: 11 }];
  header(ws, 'Formulario 2593 — Recibo electrónico del SIMPLE', data, receipt);
  ws.addRow(['Casilla', 'Concepto', 'Valor', '']).font = { bold: true };
  sectionRows(ws, SHEET1, data.sheet1.boxes);
  ws.addRow([]);
  const total = ws.addRow(['', 'Total a pagar (76 + 77 + 78 + 79)', data.sheet1.total_to_pay]);
  total.font = { bold: true };
  total.getCell(3).numFmt = MONEY;
  if (data.warnings?.length) {
    ws.addRow([]);
    ws.addRow(['', 'Avisos']).font = { bold: true };
    data.warnings.forEach((w) => ws.addRow(['', w]));
  }

  for (const mun of data.sheet2) {
    const name = `Hoja 2 - ${mun.city_name}`.replace(/[\\/*?:[\]]/g, '').slice(0, 31);
    const s = wb.addWorksheet(name);
    s.columns = [{ width: 9 }, { width: 70 }, { width: 18 }, { width: 14 }, { width: 18 }];
    header(s, `Liquidación del componente ICA consolidado — ${mun.city_name}`, data, receipt);
    s.addRow([82, 'Departamento (código DIVIPOLA)', mun.department_code || '']);
    s.addRow([83, 'Municipio (código DIVIPOLA)', mun.city_code || '']);
    s.addRow(['', `Sedes: ${mun.branches}`]);
    s.addRow([]);
    s.addRow(['Casilla', 'Concepto', 'Valor', '']).font = { bold: true };
    sectionRows(s, SHEET2.slice(0, 1), mun.boxes);
    s.addRow([]);
    s.addRow(['', 'Discriminación de actividades gravadas']).font = { bold: true };
    s.addRow(['', '91. Código CIIU — actividad', '92. Ingresos gravados', '93. Tarifa (‰)', '94. Impuesto']).font = { bold: true };
    for (const a of mun.activities) {
      const r = s.addRow(['', `${a.ciiu || 'sin CIIU'} — ${a.description}${a.is_default ? ' (principal)' : ''}`, a.c92, a.rate, a.c94]);
      r.getCell(3).numFmt = MONEY;
      r.getCell(5).numFmt = MONEY;
    }
    s.addRow([]);
    sectionRows(s, SHEET2.slice(1), mun.boxes);
    s.addRow([107, 'Aplicación de tarifa reportada por el municipio o distrito', mun.c107 ? 'X' : '']);
    s.addRow([108, 'Aplicación de tarifa informada por el contribuyente', mun.c108 ? 'X' : '']);
  }
  return wb.xlsx.writeBuffer();
}

module.exports = { buildSimple2593Excel };
