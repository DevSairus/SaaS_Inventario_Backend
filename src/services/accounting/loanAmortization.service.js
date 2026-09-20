// backend/src/services/accounting/loanAmortization.service.js
//
// Cálculo de la tabla de amortización de un Loan (sistema francés: cuota
// fija, proporción capital/interés variable). Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md — Fase 2.
//
// Fórmula cerrada (no requiere iteración día a día): la tabla completa se
// calcula y se guarda de una sola vez al crear el crédito.
//
// Fechas en UTC a propósito, mismo criterio que
// fixedAssetDepreciation.service.js: `disbursement_date`/`first_payment_date`
// son DATEONLY ('YYYY-MM-DD') y Node los parsea como medianoche UTC sin
// importar la zona horaria del proceso -- usar getters *locales* en un
// proceso corriendo en America/Bogota (UTC-5) puede leer el día anterior.
function pad2(n) { return String(n).padStart(2, '0'); }

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Suma `months` meses a una fecha, en UTC, con el día clampeado al último
 * día del mes destino si el mes destino tiene menos días (ej. 31 de enero +
 * 1 mes -> 28/29 de febrero, no "3 de marzo" como haría un Date normal sin
 * clamping).
 */
function addMonthsClamped(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexado
  const day = date.getUTCDate();

  const targetIndex = month + months;
  const targetYear = year + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth);

  return new Date(Date.UTC(targetYear, targetMonth, targetDay));
}

function toDateOnlyString(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/**
 * Calcula la tabla de amortización completa de un crédito en sistema
 * francés (cuota fija). No toca la base de datos -- devuelve el arreglo de
 * cuotas listo para insertar.
 *
 * @param {object} loan - { principal_amount, annual_interest_rate, term_months, first_payment_date }
 * @returns {Array<{installment_number, due_date, principal_amount, interest_amount, total_amount, balance_after}>}
 */
function computeFrenchAmortizationSchedule(loan) {
  const principal = Number(loan.principal_amount);
  const annualRate = Number(loan.annual_interest_rate);
  const n = Number(loan.term_months);
  const monthlyRate = annualRate / 12 / 100;

  let payment;
  if (monthlyRate === 0) {
    payment = round2(principal / n);
  } else {
    payment = round2((principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n)));
  }

  const firstDate = new Date(loan.first_payment_date);
  const schedule = [];
  let balance = principal;

  for (let k = 1; k <= n; k++) {
    const interest = round2(balance * monthlyRate);
    let principalPortion = round2(payment - interest);
    let totalPortion = round2(principalPortion + interest);
    let balanceAfter = round2(balance - principalPortion);

    // Última cuota: cierra el saldo exacto contra lo que en verdad queda
    // pendiente (absorbe el redondeo acumulado de las n-1 cuotas
    // anteriores) en vez de arrastrar una diferencia de centavos.
    if (k === n) {
      principalPortion = balance;
      totalPortion = round2(principalPortion + interest);
      balanceAfter = 0;
    }

    schedule.push({
      installment_number: k,
      due_date: toDateOnlyString(addMonthsClamped(firstDate, k - 1)),
      principal_amount: principalPortion,
      interest_amount: interest,
      total_amount: totalPortion,
      balance_after: balanceAfter,
    });

    balance = balanceAfter;
  }

  return schedule;
}

/**
 * Genera y guarda la tabla de amortización completa de un crédito recién
 * creado. Se llama una sola vez, dentro de la misma transacción de
 * creación del Loan.
 */
async function generateAmortizationSchedule(loan, tenantId, transaction) {
  const { LoanInstallment } = require('../../models');

  const schedule = computeFrenchAmortizationSchedule(loan);
  const rows = schedule.map((row) => ({ ...row, tenant_id: tenantId, loan_id: loan.id }));

  return LoanInstallment.bulkCreate(rows, { transaction });
}

/**
 * Marca 'vencida' cualquier cuota 'pendiente' cuyo due_date ya pasó.
 * Corrido por el job diario "loan-installments-overdue-check"
 * (jobs/scheduler.js). Solo actualiza el status -- no genera ningún
 * asiento (el asiento del pago solo se genera cuando de verdad se paga).
 */
async function flagOverdueInstallments() {
  const { LoanInstallment } = require('../../models');
  const { Op } = require('sequelize');

  const today = toDateOnlyString(new Date());
  const [count] = await LoanInstallment.update(
    { status: 'vencida' },
    { where: { status: 'pendiente', due_date: { [Op.lt]: today } } }
  );
  return count;
}

module.exports = {
  computeFrenchAmortizationSchedule,
  generateAmortizationSchedule,
  addMonthsClamped,
  toDateOnlyString,
  flagOverdueInstallments,
};
