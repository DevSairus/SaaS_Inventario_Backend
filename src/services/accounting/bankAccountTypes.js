// backend/src/services/accounting/bankAccountTypes.js
//
// 5.2 — Cuentas bancarias por clasificación. Cada tipo cuelga de su propia
// cuenta PUC "padre"; la subcuenta dedicada de cada cuenta bancaria se crea
// como hija de esa (111005-01, 112005-01, 111010-01...).
'use strict';

const BANK_ACCOUNT_TYPES = Object.freeze({
  corriente: {
    label: 'Cuenta corriente',
    parentCode: '111005', parentName: 'Bancos - Moneda Nacional',
    groupCode: '1110', groupName: 'Bancos',
  },
  ahorros: {
    label: 'Cuenta de ahorros',
    parentCode: '112005', parentName: 'Cuentas de Ahorro - Bancos',
    groupCode: '1120', groupName: 'Cuentas de Ahorro',
  },
  moneda_extranjera: {
    label: 'Moneda extranjera',
    parentCode: '111010', parentName: 'Bancos - Moneda Extranjera',
    groupCode: '1110', groupName: 'Bancos',
  },
});

const DEFAULT_TYPE = 'corriente';
const LOCAL_CURRENCY = 'COP';

const isValidType = (t) => Object.prototype.hasOwnProperty.call(BANK_ACCOUNT_TYPES, t);

/**
 * Normaliza tipo y moneda y valida su combinación:
 *  - corriente / ahorros → siempre COP.
 *  - moneda_extranjera → exige una moneda ISO de 3 letras distinta de COP.
 * @returns {{ type: string, currency: string }}
 * @throws Error con `statusCode` 400
 */
function resolveTypeAndCurrency(typeInput, currencyInput) {
  const type = typeInput === undefined || typeInput === null || typeInput === '' ? DEFAULT_TYPE : String(typeInput);
  if (!isValidType(type)) {
    const err = new Error(`Tipo de cuenta bancaria inválido. Use: ${Object.keys(BANK_ACCOUNT_TYPES).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const raw = currencyInput === undefined || currencyInput === null ? '' : String(currencyInput).trim().toUpperCase();

  if (type !== 'moneda_extranjera') {
    if (raw && raw !== LOCAL_CURRENCY) {
      const err = new Error('Las cuentas corriente y de ahorros son en pesos (COP). Para otra moneda use el tipo "Moneda extranjera".');
      err.statusCode = 400;
      throw err;
    }
    return { type, currency: LOCAL_CURRENCY };
  }

  if (!/^[A-Z]{3}$/.test(raw) || raw === LOCAL_CURRENCY) {
    const err = new Error('La cuenta en moneda extranjera necesita su moneda (código de 3 letras, p. ej. USD o EUR), distinta de COP.');
    err.statusCode = 400;
    throw err;
  }
  return { type, currency: raw };
}

module.exports = { BANK_ACCOUNT_TYPES, DEFAULT_TYPE, LOCAL_CURRENCY, isValidType, resolveTypeAndCurrency };
