// Monto en letras para la representación gráfica de factura/remisión
// ("Un millón ciento veinticuatro mil quinientos cincuenta pesos M/CTE.").
// Pesos colombianos sin centavos: el valor se redondea al peso.

const UNITS = ['', 'un', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
  'veinte', 'veintiún', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

// 0–999
function hundreds(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100);
  const rest = n % 100;
  let words = HUNDREDS[h];
  if (rest > 0) {
    let r;
    if (rest < 30) r = UNITS[rest];
    else {
      const t = Math.floor(rest / 10);
      const u = rest % 10;
      r = TENS[t] + (u ? ` y ${UNITS[u]}` : '');
    }
    words = words ? `${words} ${r}` : r;
  }
  return words;
}

// 0–999.999.999.999
function integerToWords(n) {
  if (n === 0) return 'cero';
  const parts = [];
  const billions = Math.floor(n / 1e9);           // miles de millones
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1e3);
  const rest = n % 1e3;

  const millionsBlock = billions * 1000 + millions;
  if (millionsBlock > 0) {
    if (millionsBlock === 1) parts.push('un millón');
    else {
      const high = Math.floor(millionsBlock / 1000);
      const low = millionsBlock % 1000;
      const w = [];
      if (high) w.push(high === 1 ? 'mil' : `${hundreds(high)} mil`);
      if (low) w.push(hundreds(low));
      parts.push(`${w.join(' ')} millones`);
    }
  }
  if (thousands > 0) parts.push(thousands === 1 ? 'mil' : `${hundreds(thousands)} mil`);
  if (rest > 0) parts.push(hundreds(rest));
  return parts.join(' ');
}

function amountInWords(value) {
  const n = Math.round(Math.abs(Number(value) || 0));
  let words = integerToWords(n);
  // "un millón de pesos", "dos millones de pesos" (millón exacto lleva "de").
  const exactMillions = n > 0 && n % 1e6 === 0;
  words = `${words}${exactMillions ? ' de' : ''} ${n === 1 ? 'peso' : 'pesos'} M/CTE.`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

module.exports = { amountInWords };
