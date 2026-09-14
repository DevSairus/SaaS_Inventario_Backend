'use strict';

// Hasta ahora la campana de notificaciones (NotificationsCenter.jsx) usaba
// GET /workshop/appointments/pending (status='pendiente') tanto para saber
// qué mostrar como para saber qué contar en el badge -- no había forma de
// distinguir "todavía no la ha visto nadie" de "ya la vieron pero sigue sin
// confirmar". seen_at resuelve eso sin tocar el estado real de la cita: se
// marca cuando el staff abre el panel de notificaciones, y la cita sigue
// apareciendo igual en /workshop/appointments (AppointmentsPage.jsx usa
// `list`, no `getPending`) hasta que alguien la confirme o cancele.
module.exports = {
  async up(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE workshop_appointments
        ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
    `);
    console.log('[Migration] workshop_appointments: columna seen_at agregada');
  },

  async down(queryInterface) {
    const q = queryInterface.sequelize;
    await q.query(`
      ALTER TABLE workshop_appointments
        DROP COLUMN IF EXISTS seen_at
    `);
  },
};
