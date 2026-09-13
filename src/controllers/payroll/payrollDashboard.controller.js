// backend/src/controllers/payroll/payrollDashboard.controller.js
//
// Dashboard de costos de nómina (mejora #8) -- solo lectura, un único
// endpoint que devuelve todo lo que consume la página
// (costo por sede/mes, comparativo devengado vs. deducciones, tendencia
// de novedades por categoría). Query params opcionales `desde`/`hasta`
// (YYYY-MM-DD) -- por defecto, últimos 12 meses -- y `branch_id`, para
// aislar una sola sede (el resto de la agregación no cambia). Ver
// payrollDashboardService.js para el detalle de cada agregación.
const { getDashboardCostos } = require('../../services/payroll/payrollDashboardService');

const getCostsDashboard = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: 'Usuario no autenticado' });
    if (!req.user.tenant_id) return res.status(400).json({ success: false, message: 'Usuario sin tenant asignado' });

    const { desde, hasta, branch_id } = req.query;
    if (desde && Number.isNaN(Date.parse(desde))) {
      return res.status(400).json({ success: false, message: 'Parámetro "desde" inválido (use YYYY-MM-DD)' });
    }
    if (hasta && Number.isNaN(Date.parse(hasta))) {
      return res.status(400).json({ success: false, message: 'Parámetro "hasta" inválido (use YYYY-MM-DD)' });
    }

    const data = await getDashboardCostos(req.user.tenant_id, { desde, hasta, branch_id: branch_id || undefined });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error en getCostsDashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Error al calcular el dashboard de costos de nómina',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
    });
  }
};

module.exports = { getCostsDashboard };
