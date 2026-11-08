// backend/src/services/solar/energyBillParser.js
//
// Lee el texto (OCR) de una factura de energía colombiana y saca consumo,
// historial de consumo, tarifa, valor, titular, dirección, ciudad, operador,
// periodo y estrato. Reglas del cotizador original (Energia/index.html →
// parseEnergyBill) más el historial: si la factura trae los últimos meses, el
// consumo sugerido es su promedio (dimensiona mejor que un solo mes). Lo que no
// encuentre se ingresa a mano.

const CITIES = ['BOGOTÁ', 'BOGOTA', 'MEDELLÍN', 'MEDELLIN', 'CALI', 'BARRANQUILLA', 'CARTAGENA',
  'BUCARAMANGA', 'MANIZALES', 'PEREIRA', 'IBAGUÉ', 'IBAGUE', 'NEIVA', 'VILLAVICENCIO',
  'PASTO', 'MONTERÍA', 'MONTERIA', 'SINCELEJO', 'POPAYÁN', 'POPAYAN', 'ARMENIA', 'TUNJA',
  'FLORENCIA', 'QUIBDÓ', 'QUIBDO', 'MITÚ', 'SAN ANDRÉS', 'LETICIA', 'MOCOA', 'INÍRIDA',
  'YOPAL', 'ARAUCA', 'PUERTO CARREÑO', 'RIOHACHA', 'VALLEDUPAR', 'SANTA MARTA',
  'CÚCUTA', 'CUCUTA', 'GIRARDOT', 'BELLO', 'ITAGÜÍ', 'ENVIGADO', 'PALMIRA', 'BUENAVENTURA',
  'SOACHA', 'FUSAGASUGÁ', 'TULUÁ', 'PITALITO', 'GARZÓN', 'GARZON', 'ESPINAL', 'HONDA',
  'AGUACHICA', 'OCAÑA', 'BARRANCABERMEJA', 'DUITAMA', 'SOGAMOSO', 'ZIPAQUIRÁ'];

const OPERATORS = ['ELECTRIFICADORA', 'ENEL', 'CODENSA', 'EPM', 'EMCALI', 'ELECTRICARIBE', 'AIR-E', 'AFINIA',
  'CELSIA', 'ENERTOLIMA', 'ESSA', 'ELECTROHUILA', 'CEDELCA', 'CHEC', 'DISPAC', 'EBSA',
  'ENELAR', 'CEDENAR', 'CENS'];

const MONTHS = 'ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|SET|OCT|NOV|DIC';
const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const toInt = (s) => parseInt(String(s).replace(/[.,]/g, ''), 10);
// kWh: "14.611" son miles, "55,33" o "129,99" son decimales (se descartan).
const toKwh = (s) => toInt(String(s).replace(/[.,]\d{1,2}$/, ''));

function parseEnergyBill(text) {
  const r = {};
  const raw = String(text || '');
  const t = raw.toUpperCase();

  // Facturas multiservicio (EPM, Emcali…) pueden no traer energía: sin ningún
  // kWh no hay consumo eléctrico que leer ("Prec M3-Kwh" es del gas).
  const kwhText = t.replace(/M3\s*-\s*KWH/g, '');
  if (!/K\s?W\s?-?\/?\s?H|KILOVATIO/.test(kwhText)) r.no_energy = true;

  // [ \t] y no \s: que el nombre no arrastre la línea siguiente.
  const holder = raw.match(/(?:NOMBRE|TITULAR|CLIENTE|SUSCRIPTOR|USUARIO)[ \t]*:?[ \t]+([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ \t.]{3,60})/i);
  if (holder) r.holder = holder[1].trim().replace(/\s+/g, ' ');

  // Primero el documento del cliente; el NIT suelto suele ser el de la empresa.
  const nitPatterns = [
    /C\.?\s?C\.?\s*\/\s*NIT[ \t:#.]*([0-9][0-9.]{5,13}[-–]?[0-9]?)/i,
    /(?:C[EÉ]DULA|C\.C\.|IDENTIFICACI[OÓ]N)[ \t:#.]*([0-9][0-9.]{5,13}[-–]?[0-9]?)/i,
    /NIT[ \t:#.]*([0-9][0-9.]{5,13}[-–]?[0-9]?)/i,
  ];
  for (const p of nitPatterns) {
    const m = raw.match(p);
    if (m) { r.document = m[1].trim(); break; }
  }

  // "Dirección", "Dirección del predio", "Dirección prestación servicio"… hasta "Municipio".
  const address = raw.match(/DIRECCI[OÓ]N(?:[ \t]+(?:DEL|DE|PRESTACI[OÓ]N|SERVICIO|PREDIO|INMUEBLE|SUMINISTRO|COBRO)){0,3}[ \t]*:?[ \t]+([^\n]{5,90})/i);
  if (address) r.address = address[1].split(/[ \t]+(?:MUNICIPIO|CIUDAD)[ \t]*:/i)[0].trim();

  // Ciudad: la etiquetada; si no, la primera mencionada (sin "Banco de Bogotá").
  const cityLabel = raw.match(/(?:MUNICIPIO|CIUDAD)[ \t]*:[ \t]*([A-Za-zÁÉÍÓÚÑáéíóúñ .]{3,30}?)(?=[ \t]*(?:-|,|\n|$))/im);
  const tCities = t.replace(/BANCO\s+DE\s+BOGOT[AÁ]/g, '');
  const firstCity = CITIES
    .map((c) => ({ c, i: tCities.indexOf(c) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)[0];
  if (cityLabel) r.city = titleCase(cityLabel[1].trim());
  else if (firstCity) r.city = titleCase(firstCity.c);

  const op = OPERATORS.find((o) => t.includes(o));
  if (op) r.operator = op;

  // Consumo del periodo. El OCR suele partir "kWh" ("kW h", "KW-H") o ponerlo
  // en la línea siguiente; el demo original aceptaba cualquier número + kWh.
  // Primero los renglones facturados: el OCR de PDFs a varias columnas mezcla
  // en una línea textos vecinos ("consumo … Meta periodo: 129,99 kWh").
  const KWH = 'K\\s?W\\s?[-/]?\\s?H';
  const kwhPatterns = [
    // Resumen EPM: "Energía 145 Kwh $ 129.350,19"
    new RegExp(`ENERG[IÍ]A[ \\t]+([0-9][0-9.,]{1,8})[ \\t]*${KWH}[ \\t]*\\$`, 'i'),
    // Renglón facturado EPM: "Energía oct-26 145 960,340 $ 139.249,30"
    new RegExp(`ENERG[IÍ]A[ \\t]+(?:${MONTHS})[A-Z]*[-/ ]?\\d{0,4}[ \\t]+([0-9][0-9.]*)[ \\t]+[0-9][0-9.,]*[ \\t]+\\$`, 'i'),
    new RegExp(`CONSUMO[^0-9\\n]*([0-9][0-9.,]{1,8})\\s*${KWH}`, 'i'),
    new RegExp(`ENERG[IÍ]A[^0-9\\n]{0,40}?([0-9][0-9.,]{1,8})\\s*${KWH}`, 'i'),
    /TOTAL\s+CONSUMO[^0-9\n]*([0-9][0-9.,]{1,8})(?!\s*M3)/i,
    new RegExp(`([0-9][0-9.,]{1,8})\\s*(?:${KWH}|KILOVATIO)`, 'i'),
  ];
  for (const p of kwhPatterns) {
    const m = raw.match(p);
    if (m) {
      const v = toKwh(m[1]);
      if (v > 50 && v < 500000) { r.monthly_kwh = v; break; }
    }
  }

  // Historial: "MAY 2026  452 kWh", "Ago-26 510", "SEP  477 KWH"…
  // Sin "kWh" al lado solo se acepta dentro de la sección de histórico: si no,
  // "OCTUBRE 2026" o "25 NOVIEMBRE 2026" pasarían por un consumo de 2026 kWh.
  const history = [];
  const section = raw.search(/HIST[OÓ]RIC|CONSUMOS?\s+ANTERIORES|[UÚ]LTIMOS\s+\d+\s+MESES/i);
  // La sección termina donde empiezan los valores en pesos.
  const histText = section >= 0 ? raw.slice(section, section + 900).split('$')[0] : raw;
  const suffix = section >= 0 ? '(?:[ \\t]*KWH)?' : '[ \\t]*KWH';
  const histRe = new RegExp(`\\b(${MONTHS})[A-Z]*\\.?[ \\t\\-/]*(?:\\d{2,4})?[ \\t:]+([0-9][0-9.,]{1,6})${suffix}\\b`, 'gi');
  let hm;
  while ((hm = histRe.exec(histText)) !== null) {
    const v = toInt(hm[2]);
    if (!/KWH/i.test(hm[0]) && v >= 1990 && v <= 2099) continue; // un año, no un consumo
    if (v > 20 && v < 500000) history.push({ month: hm[1].toUpperCase(), kwh: v });
  }
  // EPM y otras dibujan el histórico como barras: "Histórico de consumos (kWh)",
  // una o dos líneas de valores y debajo los meses. El orden de los valores se
  // pierde en el texto, pero el promedio no depende del orden.
  if (history.length < 3) {
    const chart = raw.match(new RegExp(`HIST[OÓ]RICO[^\\n]*\\(\\s*${KWH}\\s*\\)[^\\n]*\\n((?:[ \\t]*[0-9][0-9.,]*(?:[ \\t]+[0-9][0-9.,]*)*[ \\t]*\\n){1,3})`, 'i'));
    if (chart) {
      const values = chart[1].trim().split(/\s+/).map(toInt).filter((v) => v > 20 && v < 500000);
      if (values.length >= 3) history.splice(0, history.length, ...values.map((kwh) => ({ month: null, kwh })));
    }
  }
  if (history.length >= 3) {
    r.history_kwh = history.slice(-12);
    const avg = Math.round(r.history_kwh.reduce((s, h) => s + h.kwh, 0) / r.history_kwh.length);
    r.average_kwh = avg;
    if (r.monthly_kwh) r.last_month_kwh = r.monthly_kwh;
    r.monthly_kwh = avg;
  }

  // Tarifa $/kWh. "VALOR" solo si dice unitario o kWh: "Valor energía $ 443.402" es el total.
  const tariffPatterns = [
    /(?:TARIFA|PRECIO|COSTO\s+UNITARIO|VALOR\s+(?:KWH|KW\/H|UNITARIO))[^0-9$\n]*\$?\s*([0-9]{3,4}(?:[.,][0-9]{1,4})?)(?![0-9])/i,
    /([0-9]{3,4}(?:[.,][0-9]{1,4})?)\s*(?:\$\s*)?\/\s*KWH/i,
    // Renglón de EPM: "Consumo oct-26  180  892,45  $ 160.641,00" (cantidad, costo unitario, valor).
    new RegExp(`CONSUMO[ \\t]+(?:${MONTHS})[A-Z]*[-/ ]?\\d{0,4}[ \\t]+[0-9][0-9.]*[ \\t]+([0-9]{3,4}(?:,[0-9]{1,4})?)[ \\t]+\\$`, 'i'),
  ];
  for (const p of tariffPatterns) {
    const m = raw.match(p);
    if (m) {
      const v = parseFloat(m[1].replace(',', '.'));
      if (v > 100 && v < 3000) { r.tariff_kwh = Math.round(v * 100) / 100; break; }
    }
  }

  const totalPatterns = [
    /(?:TOTAL\s+A\s+PAGAR|VALOR\s+TOTAL|TOTAL\s+FACTURA)[^0-9$\n]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{2})?)/i,
    /(?:PAGUE|A\s+PAGAR)[^0-9$\n]*\$?\s*([0-9]{1,3}(?:[.,][0-9]{3})+)/i,
  ];
  for (const p of totalPatterns) {
    const m = raw.match(p);
    if (m) {
      // Separador de miles con punto o coma; los centavos (2 dígitos al final) se descartan.
      const v = toInt(m[1].replace(/[.,](\d{2})$/, ''));
      if (v > 1000) { r.bill_total = v; break; }
    }
  }

  const period = raw.match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)[^0-9\n]{0,10}([0-9]{4})/i);
  if (period) r.period = `${titleCase(period[1])} ${period[2]}`;

  const stratum = raw.match(/ESTRATO[ \t:]*([1-6])/i);
  if (stratum) {
    r.stratum = Number(stratum[1]);
    // El estrato solo aplica a usuarios residenciales.
    r.segment = 'residencial';
  } else if (/COMERCIAL|INDUSTRIAL/.test(t)) r.segment = 'comercial';
  else if (/RESIDENCIAL/.test(t)) r.segment = 'residencial';

  // Resumen multiservicio (EPM): "Energía 145 Kwh $ 129.350,19" → valor de la energía.
  const energyLine = raw.match(new RegExp(`ENERG[IÍ]A[^\\n$]{0,20}?([0-9][0-9.,]{1,8})\\s*${KWH}[^\\n$]{0,20}\\$\\s*([0-9]{1,3}(?:[.,][0-9]{3})+(?:[.,][0-9]{2})?)`, 'i'));
  // Si la factura cobra también agua o gas, el total no sirve para estimar la tarifa.
  const multiService = /ACUEDUCTO|ALCANTARILLADO|\bGAS\b/.test(t);

  if (r.no_energy) {
    // Lo que parezca consumo serían m3 de agua o gas.
    for (const k of ['monthly_kwh', 'last_month_kwh', 'history_kwh', 'average_kwh', 'tariff_kwh']) delete r[k];
  } else if (!r.tariff_kwh && energyLine) {
    const v = toInt(energyLine[2].replace(/[.,](\d{2})$/, '')) / toInt(energyLine[1]);
    if (v > 100 && v < 3000) r.tariff_kwh = Math.round(v * 100) / 100;
  } else if (!r.tariff_kwh && !multiService && r.bill_total && (r.last_month_kwh || r.monthly_kwh)) {
    r.tariff_kwh = Math.round(r.bill_total / (r.last_month_kwh || r.monthly_kwh));
  }
  return r;
}

module.exports = { parseEnergyBill };
