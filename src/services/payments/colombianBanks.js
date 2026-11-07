// backend/src/services/payments/colombianBanks.js
//
// Bancos y billeteras de Colombia con su código de compensación ACH (el que
// piden los archivos planos de pagos masivos). Copia en
// frontend/src/constants/colombianBanks.js para el selector del proveedor.
// Los códigos deben verificarse contra el manual del banco pagador antes de
// enviar archivos reales: algunos bancos usan su propia tabla.

const BANKS = [
  { code: '1001', name: 'Banco de Bogotá', aliases: ['bogota', 'banco de bogota'] },
  { code: '1002', name: 'Banco Popular', aliases: ['popular'] },
  { code: '1006', name: 'Itaú', aliases: ['itau', 'corpbanca'] },
  { code: '1007', name: 'Bancolombia', aliases: ['bancolombia'] },
  { code: '1009', name: 'Citibank', aliases: ['citibank', 'citi'] },
  { code: '1012', name: 'Banco GNB Sudameris', aliases: ['gnb', 'sudameris'] },
  { code: '1013', name: 'BBVA Colombia', aliases: ['bbva'] },
  { code: '1019', name: 'Scotiabank Colpatria', aliases: ['colpatria', 'scotiabank'] },
  { code: '1023', name: 'Banco de Occidente', aliases: ['occidente'] },
  { code: '1032', name: 'Banco Caja Social', aliases: ['caja social', 'bcsc'] },
  { code: '1040', name: 'Banco Agrario', aliases: ['agrario'] },
  { code: '1047', name: 'Banco Mundo Mujer', aliases: ['mundo mujer'] },
  { code: '1051', name: 'Davivienda', aliases: ['davivienda'] },
  { code: '1052', name: 'Banco AV Villas', aliases: ['av villas', 'avvillas'] },
  { code: '1053', name: 'Banco W', aliases: ['banco w'] },
  { code: '1059', name: 'Bancamía', aliases: ['bancamia'] },
  { code: '1060', name: 'Banco Pichincha', aliases: ['pichincha'] },
  { code: '1061', name: 'Bancoomeva', aliases: ['bancoomeva', 'coomeva'] },
  { code: '1062', name: 'Banco Falabella', aliases: ['falabella'] },
  { code: '1063', name: 'Banco Finandina', aliases: ['finandina'] },
  { code: '1066', name: 'Banco Cooperativo Coopcentral', aliases: ['coopcentral'] },
  { code: '1069', name: 'Banco Serfinanza', aliases: ['serfinanza'] },
  { code: '1070', name: 'Lulo Bank', aliases: ['lulo'] },
  { code: '1283', name: 'Confiar', aliases: ['confiar'] },
  { code: '1507', name: 'Nequi', aliases: ['nequi'] },
  { code: '1551', name: 'Daviplata', aliases: ['daviplata'] },
  { code: '1801', name: 'Movii', aliases: ['movii'] },
];

const normalize = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Banco por nombre libre ("Bancolombia S.A.", "Davivienda") o por código. */
function findBank(value) {
  const v = normalize(value);
  if (!v) return null;
  const byCode = BANKS.find((b) => b.code === v);
  if (byCode) return byCode;
  const exact = BANKS.find((b) => normalize(b.name) === v);
  if (exact) return exact;
  return BANKS.find((b) => b.aliases.some((a) => v.includes(a))) || null;
}

/** 'savings' | 'checking' | null a partir de texto libre ("Ahorros", "Corriente", "CA", "CC"). */
function accountKind(value) {
  const v = normalize(value);
  if (!v) return null;
  if (v.includes('ahorr') || v.startsWith('aho') || v === 'ca' || v === 's' || v.includes('saving') || v.includes('deposito')) return 'savings';
  if (v.includes('corriente') || v.startsWith('corr') || v === 'cc' || v === 'd' || v.includes('checking')) return 'checking';
  return null;
}

module.exports = { BANKS, findBank, accountKind, normalize };
