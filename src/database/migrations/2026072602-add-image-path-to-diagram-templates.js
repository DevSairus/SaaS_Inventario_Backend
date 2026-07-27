'use strict';

// Los diagramas migran de SVG dibujado a mano a imágenes WEBP reales
// (public/assets/diagrams/<categoria>/<archivo>.webp en el frontend).
// `svg_content` se deja intacto y nullable (aún lo usa workshopPdfService
// para rasterizar el PDF de la OT) hasta que esa parte también migre a
// componer la imagen WEBP + los puntos.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('diagram_templates', 'image_path', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: 'Ruta relativa a public/assets/diagrams/, ej. "suspension/macpherson.webp"',
    });
    await queryInterface.changeColumn('diagram_templates', 'svg_content', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'Legado — SVG usado antes de migrar a image_path. Aún lo usa el PDF hasta migrar workshopPdfService.',
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('diagram_templates', 'svg_content', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    await queryInterface.removeColumn('diagram_templates', 'image_path');
  },
};
