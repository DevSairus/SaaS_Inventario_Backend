// backend/src/utils/crmRewardMatching.js
//
// CRM — Gamificación, Fase 5. Ver gamificacion-crm-diseno.md §10.1. No
// existe (ni se crea) un enlace manual entre User y Employee: se emparejan
// automáticamente por email o por documento, que son datos que ambos
// modelos ya tienen (User.email/User.cedula, Employee.email/
// Employee.document_number).
//
// Si no hay coincidencia, la recompensa queda en `sin_empleado_vinculado` —
// no bloquea nada más, solo impide la carga automática a nómina hasta que
// el admin corrija el dato en uno de los dos lados.
const { Op } = require('sequelize');

// Normaliza un documento para comparar: solo dígitos y letras, sin puntos
// ni guiones ("1.020.304-5" y "10203045" son el mismo documento).
function normalizeDoc(value) {
  return String(value || '').replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// Empareja una lista de usuarios contra los empleados del tenant en UNA
// sola consulta (no una por usuario: el job nocturno puede recorrer decenas
// de vendedores por tenant).
// Devuelve un Map user_id → Employee.
async function mapUsersToEmployees(tenant_id, users) {
  const { Employee } = require('../models');
  const result = new Map();
  if (!users || !users.length) return result;

  const employees = await Employee.findAll({
    where: { tenant_id },
    attributes: ['id', 'email', 'document_number', 'first_name', 'first_surname', 'is_active'],
  });
  if (!employees.length) return result;

  const byEmail = new Map();
  const byDoc = new Map();
  for (const emp of employees) {
    // Un empleado inactivo sigue sirviendo para vincular (puede haberse
    // retirado después de ganarse el bono del período pasado); el gate real
    // de "se puede cargar a nómina" es que exista un PayrollPeriod abierto.
    const email = normalizeEmail(emp.email);
    const doc = normalizeDoc(emp.document_number);
    if (email && !byEmail.has(email)) byEmail.set(email, emp);
    if (doc && !byDoc.has(doc)) byDoc.set(doc, emp);
  }

  for (const user of users) {
    const email = normalizeEmail(user.email);
    const doc = normalizeDoc(user.cedula);
    const match = (email && byEmail.get(email)) || (doc && byDoc.get(doc)) || null;
    if (match) result.set(user.id, match);
  }

  return result;
}

// Versión de un solo usuario (usada por el reintento manual desde la
// pantalla de consulta).
async function findEmployeeForUser(tenant_id, user) {
  const map = await mapUsersToEmployees(tenant_id, [user]);
  return map.get(user.id) || null;
}

// Diagnóstico para la pantalla de admin: qué vendedores del CRM no tienen
// empleado de nómina vinculado, para poder corregir el dato antes de que se
// cierre el período (en vez de enterarse cuando la recompensa ya falló).
async function listUnmatchedUsers(tenant_id, userIds = null) {
  const { User } = require('../models');
  const where = { tenant_id, is_active: true };
  if (userIds && userIds.length) where.id = { [Op.in]: userIds };

  const users = await User.findAll({ where, attributes: ['id', 'first_name', 'last_name', 'email', 'cedula'] });
  const matched = await mapUsersToEmployees(tenant_id, users);

  return users
    .filter(u => !matched.has(u.id))
    .map(u => ({
      user_id: u.id,
      name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
      email: u.email,
      has_cedula: !!u.cedula,
    }));
}

module.exports = { mapUsersToEmployees, findEmployeeForUser, listUnmatchedUsers, normalizeDoc, normalizeEmail };