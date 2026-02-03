const AuditLog = require('../models/AuditLog');

// Registrar acción en auditoría
const logAudit = async ({
  user_id,
  action,
  table_name,
  record_id,
  old_values,
  new_values,
  ip_address,
  user_agent,
}) => {
  try {
    await AuditLog.create({
      user_id,
      action,
      table_name,
      record_id,
      old_values,
      new_values,
      ip_address,
      user_agent,
    });
  } catch (error) {
    console.error('Error registrando auditoría:', error);
    // No lanzar error para no afectar la operación principal
  }
};

// Funciones específicas por tipo de acción
const logLogin = async (user, req) => {
  await logAudit({
    user_id: user.id,
    action: 'login',
    table_name: 'users',
    record_id: user.id,
    new_values: {
      email: user.email,
      role: user.role,
      timestamp: new Date(),
    },
    ip_address: req.ip || req.connection.remoteAddress,
    user_agent: req.get('user-agent'),
  });
};

const logLogout = async (user, req) => {
  await logAudit({
    user_id: user.id,
    action: 'logout',
    table_name: 'users',
    record_id: user.id,
    new_values: {
      timestamp: new Date(),
    },
    ip_address: req.ip || req.connection.remoteAddress,
    user_agent: req.get('user-agent'),
  });
};

const logCreate = async (user_id, table_name, record_id, new_values, req) => {
  await logAudit({
    user_id,
    action: 'create',
    table_name,
    record_id,
    new_values,
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logUpdate = async (
  user_id,
  table_name,
  record_id,
  old_values,
  new_values,
  req
) => {
  await logAudit({
    user_id,
    action: 'update',
    table_name,
    record_id,
    old_values,
    new_values,
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logDelete = async (user_id, table_name, record_id, old_values, req) => {
  await logAudit({
    user_id,
    action: 'delete',
    table_name,
    record_id,
    old_values,
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logRateApproval = async (user_id, rate_id, action, req) => {
  await logAudit({
    user_id,
    action: `rate_${action}`,
    table_name: 'rates',
    record_id: rate_id,
    new_values: {
      action,
      timestamp: new Date(),
    },
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logPaymentConfirmation = async (user_id, payment_id, amount, req) => {
  await logAudit({
    user_id,
    action: 'payment_confirm',
    table_name: 'payments',
    record_id: payment_id,
    new_values: {
      amount,
      confirmed_at: new Date(),
    },
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logInvoiceIssue = async (user_id, invoice_id, req) => {
  await logAudit({
    user_id,
    action: 'invoice_issue',
    table_name: 'invoices',
    record_id: invoice_id,
    new_values: {
      issued_at: new Date(),
    },
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logPQRSStatusChange = async (
  user_id,
  pqrs_id,
  old_status,
  new_status,
  req
) => {
  await logAudit({
    user_id,
    action: 'pqrs_status_change',
    table_name: 'pqrs',
    record_id: pqrs_id,
    old_values: { status: old_status },
    new_values: { status: new_status },
    ip_address: req?.ip || req?.connection?.remoteAddress,
    user_agent: req?.get('user-agent'),
  });
};

const logSystemAction = async (action, table_name, details) => {
  await logAudit({
    user_id: null, // Sistema
    action,
    table_name,
    new_values: details,
  });
};

module.exports = {
  logAudit,
  logLogin,
  logLogout,
  logCreate,
  logUpdate,
  logDelete,
  logRateApproval,
  logPaymentConfirmation,
  logInvoiceIssue,
  logPQRSStatusChange,
  logSystemAction,
};
