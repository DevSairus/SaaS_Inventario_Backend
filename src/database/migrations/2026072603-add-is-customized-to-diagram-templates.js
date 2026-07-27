'use strict';

// El seed de diagramas (src/services/seedDiagramTemplates.js) corre en cada
// arranque del server y hasta ahora pisaba SIEMPRE svg_content/image_path/
// points con lo que hubiera en el catálogo estático (src/data/diagram-
// templates-catalog.js), incluso si un admin había calibrado image_path o
// agregado líneas guía (label_dx/label_dy) manualmente vía la API. Esta
// migración agrega `is_customized`: cuando es true, el seed deja la fila en
// paz y no la sobreescribe. Las filas nuevas nacen en false (las gobierna el
// catálogo); en cuanto un admin las edita vía PATCH /:id/image o
// PATCH /:id/points, pasan a true y quedan protegidas.
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('diagram_templates', 'is_customized', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'true = fue editado a mano (image_path/points) vía el panel admin; el seed ya no la sobreescribe',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn('diagram_templates', 'is_customized');
  },
};
