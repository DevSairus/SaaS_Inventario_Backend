// Excel guardado por openpyxl: las notas de celda quedan en
// /xl/comments/comment1.xml con destino absoluto y ExcelJS 4.x revienta con
// "Cannot read properties of undefined (reading 'comments')". loadXlsx las
// quita y reintenta.
const ExcelJS = require('exceljs');
const AdmZip = require('adm-zip');
const { loadXlsx } = require('../utils/loadXlsx');

async function openpyxlStyleBuffer() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Clientes');
  ws.addRow(['Tipo de documento', 'Número de documento']);
  ws.addRow(['CC', '1110456789']);
  ws.getCell('A1').note = 'CC, NIT, CE...';
  const zip = new AdmZip(Buffer.from(await wb.xlsx.writeBuffer()));

  const comments = zip.getEntries().find((e) => /^xl\/comments\d*\.xml$/.test(e.entryName));
  const vml = zip.getEntries().find((e) => /vmlDrawing\d*\.vml$/.test(e.entryName));
  zip.addFile('xl/comments/comment1.xml', comments.getData());
  zip.addFile('xl/drawings/commentsDrawing1.vml', vml.getData());
  zip.deleteFile(comments.entryName);
  zip.deleteFile(vml.entryName);
  zip.updateFile('xl/worksheets/_rels/sheet1.xml.rels', Buffer.from(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments/comment1.xml" Id="comments"/>'
    + '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="/xl/drawings/commentsDrawing1.vml" Id="anysvml"/>'
    + '</Relationships>'
  ));
  const sheet = zip.getEntry('xl/worksheets/sheet1.xml');
  zip.updateFile(sheet, Buffer.from(sheet.getData().toString('utf8')
    .replace(/<legacyDrawing\b[^>]*\/>/, '<legacyDrawing xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="anysvml"/>')));
  return zip.toBuffer();
}

test('lee un .xlsx con notas al estilo openpyxl', async () => {
  const buffer = await openpyxlStyleBuffer();
  await expect(new ExcelJS.Workbook().xlsx.load(buffer)).rejects.toThrow(/comments/);
  const wb = await loadXlsx(buffer);
  expect(wb.worksheets[0].getCell('B2').value).toBe('1110456789');
});

test('un archivo que no es xlsx conserva el error original', async () => {
  await expect(loadXlsx(Buffer.from('a,b\n1,2\n'))).rejects.toThrow(/zip/i);
});
