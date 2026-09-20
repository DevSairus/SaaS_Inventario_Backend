// backend/src/services/exogena/formatServices.js
//
// Registro de los formatos de Exógena ya implementados en esta fase. Ver
// Contabilidad-Plan-Ejecucion-Fases-1-4.md §Fase 4. Los formatos restantes
// (1008, 1009, 1010, 1011, 1012, 1647, 2275) quedan en data/exogena-catalogs.js
// con dataSource='pending' hasta implementarse.
module.exports = {
  '1001': require('./format1001.service'),
  '1003': require('./format1003.service'),
  '1004': require('./format1004.service'),
  '1005': require('./format1005.service'),
  '1006': require('./format1006.service'),
  '1007': require('./format1007.service'),
  '1008': require('./format1008.service'),
  '1009': require('./format1009.service'),
  '1010': require('./format1010.service'),
  '1011': require('./format1011.service'),
  '1012': require('./format1012.service'),
  '1647': require('./format1647.service'),
  '2276': require('./format2276.service'),
};
