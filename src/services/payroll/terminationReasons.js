// backend/src/services/payroll/terminationReasons.js
/**
 * Causas de retiro del empleado (6.2) y cálculo SUGERIDO de la indemnización
 * por despido sin justa causa.
 *
 * MEJOR ESFUERZO — Art. 64 del Código Sustantivo del Trabajo (mod. Ley 789 de
 * 2002, Art. 28), salario fijo ordinario:
 *  - Término indefinido, salario < 10 SMLMV: 30 días de salario por el primer
 *    año (o fracción) y 20 días adicionales por cada año subsiguiente al
 *    primero y proporcionalmente por fracción.
 *  - Término indefinido, salario >= 10 SMLMV: 20 días el primer año y 15
 *    adicionales por cada año subsiguiente, proporcional por fracción.
 *  - Término fijo: salarios que faltaban hasta la fecha pactada de
 *    terminación (necesita `contract_end_date`).
 *  - Obra o labor: la ley la mide por lo que falte de la obra; la ficha no
 *    guarda esa fecha, así que no se sugiere monto.
 * No incluye lucro cesante, daño emergente, salario variable ni
 * indemnización moratoria: son valores que decide quien liquida. El monto es
 * una SUGERENCIA; la liquidación usa el valor que la persona confirme.
 */
'use strict';

const TERMINATION_REASONS = {
  renuncia: 'Renuncia voluntaria',
  mutuo_acuerdo: 'Mutuo acuerdo',
  justa_causa: 'Despido con justa causa',
  sin_justa_causa: 'Despido sin justa causa',
  vencimiento_contrato: 'Vencimiento del contrato (no renovación)',
  terminacion_obra: 'Terminación de la obra o labor',
  periodo_prueba: 'Terminación en período de prueba',
  pension: 'Pensión o jubilación',
  fallecimiento: 'Fallecimiento',
  otro: 'Otro',
};

const TERMINATION_REASON_KEYS = Object.keys(TERMINATION_REASONS);

const isValidTerminationReason = (value) => TERMINATION_REASON_KEYS.includes(value);
const terminationReasonLabel = (value) => TERMINATION_REASONS[value] || null;

const round = (n) => Math.round(Number(n) || 0);

/**
 * @param {object} p
 * @param {string} p.reason - clave de TERMINATION_REASONS
 * @param {string} p.contractType - '1' indefinido, '2' fijo, '3' obra/labor, '4' aprendizaje, '5' otro
 * @param {number} p.baseSalary - salario mensual ordinario
 * @param {number} p.serviceDays - días de servicio en base comercial 360 (inclusive)
 * @param {number} p.smlmv - salario mínimo vigente (umbral de 10 SMLMV)
 * @param {number|null} p.remainingDays - días comerciales entre el retiro y la fecha pactada (término fijo)
 * @returns {{ applies: boolean, days: number, amount: number, note: string }}
 */
function calcularIndemnizacionSugerida({
  reason, contractType, baseSalary, serviceDays, smlmv, remainingDays = null,
}) {
  if (reason !== 'sin_justa_causa') {
    return { applies: false, days: 0, amount: 0, note: 'La indemnización solo aplica al despido sin justa causa.' };
  }
  const salary = Number(baseSalary) || 0;
  if (salary <= 0) {
    return { applies: false, days: 0, amount: 0, note: 'El empleado no tiene salario base registrado.' };
  }
  const daily = salary / 30;

  if (contractType === '1') {
    const highSalary = salary >= 10 * (Number(smlmv) || 0);
    const firstYearDays = highSalary ? 20 : 30;
    const extraYearDays = highSalary ? 15 : 20;
    const service = Math.max(0, Number(serviceDays) || 0);
    const extraYears = Math.max(0, service - 360) / 360;
    const days = firstYearDays + extraYearDays * extraYears;
    return {
      applies: true,
      days: Math.round(days * 100) / 100,
      amount: round(daily * days),
      note: `Término indefinido (Art. 64 CST): ${firstYearDays} días el primer año y ${extraYearDays} por cada año adicional, proporcional por fracción.`,
    };
  }

  if (contractType === '2') {
    if (remainingDays === null || remainingDays === undefined) {
      return { applies: true, days: 0, amount: 0, note: 'Contrato a término fijo: registre la fecha de fin del contrato en la ficha para sugerir el valor (salarios que faltaban hasta esa fecha).' };
    }
    const days = Math.max(0, Number(remainingDays) || 0);
    return {
      applies: true,
      days,
      amount: round(daily * days),
      note: 'Término fijo (Art. 64 CST): salarios que faltaban para cumplir el plazo pactado.',
    };
  }

  if (contractType === '3') {
    return { applies: true, days: 0, amount: 0, note: 'Contrato por obra o labor: la indemnización depende de lo que faltaba de la obra; calcúlela aparte e ingrésela manualmente.' };
  }

  return { applies: false, days: 0, amount: 0, note: 'Este tipo de contrato no tiene fórmula de indemnización en el sistema; calcúlela aparte si corresponde.' };
}

module.exports = {
  TERMINATION_REASONS,
  TERMINATION_REASON_KEYS,
  isValidTerminationReason,
  terminationReasonLabel,
  calcularIndemnizacionSugerida,
};
