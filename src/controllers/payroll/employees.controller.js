const { Employee } = require('../../models');
const { Op } = require('sequelize');

const NULLABLE_FIELDS = [
  'other_names', 'second_surname', 'email', 'phone', 'position', 'cost_center',
  'branch_id', 'termination_date', 'contract_end_date', 'bank_name', 'account_type', 'account_number',
  'state', 'city', 'city_code', 'address', 'notes', 'employee_code',
  'work_state', 'work_city', 'work_city_code', 'work_address',
];

// Campos `allowNull: false` del modelo — algunos son obligatorios sin
// default (document_number, first_name, first_surname, hire_date) y otros
// tienen un default de fábrica pero igual no admiten NULL/'' (contract_type,
// worker_type, worker_subtype, salary_type, payment_method, payment_form,
// work_country). Si updateEmployee recibe cualquiera de estos en blanco, no
// se debe intentar sobrescribir: los que tienen `validate: isIn` revientan
// la validación con un 500 crudo, y los que no la tienen (worker_type,
// worker_subtype, work_country) quedarían corrompidos en '' de forma
// silenciosa. En ambos casos lo correcto es ignorarlos y dejar el valor
// actual intacto — igual que ya se hacía con document_type.
const PROTECTED_NOT_NULL_FIELDS = [
  'tenant_id', 'document_type', 'document_number', 'first_name', 'first_surname', 'hire_date',
  'contract_type', 'worker_type', 'worker_subtype', 'salary_type',
  'payment_method', 'payment_form', 'work_country', 'payroll_periodicity',
];

/**
 * Listar empleados con filtros y paginación
 */
const getEmployees = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const tenant_id = req.user.tenant_id;
    const {
      search = '',
      is_active,
      branch_id,
      contract_type,
      payroll_periodicity,
      sort_by = 'first_name',
      sort_order = 'ASC',
      page = 1,
      limit = 20,
    } = req.query;

    const offset = (page - 1) * limit;
    const where = { tenant_id };

    if (search) {
      where[Op.or] = [
        { first_name: { [Op.iLike]: `%${search}%` } },
        { other_names: { [Op.iLike]: `%${search}%` } },
        { first_surname: { [Op.iLike]: `%${search}%` } },
        { second_surname: { [Op.iLike]: `%${search}%` } },
        { document_number: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    if (is_active !== undefined && is_active !== '') {
      where.is_active = is_active === 'true';
    }
    if (branch_id) where.branch_id = branch_id;
    if (contract_type) where.contract_type = contract_type;
    if (payroll_periodicity) where.payroll_periodicity = payroll_periodicity;

    const { count, rows } = await Employee.findAndCountAll({
      where,
      order: [[sort_by, sort_order.toUpperCase()]],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(count / limit),
      },
    });
  } catch (error) {
    console.error('Error en getEmployees:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener empleados',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const getEmployeeById = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const employee = await Employee.findOne({ where: { id, tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    res.json({ success: true, data: employee });
  } catch (error) {
    console.error('Error en getEmployeeById:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener empleado',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const createEmployee = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado. Por favor contacte a soporte.' });
    }

    const tenant_id = req.user.tenant_id;
    const {
      document_type = '13',
      document_number,
      first_name,
      other_names,
      first_surname,
      second_surname,
      email,
      phone,
      position,
      cost_center,
      branch_id,
      contract_type = '1',
      worker_type = '01',
      worker_subtype = '00',
      high_risk_pension = false,
      employee_code,
      salary_type = 'ordinario',
      base_salary,
      payroll_periodicity = 'mensual',
      transport_allowance_eligible = true,
      hire_date,
      termination_date,
      contract_end_date,
      payment_method = 'transfer',
      payment_form = '1',
      bank_name,
      account_type,
      account_number,
      country,
      state,
      city,
      city_code,
      address,
      work_country = 'CO',
      work_state,
      work_city,
      work_city_code,
      work_address,
      is_active = true,
      notes,
    } = req.body;

    if (!document_number || !first_name || !first_surname || !hire_date) {
      return res.status(400).json({
        success: false,
        message: 'Documento, primer nombre, primer apellido y fecha de ingreso son requeridos',
      });
    }

    const existing = await Employee.findOne({
      where: { tenant_id, document_type, document_number },
    });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'Ya existe un empleado con ese tipo y número de documento',
      });
    }

    const employee = await Employee.create({
      tenant_id,
      document_type,
      document_number,
      first_name,
      other_names: other_names || null,
      first_surname,
      second_surname: second_surname || null,
      email: email || null,
      phone: phone || null,
      position: position || null,
      cost_center: cost_center || null,
      branch_id: branch_id || null,
      contract_type,
      worker_type,
      worker_subtype,
      high_risk_pension,
      employee_code: employee_code || null,
      salary_type,
      base_salary: base_salary || 0,
      payroll_periodicity,
      transport_allowance_eligible,
      hire_date,
      termination_date: termination_date || null,
      contract_end_date: contract_end_date || null,
      payment_method,
      payment_form,
      bank_name: bank_name || null,
      account_type: account_type || null,
      account_number: account_number || null,
      country: country || 'Colombia',
      state: state || null,
      city: city || null,
      city_code: city_code || null,
      address: address || null,
      work_country: work_country || 'CO',
      work_state: work_state || null,
      work_city: work_city || null,
      work_city_code: work_city_code || null,
      work_address: work_address || null,
      is_active,
      notes: notes || null,
      created_by: req.user.id || req.user.userId || null,
    });

    res.status(201).json({ success: true, message: 'Empleado creado exitosamente', data: employee });
  } catch (error) {
    console.error('Error en createEmployee:', error);
    res.status(500).json({
      success: false,
      message: 'Error al crear empleado',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const updateEmployee = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;
    const updateData = { ...req.body };

    const employee = await Employee.findOne({ where: { id, tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    if (
      (updateData.document_number && updateData.document_number !== employee.document_number) ||
      (updateData.document_type && updateData.document_type !== employee.document_type)
    ) {
      const documentType = updateData.document_type || employee.document_type;
      const documentNumber = updateData.document_number || employee.document_number;
      const duplicate = await Employee.findOne({
        where: {
          tenant_id,
          document_type: documentType,
          document_number: documentNumber,
          id: { [Op.ne]: id },
        },
      });
      if (duplicate) {
        return res.status(400).json({
          success: false,
          message: 'Ya existe un empleado con ese tipo y número de documento',
        });
      }
    }

    // Campos NOT NULL — no se sobrescriben con vacío
    PROTECTED_NOT_NULL_FIELDS.forEach((field) => {
      if (updateData[field] === '' || updateData[field] === undefined || updateData[field] === null) {
        delete updateData[field];
      }
    });

    // Campos opcionales — string vacío pasa a null
    NULLABLE_FIELDS.forEach((field) => {
      if (updateData[field] === '') updateData[field] = null;
    });

    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    await employee.update(updateData);

    res.json({ success: true, message: 'Empleado actualizado exitosamente', data: employee });
  } catch (error) {
    console.error('Error en updateEmployee:', error);
    res.status(500).json({
      success: false,
      message: 'Error al actualizar empleado',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deactivateEmployee = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const employee = await Employee.findOne({ where: { id, tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    await employee.update({ is_active: false });
    res.json({ success: true, message: 'Empleado desactivado exitosamente' });
  } catch (error) {
    console.error('Error en deactivateEmployee:', error);
    res.status(500).json({
      success: false,
      message: 'Error al desactivar empleado',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const activateEmployee = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const employee = await Employee.findOne({ where: { id, tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    await employee.update({ is_active: true });
    res.json({ success: true, message: 'Empleado activado exitosamente' });
  } catch (error) {
    console.error('Error en activateEmployee:', error);
    res.status(500).json({
      success: false,
      message: 'Error al activar empleado',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const { id } = req.params;
    const tenant_id = req.user.tenant_id;

    const employee = await Employee.findOne({ where: { id, tenant_id } });
    if (!employee) {
      return res.status(404).json({ success: false, message: 'Empleado no encontrado' });
    }

    // NOTA: cuando exista PayrollDocument (Fase 2), verificar aquí que el
    // empleado no tenga documentos emitidos antes de permitir el borrado
    // físico, igual que se hace con Purchase en suppliers.controller.js.
    await employee.destroy();
    res.json({ success: true, message: 'Empleado eliminado exitosamente' });
  } catch (error) {
    console.error('Error en deleteEmployee:', error);
    res.status(500).json({
      success: false,
      message: 'Error al eliminar empleado',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

const getEmployeeStats = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;

    const [total, active, inactive] = await Promise.all([
      Employee.count({ where: { tenant_id } }),
      Employee.count({ where: { tenant_id, is_active: true } }),
      Employee.count({ where: { tenant_id, is_active: false } }),
    ]);

    res.json({ success: true, data: { total, active, inactive } });
  } catch (error) {
    console.error('Error en getEmployeeStats:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener estadísticas',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

/**
 * Mejora #5 (Mejoras-Nomina-Sin-PILA-Nexora.md): alertas de vencimiento de
 * contrato a término fijo. Lista los empleados activos con contract_type
 * '2' (Término fijo) y contract_end_date dentro de la ventana solicitada
 * (`?days=30` por defecto), más los que ya vencieron y siguen activos
 * (contract_end_date en el pasado — normalmente indica que falta liquidar
 * el retiro o renovar, así que también se muestran, marcados como
 * vencidos en vez de "por vencer"). Es solo lectura — no dispara ningún
 * job en segundo plano, ver limitación documentada en el markdown fuente.
 */
const getExpiringContracts = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    }
    if (!req.user.tenant_id) {
      return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });
    }

    const tenant_id = req.user.tenant_id;
    const days = Math.max(parseInt(req.query.days, 10) || 30, 1);

    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const limitDate = new Date(today);
    limitDate.setDate(limitDate.getDate() + days);
    const limitStr = limitDate.toISOString().slice(0, 10);

    const employees = await Employee.findAll({
      where: {
        tenant_id,
        is_active: true,
        contract_type: '2', // Término fijo — el único tipo con fecha de fin pactada
        contract_end_date: { [Op.ne]: null, [Op.lte]: limitStr },
      },
      order: [['contract_end_date', 'ASC']],
    });

    const data = employees.map((emp) => {
      const daysRemaining = Math.ceil(
        (new Date(emp.contract_end_date) - new Date(todayStr)) / (1000 * 60 * 60 * 24)
      );
      return {
        id: emp.id,
        first_name: emp.first_name,
        other_names: emp.other_names,
        first_surname: emp.first_surname,
        second_surname: emp.second_surname,
        document_number: emp.document_number,
        position: emp.position,
        branch_id: emp.branch_id,
        contract_end_date: emp.contract_end_date,
        days_remaining: daysRemaining,
        is_overdue: daysRemaining < 0,
      };
    });

    res.json({
      success: true,
      data,
      meta: { days, count: data.length },
    });
  } catch (error) {
    console.error('Error en getExpiringContracts:', error);
    res.status(500).json({
      success: false,
      message: 'Error al obtener contratos por vencer',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = {
  getEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deactivateEmployee,
  activateEmployee,
  deleteEmployee,
  getEmployeeStats,
  getExpiringContracts,
};
