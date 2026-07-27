// backend/src/data/diagram-templates-catalog.js
//
// Catálogo de diagramas base para el "Mapa de intervención".
// Cubre automóviles, camionetas, camiones y motocicletas.
// Automóvil: estilo 3D fotográfico (gradientes, sombras, brillos especulares).
// Puntos con label_dx/label_dy: el numero se dibuja desplazado y conectado
// por una linea guia al punto real (x,y) sobre la pieza, para diagramas con
// varias marcas muy próximas entre sí.
module.exports = [
  {
    "vehicle_type": "automovil",
    "system": "suspension_delantera",
    "configuration": "macpherson",
    "name": "Suspensión delantera MacPherson",
    "description": "Configuración más común en automóviles: amortiguador y resorte integrados en una sola columna (strut).",
    "view_box": "0 0 600 400",
    "image_path": "suspension/macpherson.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"222\" cy=\"371\" rx=\"100\" ry=\"11\" fill=\"#000000\" opacity=\"0.18\" filter=\"url(#blurGround)\"/>\n<ellipse cx=\"345\" cy=\"375\" rx=\"55\" ry=\"7\" fill=\"#000000\" opacity=\"0.14\" filter=\"url(#blurGround)\"/>\n<circle cx=\"222\" cy=\"300\" r=\"88\" fill=\"none\" stroke=\"#c7cbd1\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"222\" cy=\"300\" r=\"70\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.25\"/>\n  <g stroke=\"#5b6774\" stroke-width=\"0.9\" opacity=\"0.5\">\n    <line x1=\"222\" y1=\"234\" x2=\"222\" y2=\"366\"/><line x1=\"156\" y1=\"300\" x2=\"288\" y2=\"300\"/>\n    <line x1=\"176\" y1=\"254\" x2=\"268\" y2=\"346\"/><line x1=\"176\" y1=\"346\" x2=\"268\" y2=\"254\"/>\n  </g>\n  <circle cx=\"222\" cy=\"300\" r=\"70\" fill=\"none\" stroke=\"#8b95a3\" stroke-width=\"1\"/>\n  <ellipse cx=\"200\" cy=\"275\" rx=\"26\" ry=\"12\" fill=\"#ffffff\" opacity=\"0.5\" filter=\"url(#blurSoft)\"/>\n  <circle cx=\"222\" cy=\"300\" r=\"26\" fill=\"#242a32\" stroke=\"#000000\" stroke-width=\"1.25\"/>\n  <circle cx=\"222\" cy=\"300\" r=\"9\" fill=\"#b9c2cc\"/>\n  <g fill=\"url(#ballJoint3)\" stroke=\"#0b0e12\" stroke-width=\"0.75\">\n    <circle cx=\"222\" cy=\"278\" r=\"4.5\"/><circle cx=\"242\" cy=\"290\" r=\"4.5\"/>\n    <circle cx=\"242\" cy=\"311\" r=\"4.5\"/><circle cx=\"222\" cy=\"323\" r=\"4.5\"/><circle cx=\"202\" cy=\"311\" r=\"4.5\"/>\n  </g>\n  <path d=\"M232,238 Q272,255 272,300 Q272,335 250,352 L246,344 Q266,328 266,300 Q266,260 230,244 Z\" fill=\"url(#caliperGrad3)\" stroke=\"#2e0505\" stroke-width=\"1.5\"/>\n  <path d=\"M232,240 Q262,254 266,285\" fill=\"none\" stroke=\"#ffe3e3\" stroke-width=\"1.5\" opacity=\"0.55\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"315\" y=\"46\" width=\"30\" height=\"26\" rx=\"6\" fill=\"url(#chromeTube3)\" stroke=\"#050608\" stroke-width=\"1.1\"/>\n  <circle cx=\"330\" cy=\"59\" r=\"10\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.1\"/>\n  <circle cx=\"330\" cy=\"59\" r=\"4\" fill=\"url(#ballCenter3)\"/>\n  <circle cx=\"316\" cy=\"52\" r=\"2.6\" fill=\"#050608\"/><circle cx=\"344\" cy=\"52\" r=\"2.6\" fill=\"#050608\"/>\n  <circle cx=\"316\" cy=\"66\" r=\"2.6\" fill=\"#050608\"/><circle cx=\"344\" cy=\"66\" r=\"2.6\" fill=\"#050608\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"320\" y=\"72\" width=\"20\" height=\"30\" rx=\"3\" fill=\"url(#chromeTube3)\" stroke=\"#050608\" stroke-width=\"1.1\"/>\n  <rect x=\"320\" y=\"102\" width=\"20\" height=\"118\" rx=\"3\" fill=\"url(#strutBody3)\" stroke=\"#03060f\" stroke-width=\"1.1\"/>\n  <ellipse cx=\"326\" cy=\"130\" rx=\"2.4\" ry=\"45\" fill=\"#eef7ff\" opacity=\"0.5\"/>\n  <ellipse cx=\"326\" cy=\"120\" rx=\"4\" ry=\"9\" fill=\"#ffffff\" opacity=\"0.4\" filter=\"url(#blurSoft)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M348,96 Q368,101 358,113 Q348,118 358,130\" fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6.5\" stroke-linecap=\"round\"/>\n  <path d=\"M358,130 Q368,135 358,147 Q348,152 358,164\" fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6.5\" stroke-linecap=\"round\"/>\n  <path d=\"M358,164 Q368,169 358,181 Q348,186 358,198\" fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6.5\" stroke-linecap=\"round\"/>\n  <path d=\"M358,198 Q368,203 358,215 Q348,220 356,224\" fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6.5\" stroke-linecap=\"round\"/>\n  <ellipse cx=\"356\" cy=\"108\" rx=\"6\" ry=\"2.4\" fill=\"#ffe4e4\" opacity=\"0.9\"/><ellipse cx=\"356\" cy=\"142\" rx=\"6\" ry=\"2.4\" fill=\"#ffe4e4\" opacity=\"0.9\"/>\n  <ellipse cx=\"356\" cy=\"176\" rx=\"6\" ry=\"2.4\" fill=\"#ffe4e4\" opacity=\"0.9\"/><ellipse cx=\"356\" cy=\"210\" rx=\"6\" ry=\"2.4\" fill=\"#ffe4e4\" opacity=\"0.9\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M328,104 C336,110 336,116 328,120 C320,124 320,130 328,134 C336,138 336,144 328,148 C320,152 320,158 328,162 C336,166 336,172 328,176\"\n    fill=\"none\" stroke=\"url(#bootGrad3)\" stroke-width=\"9.5\" stroke-linecap=\"round\" opacity=\"0.95\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"318\" y=\"220\" width=\"24\" height=\"16\" rx=\"3\" fill=\"url(#chromeTube3)\" stroke=\"#050608\" stroke-width=\"1.1\"/>\n  <path d=\"M306,236 L306,272 Q306,296 330,296 L352,296 Q376,296 376,272 L376,236 Z\" fill=\"url(#knuckleGrad3)\" stroke=\"#2c1704\" stroke-width=\"1.4\"/>\n  <path d=\"M310,238 Q306,254 306,270\" fill=\"none\" stroke=\"#fff6da\" stroke-width=\"1.5\" opacity=\"0.5\"/>\n  <circle cx=\"315\" cy=\"248\" r=\"3.5\" fill=\"#2c1704\"/><circle cx=\"368\" cy=\"248\" r=\"3.5\" fill=\"#2c1704\"/>\n  <circle cx=\"341\" cy=\"264\" r=\"15\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.4\"/>\n  <circle cx=\"341\" cy=\"264\" r=\"5.5\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M290,296 L200,314 L200,306 L176,310 L172,320 L200,323 L200,316 L290,306 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <path d=\"M200,308 L288,299\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"1.2\" opacity=\"0.5\"/>\n  <rect x=\"255\" y=\"298\" width=\"4\" height=\"18\" fill=\"#000000\" opacity=\"0.3\"/>\n  <circle cx=\"290\" cy=\"301\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1.1\"/><circle cx=\"290\" cy=\"301\" r=\"3\" fill=\"#8a857c\"/>\n  <circle cx=\"176\" cy=\"315\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1.1\"/><circle cx=\"176\" cy=\"315\" r=\"3\" fill=\"#8a857c\"/>\n  <circle cx=\"230\" cy=\"311\" r=\"7\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.1\"/><circle cx=\"230\" cy=\"311\" r=\"2.6\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M140,150 Q220,142 300,150 Q380,158 480,150\" fill=\"none\" stroke=\"url(#stabGrad3)\" stroke-width=\"7\" stroke-linecap=\"round\"/>\n  <path d=\"M145,148 Q220,140 295,148\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"1\" opacity=\"0.45\"/>\n  <path d=\"M300,150 L300,206\" stroke=\"url(#stabGrad3)\" stroke-width=\"5.5\" stroke-linecap=\"round\"/>\n  <circle cx=\"300\" cy=\"150\" r=\"4\" fill=\"#052912\"/>\n  <circle cx=\"300\" cy=\"206\" r=\"6\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <line x1=\"430\" y1=\"150\" x2=\"452\" y2=\"252\" stroke=\"url(#tieRodGrad3)\" stroke-width=\"5.5\" stroke-linecap=\"round\"/>\n  <circle cx=\"430\" cy=\"150\" r=\"5.5\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n  <circle cx=\"452\" cy=\"252\" r=\"6.5\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.4\"/><circle cx=\"452\" cy=\"252\" r=\"2.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 330,
        "y": 150,
        "part_name": "Amortiguador (strut)"
      },
      {
        "point_number": 2,
        "x": 358,
        "y": 130,
        "part_name": "Resorte helicoidal"
      },
      {
        "point_number": 3,
        "x": 330,
        "y": 220,
        "part_name": "Tope de goteo",
        "label_dx": 0,
        "label_dy": -1.1
      },
      {
        "point_number": 4,
        "x": 330,
        "y": 62,
        "part_name": "Soporte superior (mount)"
      },
      {
        "point_number": 5,
        "x": 290,
        "y": 316,
        "part_name": "Rótula inferior"
      },
      {
        "point_number": 6,
        "x": 235,
        "y": 305,
        "part_name": "Brazo de control inferior"
      },
      {
        "point_number": 7,
        "x": 170,
        "y": 336,
        "part_name": "Buje delantero del brazo"
      },
      {
        "point_number": 8,
        "x": 200,
        "y": 313,
        "part_name": "Buje trasero del brazo"
      },
      {
        "point_number": 9,
        "x": 430,
        "y": 155,
        "part_name": "Barra estabilizadora"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 186,
        "part_name": "Link de barra estabilizadora"
      },
      {
        "point_number": 11,
        "x": 452,
        "y": 258,
        "part_name": "Terminal de dirección"
      },
      {
        "point_number": 12,
        "x": 330,
        "y": 250,
        "part_name": "Mangueta (knuckle)",
        "label_dx": 0,
        "label_dy": 1.1
      },
      {
        "point_number": 13,
        "x": 341,
        "y": 290,
        "part_name": "Rodamiento de rueda"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "suspension_delantera",
    "configuration": "doble_horquilla",
    "name": "Suspensión delantera doble horquilla",
    "description": "Dos brazos (superior e inferior) independientes sostienen la mangueta — más habitual en camionetas y vehículos de mayor porte.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/double-wishbone.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"230\" cy=\"371\" rx=\"100\" ry=\"11\" fill=\"#000000\" opacity=\"0.18\" filter=\"url(#blurGround)\"/>\n<circle cx=\"230\" cy=\"300\" r=\"88\" fill=\"none\" stroke=\"#c7cbd1\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"230\" cy=\"300\" r=\"70\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.25\"/>\n  <circle cx=\"230\" cy=\"300\" r=\"26\" fill=\"#242a32\" stroke=\"#000000\" stroke-width=\"1.25\"/>\n  <circle cx=\"230\" cy=\"300\" r=\"9\" fill=\"#b9c2cc\"/>\n  <ellipse cx=\"208\" cy=\"275\" rx=\"24\" ry=\"11\" fill=\"#ffffff\" opacity=\"0.5\" filter=\"url(#blurSoft)\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"302\" y=\"76\" width=\"18\" height=\"112\" rx=\"3\" fill=\"url(#strutBody3)\" stroke=\"#03060f\" stroke-width=\"1.1\"/>\n  <circle cx=\"311\" cy=\"80\" r=\"9\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n  <circle cx=\"311\" cy=\"80\" r=\"3.5\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M320,92 Q338,98 328,110 Q318,116 328,128 Q338,134 328,146 Q318,152 328,164 Q338,170 326,178\"\n    fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6.5\" stroke-linecap=\"round\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M300,200 L204,180 L188,177 L186,187 L202,191 L300,211 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <circle cx=\"300\" cy=\"206\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"206\" r=\"3\" fill=\"#8a857c\"/>\n  <circle cx=\"188\" cy=\"181\" r=\"9\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.1\"/><circle cx=\"188\" cy=\"181\" r=\"3.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M310,300 L200,326 L182,328 L180,340 L200,342 L310,314 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <path d=\"M200,330 L308,304\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"1.1\" opacity=\"0.45\"/>\n  <circle cx=\"310\" cy=\"306\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"306\" r=\"3\" fill=\"#8a857c\"/>\n  <circle cx=\"170\" cy=\"336\" r=\"9\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.1\"/><circle cx=\"170\" cy=\"336\" r=\"3.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M322,240 L322,286 Q322,306 344,306 L364,306 Q386,306 386,286 L386,240 Z\" fill=\"url(#knuckleGrad3)\" stroke=\"#2c1704\" stroke-width=\"1.4\"/>\n  <circle cx=\"353\" cy=\"275\" r=\"15\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.4\"/><circle cx=\"353\" cy=\"275\" r=\"5.5\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M140,150 Q210,142 300,150 Q380,158 480,150\" fill=\"none\" stroke=\"url(#stabGrad3)\" stroke-width=\"7\" stroke-linecap=\"round\"/>\n  <path d=\"M300,150 L300,196\" stroke=\"url(#stabGrad3)\" stroke-width=\"5.5\" stroke-linecap=\"round\"/>\n  <circle cx=\"300\" cy=\"150\" r=\"4\" fill=\"#052912\"/>\n  <circle cx=\"300\" cy=\"196\" r=\"6\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <line x1=\"430\" y1=\"150\" x2=\"455\" y2=\"260\" stroke=\"url(#tieRodGrad3)\" stroke-width=\"5.5\" stroke-linecap=\"round\"/>\n  <circle cx=\"430\" cy=\"150\" r=\"5.5\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n  <circle cx=\"455\" cy=\"260\" r=\"6.5\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.4\"/><circle cx=\"455\" cy=\"260\" r=\"2.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 310,
        "y": 145,
        "part_name": "Amortiguador"
      },
      {
        "point_number": 2,
        "x": 335,
        "y": 120,
        "part_name": "Resorte helicoidal"
      },
      {
        "point_number": 3,
        "x": 240,
        "y": 186,
        "part_name": "Brazo de control superior"
      },
      {
        "point_number": 4,
        "x": 180,
        "y": 181,
        "part_name": "Rótula superior"
      },
      {
        "point_number": 5,
        "x": 240,
        "y": 320,
        "part_name": "Brazo de control inferior"
      },
      {
        "point_number": 6,
        "x": 170,
        "y": 336,
        "part_name": "Rótula inferior"
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 206,
        "part_name": "Buje brazo superior"
      },
      {
        "point_number": 8,
        "x": 310,
        "y": 306,
        "part_name": "Buje brazo inferior"
      },
      {
        "point_number": 9,
        "x": 430,
        "y": 150,
        "part_name": "Barra estabilizadora"
      },
      {
        "point_number": 10,
        "x": 318,
        "y": 180,
        "part_name": "Link de barra estabilizadora"
      },
      {
        "point_number": 11,
        "x": 455,
        "y": 260,
        "part_name": "Terminal de dirección"
      },
      {
        "point_number": 12,
        "x": 353,
        "y": 275,
        "part_name": "Mangueta (knuckle)"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "suspension_trasera",
    "configuration": "eje_rigido",
    "name": "Suspensión trasera de eje rígido (ballestas)",
    "description": "Eje trasero rígido conectado mediante ballestas longitudinales — simple, robusto, común en vehículos comerciales.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/solid-axle-leaf-spring.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"170\" cy=\"345\" rx=\"55\" ry=\"9\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<ellipse cx=\"430\" cy=\"345\" rx=\"55\" ry=\"9\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"170\" cy=\"280\" r=\"46\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.1\"/>\n  <circle cx=\"170\" cy=\"280\" r=\"15\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1\"/>\n  <circle cx=\"430\" cy=\"280\" r=\"46\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.1\"/>\n  <circle cx=\"430\" cy=\"280\" r=\"15\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"150\" y=\"222\" width=\"300\" height=\"20\" rx=\"9\" fill=\"url(#chromeTubeV)\" stroke=\"#050608\" stroke-width=\"1.2\"/>\n  <ellipse cx=\"300\" cy=\"228\" rx=\"140\" ry=\"3\" fill=\"#eef2f6\" opacity=\"0.5\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M110,214 Q170,206 230,214\" fill=\"none\" stroke=\"url(#leafGrad)\" stroke-width=\"10\" stroke-linecap=\"round\"/>\n  <path d=\"M118,222 Q170,215 222,222\" fill=\"none\" stroke=\"url(#leafGrad)\" stroke-width=\"8\" stroke-linecap=\"round\" opacity=\"0.9\"/>\n  <path d=\"M126,230 Q170,224 214,230\" fill=\"none\" stroke=\"url(#leafGrad)\" stroke-width=\"6\" stroke-linecap=\"round\" opacity=\"0.85\"/>\n  <rect x=\"160\" y=\"215\" width=\"20\" height=\"24\" rx=\"3\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n  <path d=\"M370,214 Q430,206 490,214\" fill=\"none\" stroke=\"url(#leafGrad)\" stroke-width=\"10\" stroke-linecap=\"round\"/>\n  <path d=\"M378,222 Q430,215 482,222\" fill=\"none\" stroke=\"url(#leafGrad)\" stroke-width=\"8\" stroke-linecap=\"round\" opacity=\"0.9\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"163\" y=\"120\" width=\"14\" height=\"90\" rx=\"3\" fill=\"url(#strutBody3)\" stroke=\"#03060f\" stroke-width=\"1\"/>\n  <circle cx=\"170\" cy=\"123\" r=\"8\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"170\" cy=\"123\" r=\"3\" fill=\"url(#ballCenter3)\"/>\n  <rect x=\"160\" y=\"140\" width=\"20\" height=\"7\" rx=\"2\" fill=\"url(#bushGrad3)\"/>\n  <rect x=\"403\" y=\"120\" width=\"14\" height=\"90\" rx=\"3\" fill=\"url(#strutBody3)\" stroke=\"#03060f\" stroke-width=\"1\"/>\n  <circle cx=\"410\" cy=\"123\" r=\"8\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"410\" cy=\"123\" r=\"3\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <rect x=\"150\" y=\"238\" width=\"24\" height=\"10\" rx=\"2\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"0.8\"/>\n  <rect x=\"150\" y=\"252\" width=\"24\" height=\"6\" rx=\"2\" fill=\"#1c1917\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 190,
        "y": 198,
        "part_name": "Ballesta (hojas)"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 214,
        "part_name": "Eje trasero (tubo)"
      },
      {
        "point_number": 3,
        "x": 190,
        "y": 133,
        "part_name": "Amortiguador",
        "label_dx": 3.3,
        "label_dy": -4.7
      },
      {
        "point_number": 4,
        "x": 178,
        "y": 150,
        "part_name": "Soporte amortiguador",
        "label_dx": -3.3,
        "label_dy": 4.7
      },
      {
        "point_number": 5,
        "x": 205,
        "y": 228,
        "part_name": "U-bolt (grapa)"
      },
      {
        "point_number": 6,
        "x": 170,
        "y": 280,
        "part_name": "Rodamiento de rueda"
      },
      {
        "point_number": 7,
        "x": 430,
        "y": 280,
        "part_name": "Rodamiento de rueda (opuesto)"
      },
      {
        "point_number": 8,
        "x": 410,
        "y": 133,
        "part_name": "Amortiguador (opuesto)"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "suspension_trasera",
    "configuration": "multilink",
    "name": "Suspensión trasera multilink",
    "description": "Múltiples brazos independientes controlan la rueda — mejor estabilidad y confort.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/multilink.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"230\" cy=\"360\" rx=\"90\" ry=\"10\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<circle cx=\"245\" cy=\"295\" r=\"50\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.1\" filter=\"url(#dropSh3)\"/>\n<circle cx=\"245\" cy=\"295\" r=\"16\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1\"/>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"292\" y=\"86\" width=\"18\" height=\"110\" rx=\"3\" fill=\"url(#strutBody3)\" stroke=\"#03060f\" stroke-width=\"1.1\"/>\n  <circle cx=\"301\" cy=\"90\" r=\"9\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"301\" cy=\"90\" r=\"3.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M315,96 Q332,102 322,113 Q312,119 322,131 Q332,137 322,148\" fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6\" stroke-linecap=\"round\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M290,262 L200,272 L170,278 L168,290 L200,286 L292,274 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <circle cx=\"170\" cy=\"284\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"170\" cy=\"284\" r=\"3\" fill=\"#8a857c\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M295,308 L210,318 L182,322 L180,332 L212,330 L297,320 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <circle cx=\"180\" cy=\"326\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"180\" cy=\"326\" r=\"3\" fill=\"#8a857c\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M355,232 L300,244 L296,254 L352,248 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <circle cx=\"360\" cy=\"238\" r=\"7\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"360\" cy=\"238\" r=\"2.6\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M300,238 L300,270 Q300,288 318,288 L332,288 Q350,288 350,270 L350,238 Z\" fill=\"url(#knuckleGrad3)\" stroke=\"#2c1704\" stroke-width=\"1.3\"/>\n  <circle cx=\"320\" cy=\"255\" r=\"12\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.2\"/><circle cx=\"320\" cy=\"255\" r=\"4.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 130,
        "part_name": "Amortiguador"
      },
      {
        "point_number": 2,
        "x": 320,
        "y": 100,
        "part_name": "Resorte helicoidal"
      },
      {
        "point_number": 3,
        "x": 225,
        "y": 265,
        "part_name": "Brazo inferior (A)"
      },
      {
        "point_number": 4,
        "x": 170,
        "y": 285,
        "part_name": "Buje brazo inferior"
      },
      {
        "point_number": 5,
        "x": 235,
        "y": 310,
        "part_name": "Brazo de arrastre"
      },
      {
        "point_number": 6,
        "x": 180,
        "y": 325,
        "part_name": "Buje brazo de arrastre"
      },
      {
        "point_number": 7,
        "x": 360,
        "y": 240,
        "part_name": "Brazo de reacción"
      },
      {
        "point_number": 8,
        "x": 320,
        "y": 255,
        "part_name": "Mangueta trasera"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "suspension_trasera",
    "configuration": "independiente",
    "name": "Suspensión trasera independiente (brazo longitudinal)",
    "description": "Cada rueda se mueve de forma independiente mediante un brazo longitudinal — frecuente en autos compactos.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/torsion-beam.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"245\" cy=\"330\" rx=\"90\" ry=\"10\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<circle cx=\"270\" cy=\"270\" r=\"48\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.1\" filter=\"url(#dropSh3)\"/>\n<circle cx=\"270\" cy=\"270\" r=\"15\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1\"/>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"292\" y=\"94\" width=\"18\" height=\"105\" rx=\"3\" fill=\"url(#strutBody3)\" stroke=\"#03060f\" stroke-width=\"1.1\"/>\n  <circle cx=\"301\" cy=\"98\" r=\"9\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"301\" cy=\"98\" r=\"3.4\" fill=\"url(#ballCenter3)\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M316,106 Q332,112 322,122 Q312,128 322,138 Q332,144 322,154\" fill=\"none\" stroke=\"url(#coilRing3)\" stroke-width=\"6\" stroke-linecap=\"round\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M300,240 L220,262 L176,280 L170,296 L184,300 L228,282 L300,258 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n  <path d=\"M182,282 L296,246\" fill=\"none\" stroke=\"#ffffff\" stroke-width=\"1.1\" opacity=\"0.4\"/>\n  <circle cx=\"176\" cy=\"292\" r=\"9\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/><circle cx=\"176\" cy=\"292\" r=\"3\" fill=\"#8a857c\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M290,178 L300,178 L300,222 L290,222 Z\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n  <line x1=\"270\" y1=\"180\" x2=\"330\" y2=\"180\" stroke=\"url(#stabGrad3)\" stroke-width=\"5\" stroke-linecap=\"round\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M280,232 L280,258 Q280,272 296,272 L308,272 Q324,272 324,258 L324,232 Z\" fill=\"url(#knuckleGrad3)\" stroke=\"#2c1704\" stroke-width=\"1.3\"/>\n  <circle cx=\"300\" cy=\"245\" r=\"11\" fill=\"url(#ballJoint3)\" stroke=\"#050608\" stroke-width=\"1.2\"/><circle cx=\"300\" cy=\"245\" r=\"4\" fill=\"url(#ballCenter3)\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 145,
        "part_name": "Amortiguador",
        "label_dx": -1.5,
        "label_dy": 1.5
      },
      {
        "point_number": 2,
        "x": 320,
        "y": 125,
        "part_name": "Resorte helicoidal",
        "label_dx": 1.5,
        "label_dy": -1.5
      },
      {
        "point_number": 3,
        "x": 230,
        "y": 280,
        "part_name": "Brazo longitudinal (arrastre)"
      },
      {
        "point_number": 4,
        "x": 170,
        "y": 295,
        "part_name": "Buje delantero del brazo"
      },
      {
        "point_number": 5,
        "x": 300,
        "y": 180,
        "part_name": "Barra de torsión"
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 245,
        "part_name": "Mangueta trasera"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "frenos_delanteros",
    "configuration": "disco_ventilado",
    "name": "Frenos delanteros — disco ventilado",
    "description": "Disco con canales internos de ventilación para disipar mejor el calor — estándar en el eje delantero.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/front-disc-vented.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"300\" cy=\"368\" rx=\"120\" ry=\"12\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<circle cx=\"300\" cy=\"220\" r=\"140\" fill=\"none\" stroke=\"#c7cbd1\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"300\" cy=\"220\" r=\"105\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.3\"/>\n  <ellipse cx=\"270\" cy=\"185\" rx=\"34\" ry=\"16\" fill=\"#ffffff\" opacity=\"0.45\" filter=\"url(#blurSoft)\"/>\n  <circle cx=\"300\" cy=\"220\" r=\"95\" fill=\"none\" stroke=\"#8b95a3\" stroke-width=\"1\"/>\n  <g stroke=\"#5b6774\" stroke-width=\"0.8\" opacity=\"0.5\">\n    <line x1=\"300\" y1=\"115\" x2=\"300\" y2=\"325\"/><line x1=\"195\" y1=\"220\" x2=\"405\" y2=\"220\"/>\n    <line x1=\"225\" y1=\"145\" x2=\"375\" y2=\"295\"/><line x1=\"225\" y1=\"295\" x2=\"375\" y2=\"145\"/>\n  </g>\n  <circle cx=\"300\" cy=\"220\" r=\"50\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1.4\"/>\n  <circle cx=\"300\" cy=\"220\" r=\"20\" fill=\"#5b6774\" stroke=\"#000\" stroke-width=\"1\"/>\n  <circle cx=\"300\" cy=\"220\" r=\"8\" fill=\"#b9c2cc\"/>\n  <g fill=\"url(#ballJoint3)\" stroke=\"#0b0e12\" stroke-width=\"0.7\">\n    <circle cx=\"325\" cy=\"200\" r=\"5\"/><circle cx=\"275\" cy=\"240\" r=\"5\"/><circle cx=\"340\" cy=\"230\" r=\"5\"/>\n    <circle cx=\"260\" cy=\"210\" r=\"5\"/><circle cx=\"310\" cy=\"250\" r=\"5\"/><circle cx=\"290\" cy=\"190\" r=\"5\"/>\n  </g>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M255,95 L255,170 Q255,182 267,182 L282,182 Q294,182 294,170 L294,95 Q294,83 282,83 L267,83 Q255,83 255,95 Z\" fill=\"url(#caliperGrad3)\" stroke=\"#2e0505\" stroke-width=\"1.6\"/>\n  <path d=\"M258,88 Q262,130 262,175\" fill=\"none\" stroke=\"#ffd0d0\" stroke-width=\"1.6\" opacity=\"0.55\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <rect x=\"260\" y=\"100\" width=\"26\" height=\"60\" rx=\"3\" fill=\"url(#padGrad)\" stroke=\"#5a4c30\" stroke-width=\"1.1\"/>\n  <rect x=\"262\" y=\"108\" width=\"22\" height=\"14\" rx=\"2\" fill=\"#4b5563\" stroke=\"#26292f\" stroke-width=\"1\"/>\n  <rect x=\"262\" y=\"130\" width=\"22\" height=\"14\" rx=\"2\" fill=\"#4b5563\" stroke=\"#26292f\" stroke-width=\"1\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"272\" cy=\"90\" r=\"6\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M255,128 L238,128 L238,140 L255,140\" fill=\"none\" stroke=\"url(#tieRodGradH)\" stroke-width=\"4\" stroke-linecap=\"round\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 325,
        "part_name": "Disco ventilado"
      },
      {
        "point_number": 2,
        "x": 280,
        "y": 172,
        "part_name": "Mordaza (caliper)",
        "label_dx": 1.5,
        "label_dy": 2.1
      },
      {
        "point_number": 3,
        "x": 264,
        "y": 110,
        "part_name": "Pastilla interior",
        "label_dx": -1.5,
        "label_dy": 2.1
      },
      {
        "point_number": 4,
        "x": 264,
        "y": 150,
        "part_name": "Pastilla exterior",
        "label_dx": -1.5,
        "label_dy": -2.1
      },
      {
        "point_number": 5,
        "x": 280,
        "y": 88,
        "part_name": "Perno guía del caliper",
        "label_dx": 1.5,
        "label_dy": -2.1
      },
      {
        "point_number": 6,
        "x": 296,
        "y": 118,
        "part_name": "Portamordaza (bracket)"
      },
      {
        "point_number": 7,
        "x": 232,
        "y": 130,
        "part_name": "Latiguillo de freno"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 220,
        "part_name": "Buje central (hub)"
      },
      {
        "point_number": 9,
        "x": 380,
        "y": 195,
        "part_name": "Tornillos de rueda"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "frenos_delanteros",
    "configuration": "disco_solido",
    "name": "Frenos delanteros — disco sólido",
    "description": "Disco macizo sin canales de ventilación — más económico, usado en ejes traseros o autos de baja potencia.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/front-disc-solid.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"300\" cy=\"365\" rx=\"115\" ry=\"12\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<circle cx=\"300\" cy=\"215\" r=\"135\" fill=\"none\" stroke=\"#c7cbd1\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"300\" cy=\"215\" r=\"100\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.3\"/>\n  <ellipse cx=\"272\" cy=\"182\" rx=\"30\" ry=\"14\" fill=\"#ffffff\" opacity=\"0.4\" filter=\"url(#blurSoft)\"/>\n  <circle cx=\"300\" cy=\"215\" r=\"50\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1.4\"/>\n  <circle cx=\"300\" cy=\"215\" r=\"20\" fill=\"#5b6774\" stroke=\"#000\" stroke-width=\"1\"/>\n  <circle cx=\"300\" cy=\"215\" r=\"8\" fill=\"#b9c2cc\"/>\n  <g fill=\"url(#ballJoint3)\" stroke=\"#0b0e12\" stroke-width=\"0.7\">\n    <circle cx=\"330\" cy=\"195\" r=\"5\"/><circle cx=\"270\" cy=\"235\" r=\"5\"/><circle cx=\"345\" cy=\"225\" r=\"5\"/>\n    <circle cx=\"255\" cy=\"205\" r=\"5\"/><circle cx=\"315\" cy=\"245\" r=\"5\"/>\n  </g>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M260,110 L260,175 Q260,187 272,187 L286,187 Q298,187 298,175 L298,110 Q298,98 286,98 L272,98 Q260,98 260,110 Z\" fill=\"url(#caliperGrad3)\" stroke=\"#2e0505\" stroke-width=\"1.6\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <rect x=\"264\" y=\"115\" width=\"26\" height=\"58\" rx=\"3\" fill=\"url(#padGrad)\" stroke=\"#5a4c30\" stroke-width=\"1.1\"/>\n</g>\n<circle cx=\"275\" cy=\"100\" r=\"6\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\" filter=\"url(#dropSh3)\"/>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 320,
        "part_name": "Disco sólido"
      },
      {
        "point_number": 2,
        "x": 284,
        "y": 174,
        "part_name": "Mordaza (caliper)",
        "label_dx": 1.5,
        "label_dy": 2.1
      },
      {
        "point_number": 3,
        "x": 268,
        "y": 112,
        "part_name": "Pastilla interior",
        "label_dx": -1.6,
        "label_dy": 1.8
      },
      {
        "point_number": 4,
        "x": 268,
        "y": 152,
        "part_name": "Pastilla exterior",
        "label_dx": -1.5,
        "label_dy": -2.1
      },
      {
        "point_number": 5,
        "x": 286,
        "y": 92,
        "part_name": "Perno guía del caliper",
        "label_dx": 0.8,
        "label_dy": -3.4
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 116,
        "part_name": "Portamordaza (bracket)",
        "label_dx": 0.8,
        "label_dy": 1.5
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 220,
        "part_name": "Buje central (hub)"
      },
      {
        "point_number": 8,
        "x": 335,
        "y": 225,
        "part_name": "Tornillos de rueda"
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "frenos_traseros",
    "configuration": "disco",
    "name": "Frenos traseros — disco",
    "description": "Disco de freno en el eje trasero — mejor rendimiento que tambor, común en autos deportivos.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/rear-disc.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"300\" cy=\"360\" rx=\"112\" ry=\"11\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<circle cx=\"300\" cy=\"215\" r=\"130\" fill=\"none\" stroke=\"#c7cbd1\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"300\" cy=\"215\" r=\"96\" fill=\"url(#rotorFace3)\" stroke=\"#3f4753\" stroke-width=\"1.3\"/>\n  <ellipse cx=\"274\" cy=\"184\" rx=\"28\" ry=\"13\" fill=\"#ffffff\" opacity=\"0.4\" filter=\"url(#blurSoft)\"/>\n  <circle cx=\"300\" cy=\"215\" r=\"48\" fill=\"#242a32\" stroke=\"#000\" stroke-width=\"1.3\"/>\n  <circle cx=\"300\" cy=\"215\" r=\"19\" fill=\"#5b6774\" stroke=\"#000\" stroke-width=\"1\"/>\n  <circle cx=\"300\" cy=\"215\" r=\"7\" fill=\"#b9c2cc\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M265,120 L265,180 Q265,191 276,191 L290,191 Q301,191 301,180 L301,120 Q301,109 290,109 L276,109 Q265,109 265,120 Z\" fill=\"url(#caliperGrad3)\" stroke=\"#2e0505\" stroke-width=\"1.5\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <rect x=\"269\" y=\"123\" width=\"24\" height=\"55\" rx=\"3\" fill=\"url(#padGrad)\" stroke=\"#5a4c30\" stroke-width=\"1\"/>\n</g>\n<circle cx=\"280\" cy=\"112\" r=\"5.5\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\" filter=\"url(#dropSh3)\"/>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M290,215 Q305,205 320,215 Q305,225 290,215 Z\" fill=\"url(#leafGrad)\" stroke=\"#0e1216\" stroke-width=\"1\"/>\n</g>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 315,
        "part_name": "Disco trasero"
      },
      {
        "point_number": 2,
        "x": 288,
        "y": 178,
        "part_name": "Mordaza (caliper)",
        "label_dx": 1.5,
        "label_dy": 2.1
      },
      {
        "point_number": 3,
        "x": 272,
        "y": 116,
        "part_name": "Pastilla interior",
        "label_dx": -1.8,
        "label_dy": 2
      },
      {
        "point_number": 4,
        "x": 272,
        "y": 156,
        "part_name": "Pastilla exterior",
        "label_dx": -1.5,
        "label_dy": -2.1
      },
      {
        "point_number": 5,
        "x": 290,
        "y": 96,
        "part_name": "Perno guía del caliper",
        "label_dx": 1.8,
        "label_dy": -2
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 220,
        "part_name": "Buje central (hub)",
        "label_dx": -1.5,
        "label_dy": -1.3
      },
      {
        "point_number": 7,
        "x": 322,
        "y": 238,
        "part_name": "Freno de mano (zapata)",
        "label_dx": 1.5,
        "label_dy": 1.3
      }
    ]
  },
  {
    "vehicle_type": "automovil",
    "system": "frenos_traseros",
    "configuration": "tambor",
    "name": "Frenos traseros — tambor",
    "description": "Tambor con zapatas internas — económico y autoajustable, común en ejes traseros de autos económicos.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/rear-drum.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs>\n  <radialGradient id=\"bgVignette\" cx=\"50%\" cy=\"38%\" r=\"75%\">\n    <stop offset=\"0%\" stop-color=\"#fafbfc\"/>\n    <stop offset=\"70%\" stop-color=\"#eceef1\"/>\n    <stop offset=\"100%\" stop-color=\"#d9dce1\"/>\n  </radialGradient>\n  <linearGradient id=\"strutBody3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050f24\"/><stop offset=\"12%\" stop-color=\"#123061\"/>\n    <stop offset=\"26%\" stop-color=\"#3d78d6\"/><stop offset=\"40%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"48%\" stop-color=\"#eef7ff\"/><stop offset=\"56%\" stop-color=\"#a9d0ff\"/>\n    <stop offset=\"72%\" stop-color=\"#3d78d6\"/><stop offset=\"88%\" stop-color=\"#0d2043\"/>\n    <stop offset=\"100%\" stop-color=\"#050f24\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTube3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"chromeTubeV\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#12161d\"/><stop offset=\"14%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"30%\" stop-color=\"#aab6c4\"/><stop offset=\"42%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"50%\" stop-color=\"#ffffff\"/><stop offset=\"58%\" stop-color=\"#f5f8fb\"/>\n    <stop offset=\"70%\" stop-color=\"#aab6c4\"/><stop offset=\"86%\" stop-color=\"#4b5768\"/>\n    <stop offset=\"100%\" stop-color=\"#12161d\"/>\n  </linearGradient>\n  <linearGradient id=\"bootGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"50%\" stop-color=\"#63636b\"/><stop offset=\"60%\" stop-color=\"#2e2e32\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <radialGradient id=\"coilRing3\" cx=\"32%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"30%\" stop-color=\"#f87171\"/>\n    <stop offset=\"65%\" stop-color=\"#c81e1e\"/><stop offset=\"100%\" stop-color=\"#5c0f0f\"/>\n  </radialGradient>\n  <linearGradient id=\"armGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"armGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#f3f5f8\"/><stop offset=\"22%\" stop-color=\"#c3ccd6\"/>\n    <stop offset=\"55%\" stop-color=\"#7c8896\"/><stop offset=\"82%\" stop-color=\"#37404b\"/>\n    <stop offset=\"100%\" stop-color=\"#0e1216\"/>\n  </linearGradient>\n  <linearGradient id=\"leafGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e8ecf1\"/><stop offset=\"30%\" stop-color=\"#a7b2bf\"/>\n    <stop offset=\"60%\" stop-color=\"#5c6672\"/><stop offset=\"85%\" stop-color=\"#2a3138\"/>\n    <stop offset=\"100%\" stop-color=\"#0c0f12\"/>\n  </linearGradient>\n  <linearGradient id=\"knuckleGrad3\" x1=\"0.05\" y1=\"0\" x2=\"0.95\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffefb8\"/><stop offset=\"28%\" stop-color=\"#fbbf24\"/>\n    <stop offset=\"60%\" stop-color=\"#c2740a\"/><stop offset=\"85%\" stop-color=\"#7c4308\"/>\n    <stop offset=\"100%\" stop-color=\"#3d2004\"/>\n  </linearGradient>\n  <linearGradient id=\"stabGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#eaffc7\"/><stop offset=\"30%\" stop-color=\"#7be495\"/>\n    <stop offset=\"60%\" stop-color=\"#22a35c\"/><stop offset=\"85%\" stop-color=\"#0e5c2c\"/>\n    <stop offset=\"100%\" stop-color=\"#052912\"/>\n  </linearGradient>\n  <linearGradient id=\"bushGrad3\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#050505\"/><stop offset=\"40%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"50%\" stop-color=\"#5c5750\"/><stop offset=\"60%\" stop-color=\"#3a3733\"/>\n    <stop offset=\"100%\" stop-color=\"#050505\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <linearGradient id=\"tieRodGradH\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">\n    <stop offset=\"0%\" stop-color=\"#fbf0ff\"/><stop offset=\"28%\" stop-color=\"#d8a4fb\"/>\n    <stop offset=\"60%\" stop-color=\"#9333ea\"/><stop offset=\"85%\" stop-color=\"#520e8f\"/>\n    <stop offset=\"100%\" stop-color=\"#25043f\"/>\n  </linearGradient>\n  <radialGradient id=\"ballJoint3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"25%\" stop-color=\"#e4e9ef\"/>\n    <stop offset=\"55%\" stop-color=\"#9aa6b3\"/><stop offset=\"82%\" stop-color=\"#454e5a\"/>\n    <stop offset=\"100%\" stop-color=\"#0b0e12\"/>\n  </radialGradient>\n  <radialGradient id=\"ballCenter3\" cx=\"30%\" cy=\"24%\" r=\"85%\">\n    <stop offset=\"0%\" stop-color=\"#7c8896\"/><stop offset=\"100%\" stop-color=\"#000000\"/>\n  </radialGradient>\n  <radialGradient id=\"rotorFace3\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#ffffff\"/><stop offset=\"35%\" stop-color=\"#e2e7ed\"/>\n    <stop offset=\"65%\" stop-color=\"#aab4c0\"/><stop offset=\"88%\" stop-color=\"#616b78\"/>\n    <stop offset=\"100%\" stop-color=\"#2a2f36\"/>\n  </radialGradient>\n  <radialGradient id=\"drumGrad\" cx=\"34%\" cy=\"26%\" r=\"80%\">\n    <stop offset=\"0%\" stop-color=\"#e7ded2\"/><stop offset=\"35%\" stop-color=\"#c7b9a3\"/>\n    <stop offset=\"65%\" stop-color=\"#8f7d63\"/><stop offset=\"88%\" stop-color=\"#5a4c3a\"/>\n    <stop offset=\"100%\" stop-color=\"#2c2418\"/>\n  </radialGradient>\n  <linearGradient id=\"padGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#f2ede4\"/><stop offset=\"45%\" stop-color=\"#cfc3ac\"/>\n    <stop offset=\"100%\" stop-color=\"#7c6f56\"/>\n  </linearGradient>\n  <linearGradient id=\"shoeGrad\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#e0d4b0\"/><stop offset=\"50%\" stop-color=\"#b89b5e\"/>\n    <stop offset=\"100%\" stop-color=\"#5c4a24\"/>\n  </linearGradient>\n  <linearGradient id=\"caliperGrad3\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffd0d0\"/><stop offset=\"30%\" stop-color=\"#f24040\"/>\n    <stop offset=\"65%\" stop-color=\"#a51616\"/><stop offset=\"100%\" stop-color=\"#4d0808\"/>\n  </linearGradient>\n  <linearGradient id=\"springSmall\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\">\n    <stop offset=\"0%\" stop-color=\"#ffe4e4\"/><stop offset=\"45%\" stop-color=\"#f87171\"/>\n    <stop offset=\"100%\" stop-color=\"#7f1d1d\"/>\n  </linearGradient>\n  <filter id=\"dropSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"2\" dy=\"6\" stdDeviation=\"4\" flood-color=\"#05070d\" flood-opacity=\"0.45\"/>\n  </filter>\n  <filter id=\"softSh3\" x=\"-60%\" y=\"-60%\" width=\"240%\" height=\"240%\">\n    <feDropShadow dx=\"0\" dy=\"2.5\" stdDeviation=\"2.2\" flood-color=\"#05070d\" flood-opacity=\"0.35\"/>\n  </filter>\n  <filter id=\"blurSoft\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"4\"/>\n  </filter>\n  <filter id=\"blurGround\" x=\"-100%\" y=\"-100%\" width=\"300%\" height=\"300%\">\n    <feGaussianBlur stdDeviation=\"7\"/>\n  </filter>\n</defs><rect width=\"600\" height=\"400\" fill=\"url(#bgVignette)\"/>\n<ellipse cx=\"300\" cy=\"360\" rx=\"115\" ry=\"11\" fill=\"#000000\" opacity=\"0.16\" filter=\"url(#blurGround)\"/>\n<circle cx=\"300\" cy=\"220\" r=\"130\" fill=\"none\" stroke=\"#c7cbd1\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/>\n<g filter=\"url(#dropSh3)\">\n  <circle cx=\"300\" cy=\"220\" r=\"98\" fill=\"url(#drumGrad)\" stroke=\"#3a2f1e\" stroke-width=\"1.4\"/>\n  <ellipse cx=\"272\" cy=\"188\" rx=\"28\" ry=\"13\" fill=\"#ffffff\" opacity=\"0.3\" filter=\"url(#blurSoft)\"/>\n  <circle cx=\"300\" cy=\"220\" r=\"86\" fill=\"none\" stroke=\"#7c6a4d\" stroke-width=\"1\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M300,150 Q325,155 335,180 L335,205 Q320,208 300,208 Z\" fill=\"url(#shoeGrad)\" stroke=\"#3a2f10\" stroke-width=\"1.2\"/>\n  <path d=\"M300,290 Q275,285 265,260 L265,235 Q280,232 300,232 Z\" fill=\"url(#shoeGrad)\" stroke=\"#3a2f10\" stroke-width=\"1.2\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <rect x=\"290\" y=\"205\" width=\"20\" height=\"30\" rx=\"4\" fill=\"url(#chromeTubeV)\" stroke=\"#050608\" stroke-width=\"1.1\"/>\n</g>\n<g filter=\"url(#softSh3)\">\n  <path d=\"M296,150 Q296,138 306,142\" fill=\"none\" stroke=\"url(#springSmall)\" stroke-width=\"3.5\" stroke-linecap=\"round\"/>\n  <path d=\"M296,290 Q296,302 306,298\" fill=\"none\" stroke=\"url(#springSmall)\" stroke-width=\"3.5\" stroke-linecap=\"round\"/>\n</g>\n<g filter=\"url(#dropSh3)\">\n  <path d=\"M260,205 L242,205 L242,225 L260,225 Z\" fill=\"url(#armGrad3)\" stroke=\"#0e1216\" stroke-width=\"1.1\"/>\n</g>\n<circle cx=\"300\" cy=\"200\" r=\"7\" fill=\"url(#bushGrad3)\" stroke=\"#050608\" stroke-width=\"1\" filter=\"url(#dropSh3)\"/>\n</svg>",
    "points": [
      {
        "point_number": 1,
        "x": 315,
        "y": 320,
        "part_name": "Tambor de freno"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 175,
        "part_name": "Zapata primaria (avanze)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 265,
        "part_name": "Zapata secundaria (retroceso)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 220,
        "part_name": "Cilindro de rueda (wheel cylinder)"
      },
      {
        "point_number": 5,
        "x": 290,
        "y": 145,
        "part_name": "Resorte de retorno superior"
      },
      {
        "point_number": 6,
        "x": 290,
        "y": 295,
        "part_name": "Resorte de retorno inferior"
      },
      {
        "point_number": 7,
        "x": 250,
        "y": 214,
        "part_name": "Actuador de freno de mano"
      },
      {
        "point_number": 8,
        "x": 326,
        "y": 198,
        "part_name": "Tensor automático (star adjuster)"
      }
    ]
  },
  {
    "vehicle_type": "camioneta",
    "system": "suspension_delantera",
    "configuration": "doble_horquilla",
    "name": "Suspensión delantera doble horquilla (camioneta)",
    "description": "Doble horquilla reforzada para camionetas — brazos más robustos, resorte más alto, diseñada para mayor carga.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/double-wishbone-heavy-duty.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"cDhCh\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"40%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"230\" cy=\"300\" r=\"92\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"230\" cy=\"300\" r=\"76\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><path d=\"M310,70 L310,200\" stroke=\"url(#cDhCh)\" stroke-width=\"10\" stroke-linecap=\"round\"/><path d=\"M322,80 C342,86 342,108 322,114 C302,120 302,142 322,148 C342,154 342,172 322,178\" fill=\"none\" stroke=\"#f59e0b\" stroke-width=\"6\" stroke-linecap=\"round\"/><circle cx=\"310\" cy=\"75\" r=\"11\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><path d=\"M295,200 L185,175 L165,170 L165,184 L185,189 L295,214 Z\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2.5\"/><circle cx=\"295\" cy=\"207\" r=\"11\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"165\" cy=\"177\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><path d=\"M310,310 L185,340 L165,340 L165,354 L185,354 L310,324 Z\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2.5\"/><circle cx=\"310\" cy=\"317\" r=\"11\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"165\" cy=\"347\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><path d=\"M320,245 L320,300 Q320,320 345,320 L370,320 Q395,320 395,300 L395,245 Z\" fill=\"url(#cDhCh)\" stroke=\"#1e3a8a\" stroke-width=\"2\"/><circle cx=\"357\" cy=\"280\" r=\"17\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"357\" cy=\"280\" r=\"7\" fill=\"#64748b\"/><line x1=\"140\" y1=\"150\" x2=\"500\" y2=\"150\" stroke=\"#4b5563\" stroke-width=\"6\" stroke-linecap=\"round\"/><line x1=\"300\" y1=\"150\" x2=\"300\" y2=\"200\" stroke=\"#4b5563\" stroke-width=\"5\" stroke-linecap=\"round\"/><line x1=\"440\" y1=\"150\" x2=\"465\" y2=\"270\" stroke=\"#4b5563\" stroke-width=\"5\" stroke-linecap=\"round\"/><circle cx=\"465\" cy=\"270\" r=\"7\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 310,
        "y": 140,
        "part_name": "Amortiguador reforzado"
      },
      {
        "point_number": 2,
        "x": 340,
        "y": 115,
        "part_name": "Resorte helicoidal (alto)"
      },
      {
        "point_number": 3,
        "x": 240,
        "y": 185,
        "part_name": "Brazo superior reforzado"
      },
      {
        "point_number": 4,
        "x": 165,
        "y": 177,
        "part_name": "Rótula superior"
      },
      {
        "point_number": 5,
        "x": 240,
        "y": 335,
        "part_name": "Brazo inferior reforzado"
      },
      {
        "point_number": 6,
        "x": 165,
        "y": 347,
        "part_name": "Rótula inferior"
      },
      {
        "point_number": 7,
        "x": 357,
        "y": 280,
        "part_name": "Mangueta (knuckle)"
      },
      {
        "point_number": 8,
        "x": 465,
        "y": 270,
        "part_name": "Terminal de dirección"
      },
      {
        "point_number": 9,
        "x": 440,
        "y": 150,
        "part_name": "Barra estabilizadora"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 175,
        "part_name": "Link de barra estabilizadora"
      },
      {
        "point_number": 11,
        "x": 357,
        "y": 320,
        "part_name": "Rodamiento de rueda"
      },
      {
        "point_number": 12,
        "x": 295,
        "y": 207,
        "part_name": "Buje brazo superior"
      }
    ]
  },
  {
    "vehicle_type": "camioneta",
    "system": "suspension_trasera",
    "configuration": "eje_rigido_ballestas",
    "name": "Suspensión trasera eje rígido con ballestas (camioneta)",
    "description": "Eje rígido con ballestas reforzadas de múltiples hojas — diseñado para carga pesada y remolque.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/solid-axle-leaf-spring-heavy-duty.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"cErAx\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#64748b\"/><stop offset=\"50%\" stop-color=\"#94a3b8\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient><linearGradient id=\"cErSh\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"50%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"170\" cy=\"280\" r=\"90\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"170\" cy=\"280\" r=\"74\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><circle cx=\"430\" cy=\"280\" r=\"90\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"430\" cy=\"280\" r=\"74\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"120\" y=\"195\" width=\"360\" height=\"35\" rx=\"10\" fill=\"url(#cErAx)\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"170\" cy=\"212\" r=\"9\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"430\" cy=\"212\" r=\"9\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1.5\"/><path d=\"M190,230 Q300,165 410,230\" fill=\"none\" stroke=\"#475569\" stroke-width=\"7\" stroke-linecap=\"round\"/><path d=\"M190,237 Q300,180 410,237\" fill=\"none\" stroke=\"#64748b\" stroke-width=\"5\" stroke-linecap=\"round\"/><path d=\"M190,243 Q300,195 410,243\" fill=\"none\" stroke=\"#94a3b8\" stroke-width=\"4\" stroke-linecap=\"round\"/><path d=\"M190,249 Q300,210 410,249\" fill=\"none\" stroke=\"#cbd5e1\" stroke-width=\"3\" stroke-linecap=\"round\"/><rect x=\"180\" y=\"140\" width=\"22\" height=\"60\" rx=\"4\" fill=\"url(#cErSh)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"398\" y=\"140\" width=\"22\" height=\"60\" rx=\"4\" fill=\"url(#cErSh)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"175\" y=\"134\" width=\"32\" height=\"12\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"393\" y=\"134\" width=\"32\" height=\"12\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"191\" cy=\"125\" r=\"7\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"409\" cy=\"125\" r=\"7\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><rect x=\"185\" y=\"225\" width=\"10\" height=\"15\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"405\" y=\"225\" width=\"10\" height=\"15\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 195,
        "part_name": "Ballesta (paquete de hojas)"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 212,
        "part_name": "Eje trasero (tubo)"
      },
      {
        "point_number": 3,
        "x": 191,
        "y": 125,
        "part_name": "Amortiguador"
      },
      {
        "point_number": 4,
        "x": 191,
        "y": 145,
        "part_name": "Soporte amortiguador"
      },
      {
        "point_number": 5,
        "x": 190,
        "y": 228,
        "part_name": "U-bolt (grapa)"
      },
      {
        "point_number": 6,
        "x": 170,
        "y": 280,
        "part_name": "Rodamiento de rueda"
      },
      {
        "point_number": 7,
        "x": 430,
        "y": 280,
        "part_name": "Rodamiento de rueda (opuesto)"
      },
      {
        "point_number": 8,
        "x": 190,
        "y": 245,
        "part_name": "Ojo de ballesta (shackle)"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 170,
        "part_name": "Centro de ballesta (clamp)"
      },
      {
        "point_number": 10,
        "x": 409,
        "y": 125,
        "part_name": "Amortiguador (opuesto)"
      }
    ]
  },
  {
    "vehicle_type": "camioneta",
    "system": "frenos_delanteros",
    "configuration": "disco_ventilado",
    "name": "Frenos delanteros — disco ventilado (camioneta)",
    "description": "Disco ventilado de mayor diámetro para camionetas — mayor capacidad de frenado para vehículos más pesados.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/front-disc-vented-heavy-duty.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"cDvDi\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#94a3b8\"/><stop offset=\"30%\" stop-color=\"#e2e8f0\"/><stop offset=\"70%\" stop-color=\"#cbd5e1\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient><linearGradient id=\"cDvCa\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#dc2626\"/><stop offset=\"50%\" stop-color=\"#ef4444\"/><stop offset=\"100%\" stop-color=\"#b91c1c\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"220\" r=\"150\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"220\" r=\"115\" fill=\"url(#cDvDi)\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"105\" fill=\"none\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"55\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"22\" fill=\"#94a3b8\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"220\" r=\"9\" fill=\"#64748b\"/><circle cx=\"300\" cy=\"220\" r=\"38\" fill=\"none\" stroke=\"#94a3b8\" stroke-width=\"1\" stroke-dasharray=\"3 3\"/><circle cx=\"330\" cy=\"195\" r=\"4.5\" fill=\"#475569\"/><circle cx=\"270\" cy=\"245\" r=\"4.5\" fill=\"#475569\"/><circle cx=\"350\" cy=\"220\" r=\"4.5\" fill=\"#475569\"/><circle cx=\"250\" cy=\"220\" r=\"4.5\" fill=\"#475569\"/><path d=\"M248,90 L248,170 Q248,182 260,182 L280,182 Q292,182 292,170 L292,90 Q292,78 280,78 L260,78 Q248,78 248,90 Z\" fill=\"url(#cDvCa)\" stroke=\"#7f1d1d\" stroke-width=\"2\"/><rect x=\"254\" y=\"98\" width=\"30\" height=\"68\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"256\" y=\"105\" width=\"26\" height=\"14\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><rect x=\"256\" y=\"125\" width=\"26\" height=\"14\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"270\" cy=\"84\" r=\"6\" fill=\"#374151\" stroke=\"#1f2937\" stroke-width=\"1\"/><path d=\"M248,135 L230,135 L230,148 L248,148\" fill=\"none\" stroke=\"#4b5563\" stroke-width=\"2.5\" stroke-linecap=\"round\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 340,
        "part_name": "Disco ventilado (grande)"
      },
      {
        "point_number": 2,
        "x": 270,
        "y": 140,
        "part_name": "Mordaza (caliper)"
      },
      {
        "point_number": 3,
        "x": 256,
        "y": 110,
        "part_name": "Pastilla interior"
      },
      {
        "point_number": 4,
        "x": 256,
        "y": 132,
        "part_name": "Pastilla exterior"
      },
      {
        "point_number": 5,
        "x": 270,
        "y": 84,
        "part_name": "Perno guía del caliper"
      },
      {
        "point_number": 6,
        "x": 270,
        "y": 90,
        "part_name": "Portamordaza (bracket)"
      },
      {
        "point_number": 7,
        "x": 235,
        "y": 140,
        "part_name": "Latiguillo de freno"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 220,
        "part_name": "Buje central (hub)"
      },
      {
        "point_number": 9,
        "x": 395,
        "y": 190,
        "part_name": "Tornillos de rueda"
      }
    ]
  },
  {
    "vehicle_type": "camioneta",
    "system": "frenos_traseros",
    "configuration": "tambor",
    "name": "Frenos traseros — tambor (camioneta)",
    "description": "Tambor reforzado para camionetas — zapatas más anchas y cilindro de rueda de mayor capacidad.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/rear-drum-heavy-duty.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"cFtDr\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#cbd5e1\"/><stop offset=\"40%\" stop-color=\"#e2e8f0\"/><stop offset=\"100%\" stop-color=\"#94a3b8\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"220\" r=\"150\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"220\" r=\"120\" fill=\"url(#cFtDr)\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"110\" fill=\"#e2e8f0\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"50\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"18\" fill=\"#94a3b8\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"220\" r=\"7\" fill=\"#64748b\"/><path d=\"M278,220 L278,130 Q278,118 290,118 L310,118 Q322,118 322,130 L322,220\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"1.5\"/><path d=\"M278,220 L278,310 Q278,322 290,322 L310,322 Q322,322 322,310 L322,220\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"1.5\"/><circle cx=\"290\" cy=\"132\" r=\"3.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"132\" r=\"3.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"290\" cy=\"308\" r=\"3.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"308\" r=\"3.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"6\" fill=\"#9ca3af\" stroke=\"#4b5563\" stroke-width=\"1\"/><rect x=\"294\" y=\"165\" width=\"12\" height=\"30\" rx=\"2\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><path d=\"M283,175 L270,188\" stroke=\"#6b7280\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><path d=\"M317,175 L330,188\" stroke=\"#6b7280\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><rect x=\"245\" y=\"208\" width=\"22\" height=\"10\" rx=\"2\" fill=\"#9ca3af\" stroke=\"#4b5563\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 325,
        "part_name": "Tambor de freno"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 170,
        "part_name": "Zapata primaria (avanze)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 270,
        "part_name": "Zapata secundaria (retroceso)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 220,
        "part_name": "Cilindro de rueda"
      },
      {
        "point_number": 5,
        "x": 290,
        "y": 132,
        "part_name": "Resorte de retorno superior"
      },
      {
        "point_number": 6,
        "x": 290,
        "y": 308,
        "part_name": "Resorte de retorno inferior"
      },
      {
        "point_number": 7,
        "x": 245,
        "y": 213,
        "part_name": "Actuador de freno de mano"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 195,
        "part_name": "Tensor automático"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 220,
        "part_name": "Resorte del tensor"
      }
    ]
  },
  {
    "vehicle_type": "camion",
    "system": "suspension_delantera",
    "configuration": "eje_rigido_ballestas",
    "name": "Suspensión delantera eje rígido con ballestas (camión)",
    "description": "Eje rígido delantero con ballestas longitudinales — configuración estándar en camiones de carga media y pesada.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/solid-axle-leaf-spring-truck-front.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"tErAx\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#64748b\"/><stop offset=\"50%\" stop-color=\"#94a3b8\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient><linearGradient id=\"tErSh\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"50%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"170\" cy=\"290\" r=\"95\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"170\" cy=\"290\" r=\"78\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><circle cx=\"430\" cy=\"290\" r=\"95\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"430\" cy=\"290\" r=\"78\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"110\" y=\"200\" width=\"380\" height=\"40\" rx=\"12\" fill=\"url(#tErAx)\" stroke=\"#475569\" stroke-width=\"2.5\"/><circle cx=\"170\" cy=\"220\" r=\"10\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"430\" cy=\"220\" r=\"10\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><path d=\"M185,240 Q300,160 415,240\" fill=\"none\" stroke=\"#475569\" stroke-width=\"8\" stroke-linecap=\"round\"/><path d=\"M185,248 Q300,175 415,248\" fill=\"none\" stroke=\"#64748b\" stroke-width=\"6\" stroke-linecap=\"round\"/><path d=\"M185,255 Q300,190 415,255\" fill=\"none\" stroke=\"#94a3b8\" stroke-width=\"4\" stroke-linecap=\"round\"/><path d=\"M185,261 Q300,205 415,261\" fill=\"none\" stroke=\"#cbd5e1\" stroke-width=\"3\" stroke-linecap=\"round\"/><rect x=\"175\" y=\"135\" width=\"25\" height=\"70\" rx=\"5\" fill=\"url(#tErSh)\" stroke=\"#1e3a8a\" stroke-width=\"2\"/><rect x=\"400\" y=\"135\" width=\"25\" height=\"70\" rx=\"5\" fill=\"url(#tErSh)\" stroke=\"#1e3a8a\" stroke-width=\"2\"/><rect x=\"170\" y=\"128\" width=\"35\" height=\"14\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"395\" y=\"128\" width=\"35\" height=\"14\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"187\" cy=\"118\" r=\"8\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"412\" cy=\"118\" r=\"8\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><rect x=\"180\" y=\"235\" width=\"12\" height=\"18\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"408\" y=\"235\" width=\"12\" height=\"18\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 200,
        "part_name": "Ballesta delantera"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 220,
        "part_name": "Eje delantero (tubo)"
      },
      {
        "point_number": 3,
        "x": 187,
        "y": 118,
        "part_name": "Amortiguador"
      },
      {
        "point_number": 4,
        "x": 187,
        "y": 140,
        "part_name": "Soporte amortiguador"
      },
      {
        "point_number": 5,
        "x": 185,
        "y": 238,
        "part_name": "U-bolt (grapa)"
      },
      {
        "point_number": 6,
        "x": 170,
        "y": 290,
        "part_name": "Rodamiento de rueda"
      },
      {
        "point_number": 7,
        "x": 430,
        "y": 290,
        "part_name": "Rodamiento de rueda (opuesto)"
      },
      {
        "point_number": 8,
        "x": 185,
        "y": 255,
        "part_name": "Ojo de ballesta"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 175,
        "part_name": "Centro de ballesta (clamp)"
      },
      {
        "point_number": 10,
        "x": 412,
        "y": 118,
        "part_name": "Amortiguador (opuesto)"
      },
      {
        "point_number": 11,
        "x": 300,
        "y": 240,
        "part_name": "Dirección (pitman arm)"
      },
      {
        "point_number": 12,
        "x": 415,
        "y": 280,
        "part_name": "Terminal de dirección"
      }
    ]
  },
  {
    "vehicle_type": "camion",
    "system": "suspension_trasera",
    "configuration": "tandem_ballestas",
    "name": "Suspensión trasera tandem con ballestas (camión)",
    "description": "Doble eje trasero (tandem) con ballestas reforzadas — configuración estándar en camiones de carga pesada.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/tandem-leaf-spring-truck.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"tTdAx\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#64748b\"/><stop offset=\"50%\" stop-color=\"#94a3b8\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient><linearGradient id=\"tTdSh\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"50%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"150\" cy=\"290\" r=\"90\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"150\" cy=\"290\" r=\"74\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"290\" r=\"90\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"290\" r=\"74\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><circle cx=\"450\" cy=\"290\" r=\"90\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"450\" cy=\"290\" r=\"74\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"100\" y=\"195\" width=\"400\" height=\"35\" rx=\"10\" fill=\"url(#tTdAx)\" stroke=\"#475569\" stroke-width=\"2.5\"/><rect x=\"120\" y=\"230\" width=\"360\" height=\"30\" rx=\"8\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"150\" cy=\"212\" r=\"10\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"212\" r=\"10\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"450\" cy=\"212\" r=\"10\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><path d=\"M160,245 Q300,170 440,245\" fill=\"none\" stroke=\"#475569\" stroke-width=\"8\" stroke-linecap=\"round\"/><path d=\"M160,253 Q300,185 440,253\" fill=\"none\" stroke=\"#64748b\" stroke-width=\"6\" stroke-linecap=\"round\"/><path d=\"M160,260 Q300,200 440,260\" fill=\"none\" stroke=\"#94a3b8\" stroke-width=\"4\" stroke-linecap=\"round\"/><rect x=\"155\" y=\"135\" width=\"22\" height=\"65\" rx=\"4\" fill=\"url(#tTdSh)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"430\" y=\"135\" width=\"22\" height=\"65\" rx=\"4\" fill=\"url(#tTdSh)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"150\" y=\"128\" width=\"32\" height=\"12\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"425\" y=\"128\" width=\"32\" height=\"12\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"166\" cy=\"118\" r=\"7\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"441\" cy=\"118\" r=\"7\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><rect x=\"155\" y=\"240\" width=\"12\" height=\"15\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"435\" y=\"240\" width=\"12\" height=\"15\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 195,
        "part_name": "Ballesta tandem"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 245,
        "part_name": "Eje delantero tandem"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 245,
        "part_name": "Eje trasero tandem"
      },
      {
        "point_number": 4,
        "x": 166,
        "y": 118,
        "part_name": "Amortiguador"
      },
      {
        "point_number": 5,
        "x": 160,
        "y": 248,
        "part_name": "U-bolt (grapa)"
      },
      {
        "point_number": 6,
        "x": 150,
        "y": 290,
        "part_name": "Rodamiento rueda delantera"
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 290,
        "part_name": "Rodamiento rueda central"
      },
      {
        "point_number": 8,
        "x": 450,
        "y": 290,
        "part_name": "Rodamiento rueda trasera"
      },
      {
        "point_number": 9,
        "x": 160,
        "y": 260,
        "part_name": "Ojo de ballesta"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 170,
        "part_name": "Centro de ballesta (clamp)"
      },
      {
        "point_number": 11,
        "x": 441,
        "y": 118,
        "part_name": "Amortiguador (opuesto)"
      },
      {
        "point_number": 12,
        "x": 300,
        "y": 212,
        "part_name": "Bogie (balanceador)"
      }
    ]
  },
  {
    "vehicle_type": "camion",
    "system": "frenos_delanteros",
    "configuration": "tambor_neumatico",
    "name": "Frenos delanteros — tambor neumático (camión)",
    "description": "Tambor de freno con actuador neumático — sistema de frenos estándar en camiones de carga pesada.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/front-drum-air-truck.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"tFnDr\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#cbd5e1\"/><stop offset=\"40%\" stop-color=\"#e2e8f0\"/><stop offset=\"100%\" stop-color=\"#94a3b8\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"220\" r=\"150\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"220\" r=\"120\" fill=\"url(#tFnDr)\" stroke=\"#64748b\" stroke-width=\"2.5\"/><circle cx=\"300\" cy=\"220\" r=\"110\" fill=\"#e2e8f0\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"55\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"20\" fill=\"#94a3b8\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"220\" r=\"8\" fill=\"#64748b\"/><path d=\"M278,220 L278,120 Q278,108 290,108 L310,108 Q322,108 322,120 L322,220\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"2\"/><path d=\"M278,220 L278,320 Q278,332 290,332 L310,332 Q322,332 322,320 L322,220\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"2\"/><circle cx=\"290\" cy=\"122\" r=\"4\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"122\" r=\"4\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"290\" cy=\"318\" r=\"4\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"318\" r=\"4\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"7\" fill=\"#94a3b8\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"293\" y=\"160\" width=\"14\" height=\"35\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><path d=\"M280,175 L265,190\" stroke=\"#64748b\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M320,175 L335,190\" stroke=\"#64748b\" stroke-width=\"3\" stroke-linecap=\"round\"/><rect x=\"230\" y=\"200\" width=\"30\" height=\"45\" rx=\"5\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><rect x=\"235\" y=\"208\" width=\"20\" height=\"12\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"235\" y=\"225\" width=\"20\" height=\"12\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"245\" cy=\"195\" r=\"4\" fill=\"#374151\"/><line x1=\"260\" y1=\"215\" x2=\"278\" y2=\"215\" stroke=\"#475569\" stroke-width=\"3\" stroke-linecap=\"round\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 335,
        "part_name": "Tambor de freno"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 165,
        "part_name": "Zapata primaria (avanze)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 275,
        "part_name": "Zapata secundaria (retroceso)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 220,
        "part_name": "Cilindro de rueda"
      },
      {
        "point_number": 5,
        "x": 290,
        "y": 122,
        "part_name": "Resorte de retorno superior"
      },
      {
        "point_number": 6,
        "x": 290,
        "y": 318,
        "part_name": "Resorte de retorno inferior"
      },
      {
        "point_number": 7,
        "x": 245,
        "y": 215,
        "part_name": "Actuador neumático (chamber)"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 195,
        "part_name": "Tensor automático"
      },
      {
        "point_number": 9,
        "x": 260,
        "y": 215,
        "part_name": "Varilla de empuje (push rod)"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 220,
        "part_name": "Resorte del tensor"
      }
    ]
  },
  {
    "vehicle_type": "camion",
    "system": "frenos_traseros",
    "configuration": "tambor_neumatico_doble",
    "name": "Frenos traseros — tambor neumático doble (camión)",
    "description": "Tambor de freno con doble actuador neumático para eje tandem — máxima capacidad de frenado en camiones pesados.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/rear-drum-air-dual-truck.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"tFtDr\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#cbd5e1\"/><stop offset=\"40%\" stop-color=\"#e2e8f0\"/><stop offset=\"100%\" stop-color=\"#94a3b8\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"220\" r=\"155\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"220\" r=\"125\" fill=\"url(#tFtDr)\" stroke=\"#64748b\" stroke-width=\"2.5\"/><circle cx=\"300\" cy=\"220\" r=\"115\" fill=\"#e2e8f0\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"58\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"22\" fill=\"#94a3b8\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"220\" r=\"9\" fill=\"#64748b\"/><path d=\"M276,220 L276,115 Q276,102 290,102 L310,102 Q324,102 324,115 L324,220\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"2\"/><path d=\"M276,220 L276,325 Q276,338 290,338 L310,338 Q324,338 324,325 L324,220\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"2\"/><circle cx=\"290\" cy=\"116\" r=\"4.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"116\" r=\"4.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"290\" cy=\"324\" r=\"4.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"324\" r=\"4.5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"8\" fill=\"#94a3b8\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"292\" y=\"155\" width=\"16\" height=\"40\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><path d=\"M278,172 L260,190\" stroke=\"#64748b\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M322,172 L340,190\" stroke=\"#64748b\" stroke-width=\"3\" stroke-linecap=\"round\"/><rect x=\"220\" y=\"180\" width=\"28\" height=\"40\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><rect x=\"225\" y=\"188\" width=\"18\" height=\"10\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"225\" y=\"203\" width=\"18\" height=\"10\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"234\" cy=\"175\" r=\"4\" fill=\"#374151\"/><line x1=\"248\" y1=\"195\" x2=\"276\" y2=\"195\" stroke=\"#475569\" stroke-width=\"3\" stroke-linecap=\"round\"/><rect x=\"352\" y=\"180\" width=\"28\" height=\"40\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><rect x=\"357\" y=\"188\" width=\"18\" height=\"10\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"357\" y=\"203\" width=\"18\" height=\"10\" rx=\"2\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"366\" cy=\"175\" r=\"4\" fill=\"#374151\"/><line x1=\"352\" y1=\"195\" x2=\"324\" y2=\"195\" stroke=\"#475569\" stroke-width=\"3\" stroke-linecap=\"round\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 340,
        "part_name": "Tambor de freno"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 160,
        "part_name": "Zapata primaria (avanze)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 280,
        "part_name": "Zapata secundaria (retroceso)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 220,
        "part_name": "Cilindro de rueda"
      },
      {
        "point_number": 5,
        "x": 290,
        "y": 116,
        "part_name": "Resorte de retorno superior"
      },
      {
        "point_number": 6,
        "x": 290,
        "y": 324,
        "part_name": "Resorte de retorno inferior"
      },
      {
        "point_number": 7,
        "x": 234,
        "y": 195,
        "part_name": "Actuador neumático primario"
      },
      {
        "point_number": 8,
        "x": 366,
        "y": 195,
        "part_name": "Actuador neumático secundario"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 195,
        "part_name": "Tensor automático"
      },
      {
        "point_number": 10,
        "x": 248,
        "y": 195,
        "part_name": "Varilla de empuje primaria"
      },
      {
        "point_number": 11,
        "x": 352,
        "y": 195,
        "part_name": "Varilla de empuje secundaria"
      },
      {
        "point_number": 12,
        "x": 300,
        "y": 220,
        "part_name": "Resorte del tensor"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "suspension_delantera",
    "configuration": "telescopica_convencional",
    "name": "Suspensión delantera telescópica convencional",
    "description": "Horquilla telescópica convencional — la más común en motocicletas.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/telescopic-fork.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mTelT\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"40%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient><linearGradient id=\"mTelS\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"40%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"320\" r=\"70\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"320\" r=\"55\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"280\" y=\"80\" width=\"18\" height=\"180\" rx=\"4\" fill=\"url(#mTelT)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"302\" y=\"80\" width=\"18\" height=\"180\" rx=\"4\" fill=\"url(#mTelT)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"276\" y=\"200\" width=\"26\" height=\"130\" rx=\"5\" fill=\"url(#mTelS)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"298\" y=\"200\" width=\"26\" height=\"130\" rx=\"5\" fill=\"url(#mTelS)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"270\" y=\"70\" width=\"60\" height=\"25\" rx=\"6\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"82\" r=\"8\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><rect x=\"260\" y=\"325\" width=\"80\" height=\"12\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"320\" r=\"12\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"320\" r=\"5\" fill=\"#64748b\"/><rect x=\"282\" y=\"195\" width=\"36\" height=\"10\" rx=\"2\" fill=\"#1e293b\" stroke=\"#0f172a\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 289,
        "y": 140,
        "part_name": "Tubo superior (inner tube)"
      },
      {
        "point_number": 2,
        "x": 282,
        "y": 205,
        "part_name": "Slider (tubo inferior)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 82,
        "part_name": "Tuerca superior (top cap)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 70,
        "part_name": "Trípode (yoke/triple clamp)"
      },
      {
        "point_number": 5,
        "x": 300,
        "y": 195,
        "part_name": "Retén de aceite (oil seal)"
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 160,
        "part_name": "Resorte interno"
      },
      {
        "point_number": 7,
        "x": 289,
        "y": 120,
        "part_name": "Árbol de dirección (steering stem)"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 320,
        "part_name": "Eje de rueda"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "suspension_delantera",
    "configuration": "invertida_usd",
    "name": "Suspensión delantera invertida (USD)",
    "description": "Horquilla invertida — tubos más gruesos arriba, mayor rigidez, común en motos deportivas.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/upside-down-fork.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mUsdT\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"40%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"320\" r=\"70\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"320\" r=\"55\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"276\" y=\"80\" width=\"22\" height=\"170\" rx=\"5\" fill=\"url(#mUsdT)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"302\" y=\"80\" width=\"22\" height=\"170\" rx=\"5\" fill=\"url(#mUsdT)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"280\" y=\"200\" width=\"18\" height=\"130\" rx=\"4\" fill=\"#3b82f6\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"302\" y=\"200\" width=\"18\" height=\"130\" rx=\"4\" fill=\"#3b82f6\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"265\" y=\"68\" width=\"70\" height=\"28\" rx=\"7\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"82\" r=\"9\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><rect x=\"260\" y=\"325\" width=\"80\" height=\"12\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"320\" r=\"12\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"320\" r=\"5\" fill=\"#64748b\"/><rect x=\"284\" y=\"85\" width=\"32\" height=\"10\" rx=\"2\" fill=\"#1e293b\" stroke=\"#0f172a\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 292,
        "y": 130,
        "part_name": "Tubo inferior (outer tube)"
      },
      {
        "point_number": 2,
        "x": 289,
        "y": 230,
        "part_name": "Slider (tubo superior, invertido)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 82,
        "part_name": "Tuerca superior (top cap)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 70,
        "part_name": "Trípode superior (upper yoke)"
      },
      {
        "point_number": 5,
        "x": 300,
        "y": 200,
        "part_name": "Retén de aceite (dust seal)"
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 150,
        "part_name": "Resorte interno"
      },
      {
        "point_number": 7,
        "x": 292,
        "y": 100,
        "part_name": "Árbol de dirección"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 320,
        "part_name": "Eje de rueda"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "suspension_delantera",
    "configuration": "leading_link",
    "name": "Suspensión delantera leading link (scooter)",
    "description": "Brazo oscilante delantero con amortiguador — típica de scooters y motos clásicas.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/leading-link.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mLlA\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#64748b\"/><stop offset=\"100%\" stop-color=\"#475569\"/></linearGradient><linearGradient id=\"mLlSh\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"50%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"310\" r=\"65\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"300\" cy=\"310\" r=\"52\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><path d=\"M280,120 L280,200 L300,310 L320,310 L320,200 L320,120 Z\" fill=\"url(#mLlA)\" stroke=\"#334155\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"120\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"120\" r=\"4\" fill=\"#64748b\"/><rect x=\"260\" y=\"65\" width=\"80\" height=\"20\" rx=\"5\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><rect x=\"250\" y=\"150\" width=\"22\" height=\"80\" rx=\"4\" fill=\"url(#mLlSh)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"260\" y=\"315\" width=\"80\" height=\"10\" rx=\"3\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"310\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"310\" r=\"4\" fill=\"#64748b\"/><path d=\"M260,160 C240,170 240,200 260,210\" fill=\"none\" stroke=\"#f59e0b\" stroke-width=\"4\" stroke-linecap=\"round\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 120,
        "part_name": "Pivote del brazo (pivot bolt)"
      },
      {
        "point_number": 2,
        "x": 290,
        "y": 210,
        "part_name": "Brazo oscilante (leading link)"
      },
      {
        "point_number": 3,
        "x": 260,
        "y": 190,
        "part_name": "Amortiguador"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 310,
        "part_name": "Eje de rueda"
      },
      {
        "point_number": 5,
        "x": 260,
        "y": 75,
        "part_name": "Trípode / columna de dirección"
      },
      {
        "point_number": 6,
        "x": 260,
        "y": 160,
        "part_name": "Resorte del amortiguador"
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 120,
        "part_name": "Rodamiento de dirección"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "suspension_trasera",
    "configuration": "monoamortiguador",
    "name": "Suspensión trasera monoamortiguador",
    "description": "Un solo amortiguador central conectado al basculante — la más común en motos modernas.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/mono-shock.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mMono\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"50%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"400\" cy=\"280\" r=\"65\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"400\" cy=\"280\" r=\"52\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><path d=\"M200,200 L400,260 L400,300 L200,240 Z\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"200\" cy=\"220\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"200\" cy=\"220\" r=\"4\" fill=\"#64748b\"/><circle cx=\"400\" cy=\"280\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"400\" cy=\"280\" r=\"4\" fill=\"#64748b\"/><rect x=\"280\" y=\"120\" width=\"16\" height=\"90\" rx=\"4\" fill=\"url(#mMono)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><path d=\"M288,125 C300,130 300,150 288,155 C276,160 276,180 288,185 C300,190 300,205 288,210\" fill=\"none\" stroke=\"#f59e0b\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"288\" cy=\"115\" r=\"6\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"288\" cy=\"215\" r=\"6\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><line x1=\"288\" y1=\"215\" x2=\"340\" y2=\"250\" stroke=\"#475569\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"340\" cy=\"250\" r=\"5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><line x1=\"200\" y1=\"170\" x2=\"200\" y2=\"280\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><circle cx=\"200\" cy=\"170\" r=\"6\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 288,
        "y": 160,
        "part_name": "Amortiguador trasero (mono-shock)"
      },
      {
        "point_number": 2,
        "x": 295,
        "y": 140,
        "part_name": "Resorte del amortiguador"
      },
      {
        "point_number": 3,
        "x": 288,
        "y": 115,
        "part_name": "Pivote superior del amortiguador"
      },
      {
        "point_number": 4,
        "x": 340,
        "y": 250,
        "part_name": "Brazo de progresión (linkage)"
      },
      {
        "point_number": 5,
        "x": 200,
        "y": 220,
        "part_name": "Pivote del basculante"
      },
      {
        "point_number": 6,
        "x": 290,
        "y": 250,
        "part_name": "Basculante (swingarm)"
      },
      {
        "point_number": 7,
        "x": 400,
        "y": 280,
        "part_name": "Eje de rueda trasera"
      },
      {
        "point_number": 8,
        "x": 200,
        "y": 170,
        "part_name": "Soporte del basculante (frame)"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "suspension_trasera",
    "configuration": "doble_amortiguador",
    "name": "Suspensión trasera doble amortiguador",
    "description": "Dos amortiguadores laterales — típica de motos clásicas, custom y algunas naked.",
    "view_box": "0 0 600 400",
    "image_path": "suspension/dual-shock.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mDbl\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"50%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"400\" cy=\"280\" r=\"65\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"400\" cy=\"280\" r=\"52\" fill=\"#e5e7eb\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><path d=\"M200,200 L400,260 L400,300 L200,240 Z\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"200\" cy=\"220\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"200\" cy=\"220\" r=\"4\" fill=\"#64748b\"/><circle cx=\"400\" cy=\"280\" r=\"10\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"400\" cy=\"280\" r=\"4\" fill=\"#64748b\"/><rect x=\"310\" y=\"140\" width=\"14\" height=\"85\" rx=\"3\" fill=\"url(#mDbl)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><rect x=\"340\" y=\"140\" width=\"14\" height=\"85\" rx=\"3\" fill=\"url(#mDbl)\" stroke=\"#1e3a8a\" stroke-width=\"1.5\"/><path d=\"M317,145 C327,150 327,165 317,170 C307,175 307,190 317,195 C327,200 327,215 317,220\" fill=\"none\" stroke=\"#f59e0b\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><path d=\"M347,145 C357,150 357,165 347,170 C337,175 337,190 347,195 C357,200 357,215 347,220\" fill=\"none\" stroke=\"#f59e0b\" stroke-width=\"2.5\" stroke-linecap=\"round\"/><circle cx=\"317\" cy=\"135\" r=\"5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"347\" cy=\"135\" r=\"5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"317\" cy=\"230\" r=\"5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><circle cx=\"347\" cy=\"230\" r=\"5\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><line x1=\"317\" y1=\"230\" x2=\"370\" y2=\"260\" stroke=\"#475569\" stroke-width=\"2\" stroke-linecap=\"round\"/><line x1=\"347\" y1=\"230\" x2=\"370\" y2=\"260\" stroke=\"#475569\" stroke-width=\"2\" stroke-linecap=\"round\"/><line x1=\"200\" y1=\"170\" x2=\"200\" y2=\"280\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><circle cx=\"200\" cy=\"170\" r=\"6\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 317,
        "y": 175,
        "part_name": "Amortiguador izquierdo"
      },
      {
        "point_number": 2,
        "x": 347,
        "y": 175,
        "part_name": "Amortiguador derecho"
      },
      {
        "point_number": 3,
        "x": 325,
        "y": 150,
        "part_name": "Resorte (izquierdo)"
      },
      {
        "point_number": 4,
        "x": 355,
        "y": 150,
        "part_name": "Resorte (derecho)"
      },
      {
        "point_number": 5,
        "x": 200,
        "y": 220,
        "part_name": "Pivote del basculante"
      },
      {
        "point_number": 6,
        "x": 330,
        "y": 250,
        "part_name": "Basculante (swingarm)"
      },
      {
        "point_number": 7,
        "x": 400,
        "y": 280,
        "part_name": "Eje de rueda trasera"
      },
      {
        "point_number": 8,
        "x": 370,
        "y": 260,
        "part_name": "Pivote inferior amortiguadores"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "frenos",
    "configuration": "disco_delantero_tambor_trasero",
    "name": "Frenos — disco delantero + tambor trasero",
    "description": "Configuración más común en motos económicas: disco ventilado delantero con mordaza, tambor trasero con zapatas.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/moto-disc-front-drum-rear.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mDdDi\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#94a3b8\"/><stop offset=\"50%\" stop-color=\"#e2e8f0\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient><linearGradient id=\"mDdCa\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#dc2626\"/><stop offset=\"100%\" stop-color=\"#991b1b\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><text x=\"170\" y=\"28\" text-anchor=\"middle\" font-size=\"11\" fill=\"#6b7280\" font-weight=\"bold\">DELANTERO</text><text x=\"450\" y=\"28\" text-anchor=\"middle\" font-size=\"11\" fill=\"#6b7280\" font-weight=\"bold\">TRASERO</text><circle cx=\"170\" cy=\"200\" r=\"80\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"170\" cy=\"200\" r=\"60\" fill=\"url(#mDdDi)\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"170\" cy=\"200\" r=\"25\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"170\" cy=\"200\" r=\"8\" fill=\"#64748b\"/><circle cx=\"175\" cy=\"180\" r=\"3\" fill=\"#475569\"/><circle cx=\"165\" cy=\"220\" r=\"3\" fill=\"#475569\"/><circle cx=\"190\" cy=\"200\" r=\"3\" fill=\"#475569\"/><circle cx=\"150\" cy=\"200\" r=\"3\" fill=\"#475569\"/><path d=\"M135,130 L135,170 Q135,178 143,178 L155,178 Q163,178 163,170 L163,130 Q163,122 155,122 L143,122 Q135,122 135,130 Z\" fill=\"url(#mDdCa)\" stroke=\"#7f1d1d\" stroke-width=\"1.5\"/><rect x=\"140\" y=\"135\" width=\"18\" height=\"35\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"149\" cy=\"127\" r=\"3\" fill=\"#374151\"/><circle cx=\"450\" cy=\"200\" r=\"75\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"450\" cy=\"200\" r=\"60\" fill=\"#e2e8f0\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"450\" cy=\"200\" r=\"55\" fill=\"#f1f5f9\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"450\" cy=\"200\" r=\"22\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"450\" cy=\"200\" r=\"7\" fill=\"#64748b\"/><path d=\"M440,200 L440,155 Q440,148 448,148 L452,148 Q460,148 460,155 L460,200\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"1\"/><path d=\"M440,200 L440,245 Q440,252 448,252 L452,252 Q460,252 460,245 L460,200\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"1\"/><circle cx=\"448\" cy=\"155\" r=\"2.5\" fill=\"#cbd5e1\"/><circle cx=\"452\" cy=\"155\" r=\"2.5\" fill=\"#cbd5e1\"/><circle cx=\"448\" cy=\"245\" r=\"2.5\" fill=\"#cbd5e1\"/><circle cx=\"452\" cy=\"245\" r=\"2.5\" fill=\"#cbd5e1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 170,
        "y": 260,
        "part_name": "Disco delantero"
      },
      {
        "point_number": 2,
        "x": 149,
        "y": 155,
        "part_name": "Mordaza delantera (caliper)"
      },
      {
        "point_number": 3,
        "x": 140,
        "y": 140,
        "part_name": "Pastillas de freno"
      },
      {
        "point_number": 4,
        "x": 149,
        "y": 127,
        "part_name": "Perno guía del caliper"
      },
      {
        "point_number": 5,
        "x": 170,
        "y": 200,
        "part_name": "Buje central delantero"
      },
      {
        "point_number": 6,
        "x": 450,
        "y": 252,
        "part_name": "Tambor trasero"
      },
      {
        "point_number": 7,
        "x": 450,
        "y": 175,
        "part_name": "Zapata trasera"
      },
      {
        "point_number": 8,
        "x": 450,
        "y": 200,
        "part_name": "Cilindro de rueda trasero"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "frenos",
    "configuration": "disco_doble",
    "name": "Frenos — disco doble (delantero + trasero)",
    "description": "Discos tanto adelante como atrás — motos deportivas y naked de alta cilindrada.",
    "view_box": "0 0 600 400",
    "image_path": "brakes/moto-disc-front-disc-rear.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mDblDi\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#94a3b8\"/><stop offset=\"50%\" stop-color=\"#e2e8f0\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><text x=\"170\" y=\"28\" text-anchor=\"middle\" font-size=\"11\" fill=\"#6b7280\" font-weight=\"bold\">DELANTERO</text><text x=\"450\" y=\"28\" text-anchor=\"middle\" font-size=\"11\" fill=\"#6b7280\" font-weight=\"bold\">TRASERO</text><circle cx=\"170\" cy=\"200\" r=\"85\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\" stroke-dasharray=\"4 3\"/><circle cx=\"170\" cy=\"200\" r=\"65\" fill=\"url(#mDblDi)\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"170\" cy=\"200\" r=\"28\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"170\" cy=\"200\" r=\"9\" fill=\"#64748b\"/><circle cx=\"178\" cy=\"178\" r=\"3.5\" fill=\"#475569\"/><circle cx=\"162\" cy=\"222\" r=\"3.5\" fill=\"#475569\"/><circle cx=\"195\" cy=\"200\" r=\"3.5\" fill=\"#475569\"/><circle cx=\"145\" cy=\"200\" r=\"3.5\" fill=\"#475569\"/><path d=\"M130,125 L130,172 Q130,180 140,180 L158,180 Q168,180 168,172 L168,125 Q168,117 158,117 L140,117 Q130,117 130,125 Z\" fill=\"#dc2626\" stroke=\"#7f1d1d\" stroke-width=\"1.5\"/><rect x=\"136\" y=\"132\" width=\"26\" height=\"40\" rx=\"3\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"149\" cy=\"122\" r=\"3.5\" fill=\"#374151\"/><circle cx=\"450\" cy=\"200\" r=\"65\" fill=\"url(#mDblDi)\" stroke=\"#64748b\" stroke-width=\"2\"/><circle cx=\"450\" cy=\"200\" r=\"25\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"450\" cy=\"200\" r=\"8\" fill=\"#64748b\"/><circle cx=\"457\" cy=\"183\" r=\"3\" fill=\"#475569\"/><circle cx=\"443\" cy=\"217\" r=\"3\" fill=\"#475569\"/><path d=\"M425,140 L425,178 Q425,185 433,185 L445,185 Q453,185 453,178 L453,140 Q453,133 445,133 L433,133 Q425,133 425,140 Z\" fill=\"#dc2626\" stroke=\"#7f1d1d\" stroke-width=\"1.5\"/><rect x=\"430\" y=\"148\" width=\"18\" height=\"28\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"439\" cy=\"138\" r=\"3\" fill=\"#374151\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 170,
        "y": 265,
        "part_name": "Disco delantero"
      },
      {
        "point_number": 2,
        "x": 149,
        "y": 150,
        "part_name": "Mordaza delantera"
      },
      {
        "point_number": 3,
        "x": 140,
        "y": 138,
        "part_name": "Pastillas delanteras"
      },
      {
        "point_number": 4,
        "x": 170,
        "y": 200,
        "part_name": "Buje central delantero"
      },
      {
        "point_number": 5,
        "x": 450,
        "y": 265,
        "part_name": "Disco trasero"
      },
      {
        "point_number": 6,
        "x": 439,
        "y": 160,
        "part_name": "Mordaza trasera"
      },
      {
        "point_number": 7,
        "x": 430,
        "y": 148,
        "part_name": "Pastillas traseras"
      },
      {
        "point_number": 8,
        "x": 450,
        "y": 200,
        "part_name": "Buje central trasero"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "transmision",
    "configuration": "cadena_pinon_catalina",
    "name": "Transmisión por cadena — piñón y catalina",
    "description": "Sistema de transmisión más común en motocicletas: cadena de rodillos conectando piñón con catalina.",
    "view_box": "0 0 600 400",
    "image_path": "transmission/chain-sprocket.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"150\" cy=\"250\" r=\"45\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"2\"/><circle cx=\"150\" cy=\"250\" r=\"35\" fill=\"#eab308\" stroke=\"#a16207\" stroke-width=\"1\"/><circle cx=\"150\" cy=\"250\" r=\"15\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"150\" cy=\"250\" r=\"6\" fill=\"#64748b\"/><circle cx=\"420\" cy=\"250\" r=\"90\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"2\"/><circle cx=\"420\" cy=\"250\" r=\"78\" fill=\"#eab308\" stroke=\"#a16207\" stroke-width=\"1\"/><circle cx=\"420\" cy=\"250\" r=\"30\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"420\" cy=\"250\" r=\"12\" fill=\"#64748b\"/><path d=\"M150,205 Q285,160 420,205\" fill=\"none\" stroke=\"#1e293b\" stroke-width=\"3\"/><path d=\"M150,295 Q285,340 420,295\" fill=\"none\" stroke=\"#1e293b\" stroke-width=\"3\"/><line x1=\"105\" y1=\"250\" x2=\"70\" y2=\"250\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><rect x=\"40\" y=\"235\" width=\"35\" height=\"30\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><line x1=\"465\" y1=\"250\" x2=\"520\" y2=\"250\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><rect x=\"520\" y=\"235\" width=\"35\" height=\"30\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 150,
        "y": 250,
        "part_name": "Piñón (contratuerca)"
      },
      {
        "point_number": 2,
        "x": 150,
        "y": 215,
        "part_name": "Dientes del piñón"
      },
      {
        "point_number": 3,
        "x": 420,
        "y": 250,
        "part_name": "Catalina (diente de sierra)"
      },
      {
        "point_number": 4,
        "x": 420,
        "y": 175,
        "part_name": "Dientes de la catalina"
      },
      {
        "point_number": 5,
        "x": 285,
        "y": 180,
        "part_name": "Cadena (tramo superior)"
      },
      {
        "point_number": 6,
        "x": 285,
        "y": 320,
        "part_name": "Cadena (tramo inferior)"
      },
      {
        "point_number": 7,
        "x": 57,
        "y": 250,
        "part_name": "Caja de cambios (output shaft)"
      },
      {
        "point_number": 8,
        "x": 537,
        "y": 250,
        "part_name": "Eje de rueda trasera"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "transmision",
    "configuration": "banda_scooter",
    "name": "Transmisión por banda (scooter automática)",
    "description": "Banda de transmisión variable (CVT) con variador adelante y embrague centrífugo atrás.",
    "view_box": "0 0 600 400",
    "image_path": "transmission/cvt-belt-scooter.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><ellipse cx=\"150\" cy=\"250\" rx=\"40\" ry=\"55\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"2\"/><circle cx=\"150\" cy=\"250\" r=\"18\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"150\" cy=\"250\" r=\"7\" fill=\"#64748b\"/><ellipse cx=\"420\" cy=\"250\" rx=\"55\" ry=\"70\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"2\"/><circle cx=\"420\" cy=\"250\" r=\"25\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"420\" cy=\"250\" r=\"10\" fill=\"#64748b\"/><path d=\"M150,195 Q285,150 420,180\" fill=\"none\" stroke=\"#1e293b\" stroke-width=\"5\"/><path d=\"M150,305 Q285,350 420,320\" fill=\"none\" stroke=\"#1e293b\" stroke-width=\"5\"/><line x1=\"110\" y1=\"250\" x2=\"70\" y2=\"250\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><rect x=\"35\" y=\"235\" width=\"40\" height=\"30\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><line x1=\"475\" y1=\"250\" x2=\"530\" y2=\"250\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><rect x=\"530\" y=\"235\" width=\"35\" height=\"30\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 150,
        "y": 250,
        "part_name": "Variador (polea motriz)"
      },
      {
        "point_number": 2,
        "x": 150,
        "y": 210,
        "part_name": "Placa fija del variador"
      },
      {
        "point_number": 3,
        "x": 150,
        "y": 290,
        "part_name": "Placa móvil del variador"
      },
      {
        "point_number": 4,
        "x": 420,
        "y": 250,
        "part_name": "Embrague centrífugo (polea conducida)"
      },
      {
        "point_number": 5,
        "x": 420,
        "y": 190,
        "part_name": "Placa fija del embrague"
      },
      {
        "point_number": 6,
        "x": 420,
        "y": 310,
        "part_name": "Placa móvil del embrague"
      },
      {
        "point_number": 7,
        "x": 285,
        "y": 165,
        "part_name": "Banda de transmisión (tramo superior)"
      },
      {
        "point_number": 8,
        "x": 55,
        "y": 250,
        "part_name": "Eje del motor (cigüeñal)"
      },
      {
        "point_number": 9,
        "x": 545,
        "y": 250,
        "part_name": "Eje de rueda trasera"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "motor_culata",
    "configuration": "monocilindrico_aire",
    "name": "Motor monocilíndrico 4T — culata (aire)",
    "description": "Culata y tren de válvulas de motor monocilíndrico refrigerado por aire.",
    "view_box": "0 0 600 400",
    "image_path": "engine/single-cylinder-head-air-cooled.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mCul\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#3b4a5a\"/><stop offset=\"50%\" stop-color=\"#64748b\"/><stop offset=\"100%\" stop-color=\"#3b4a5a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><rect x=\"250\" y=\"80\" width=\"100\" height=\"50\" rx=\"8\" fill=\"url(#mCul)\" stroke=\"#1e293b\" stroke-width=\"2\"/><rect x=\"260\" y=\"60\" width=\"80\" height=\"25\" rx=\"5\" fill=\"#64748b\" stroke=\"#3b4a5a\" stroke-width=\"1.5\"/><rect x=\"240\" y=\"130\" width=\"120\" height=\"120\" rx=\"6\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><rect x=\"230\" y=\"140\" width=\"10\" height=\"30\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"230\" y=\"180\" width=\"10\" height=\"30\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"230\" y=\"220\" width=\"10\" height=\"30\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"360\" y=\"140\" width=\"10\" height=\"30\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"360\" y=\"180\" width=\"10\" height=\"30\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"360\" y=\"220\" width=\"10\" height=\"30\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"270\" y=\"100\" width=\"14\" height=\"35\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"316\" y=\"100\" width=\"14\" height=\"35\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"277\" cy=\"95\" r=\"4\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"1\"/><circle cx=\"323\" cy=\"95\" r=\"4\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"72\" r=\"8\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"72\" r=\"3\" fill=\"#64748b\"/><rect x=\"270\" y=\"250\" width=\"60\" height=\"100\" rx=\"5\" fill=\"#475569\" stroke=\"#334155\" stroke-width=\"2\"/><rect x=\"260\" y=\"260\" width=\"10\" height=\"20\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"260\" y=\"290\" width=\"10\" height=\"20\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"330\" y=\"260\" width=\"10\" height=\"20\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"330\" y=\"290\" width=\"10\" height=\"20\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 72,
        "part_name": "Árbol de levas (camshaft)"
      },
      {
        "point_number": 2,
        "x": 277,
        "y": 100,
        "part_name": "Válvula de admisión"
      },
      {
        "point_number": 3,
        "x": 323,
        "y": 100,
        "part_name": "Válvula de escape"
      },
      {
        "point_number": 4,
        "x": 277,
        "y": 95,
        "part_name": "Resorte de válvula (admisión)"
      },
      {
        "point_number": 5,
        "x": 323,
        "y": 95,
        "part_name": "Resorte de válvula (escape)"
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 130,
        "part_name": "Junta de culata (head gasket)"
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 190,
        "part_name": "Cilindro (con aletas)"
      },
      {
        "point_number": 8,
        "x": 265,
        "y": 170,
        "part_name": "Aletas de refrigeración"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 250,
        "part_name": "Culata (combustion chamber)"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 300,
        "part_name": "Bloque del cilindro"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "motor_culata",
    "configuration": "monocilindrico_liquido",
    "name": "Motor monocilíndrico 4T — culata (líquido)",
    "description": "Culata con refrigeración líquida — camisas de agua, termostato, bomba de agua.",
    "view_box": "0 0 600 400",
    "image_path": "engine/single-cylinder-head-liquid-cooled.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mCulL\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#3b4a5a\"/><stop offset=\"50%\" stop-color=\"#64748b\"/><stop offset=\"100%\" stop-color=\"#3b4a5a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><rect x=\"250\" y=\"80\" width=\"100\" height=\"50\" rx=\"8\" fill=\"url(#mCulL)\" stroke=\"#1e293b\" stroke-width=\"2\"/><rect x=\"260\" y=\"60\" width=\"80\" height=\"25\" rx=\"5\" fill=\"#64748b\" stroke=\"#3b4a5a\" stroke-width=\"1.5\"/><rect x=\"240\" y=\"130\" width=\"120\" height=\"120\" rx=\"6\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><rect x=\"235\" y=\"135\" width=\"130\" height=\"110\" rx=\"4\" fill=\"none\" stroke=\"#93c5fd\" stroke-width=\"1.5\" stroke-dasharray=\"4 2\"/><rect x=\"270\" y=\"100\" width=\"14\" height=\"35\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"316\" y=\"100\" width=\"14\" height=\"35\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"277\" cy=\"95\" r=\"4\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"1\"/><circle cx=\"323\" cy=\"95\" r=\"4\" fill=\"#ca8a04\" stroke=\"#854d0e\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"72\" r=\"8\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"72\" r=\"3\" fill=\"#64748b\"/><rect x=\"270\" y=\"250\" width=\"60\" height=\"100\" rx=\"5\" fill=\"#475569\" stroke=\"#334155\" stroke-width=\"2\"/><line x1=\"240\" y1=\"200\" x2=\"200\" y2=\"200\" stroke=\"#3b82f6\" stroke-width=\"3\" stroke-linecap=\"round\"/><line x1=\"200\" y1=\"200\" x2=\"200\" y2=\"280\" stroke=\"#3b82f6\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"200\" cy=\"280\" r=\"10\" fill=\"#dbeafe\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><text x=\"200\" y=\"284\" text-anchor=\"middle\" font-size=\"8\" fill=\"#3b82f6\">W</text></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 72,
        "part_name": "Árbol de levas"
      },
      {
        "point_number": 2,
        "x": 277,
        "y": 100,
        "part_name": "Válvula de admisión"
      },
      {
        "point_number": 3,
        "x": 323,
        "y": 100,
        "part_name": "Válvula de escape"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 130,
        "part_name": "Junta de culata"
      },
      {
        "point_number": 5,
        "x": 300,
        "y": 190,
        "part_name": "Camisa de agua (water jacket)"
      },
      {
        "point_number": 6,
        "x": 240,
        "y": 200,
        "part_name": "Entrada de líquido refrigerante"
      },
      {
        "point_number": 7,
        "x": 200,
        "y": 280,
        "part_name": "Bomba de agua"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 250,
        "part_name": "Culata"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 300,
        "part_name": "Bloque del cilindro"
      },
      {
        "point_number": 10,
        "x": 277,
        "y": 95,
        "part_name": "Resorte de válvula"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "motor_bloque",
    "configuration": "ciguenal_biela",
    "name": "Motor — cigüeñal y biela",
    "description": "Cigüeñal con contrapesos, biela y pistón — el corazón del motor monocilíndrico.",
    "view_box": "0 0 600 400",
    "image_path": "engine/crankshaft-connecting-rod.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mCig\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#475569\"/><stop offset=\"50%\" stop-color=\"#94a3b8\"/><stop offset=\"100%\" stop-color=\"#475569\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"280\" r=\"50\" fill=\"url(#mCig)\" stroke=\"#334155\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"280\" r=\"15\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"280\" r=\"5\" fill=\"#64748b\"/><circle cx=\"340\" cy=\"250\" r=\"12\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"340\" cy=\"250\" r=\"4\" fill=\"#64748b\"/><line x1=\"340\" y1=\"250\" x2=\"340\" y2=\"120\" stroke=\"#94a3b8\" stroke-width=\"10\" stroke-linecap=\"round\"/><rect x=\"310\" y=\"80\" width=\"60\" height=\"50\" rx=\"6\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"2\"/><rect x=\"320\" y=\"70\" width=\"40\" height=\"15\" rx=\"3\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"315\" y=\"90\" width=\"50\" height=\"8\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"315\" y=\"105\" width=\"50\" height=\"8\" rx=\"2\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><line x1=\"250\" y1=\"280\" x2=\"220\" y2=\"280\" stroke=\"#475569\" stroke-width=\"5\" stroke-linecap=\"round\"/><line x1=\"350\" y1=\"280\" x2=\"380\" y2=\"280\" stroke=\"#475569\" stroke-width=\"5\" stroke-linecap=\"round\"/><circle cx=\"220\" cy=\"280\" r=\"8\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/><circle cx=\"380\" cy=\"280\" r=\"8\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1.5\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 280,
        "part_name": "Cigüeñal (crankshaft)"
      },
      {
        "point_number": 2,
        "x": 340,
        "y": 250,
        "part_name": "Muñequilla (crankpin)"
      },
      {
        "point_number": 3,
        "x": 340,
        "y": 185,
        "part_name": "Biela (connecting rod)"
      },
      {
        "point_number": 4,
        "x": 340,
        "y": 105,
        "part_name": "Pistón"
      },
      {
        "point_number": 5,
        "x": 340,
        "y": 90,
        "part_name": "Segmentos (piston rings)"
      },
      {
        "point_number": 6,
        "x": 340,
        "y": 75,
        "part_name": "Pasador del pistón (wrist pin)"
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 280,
        "part_name": "Rodamiento principal"
      },
      {
        "point_number": 8,
        "x": 220,
        "y": 280,
        "part_name": "Contrapeso izquierdo"
      },
      {
        "point_number": 9,
        "x": 380,
        "y": 280,
        "part_name": "Contrapeso derecho"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 190,
        "part_name": "Camisa del cilindro"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "motor_bloque",
    "configuration": "embrague_multidisco",
    "name": "Embrague multidisco húmedo",
    "description": "Embrague de múltiples discos bañados en aceite — el más común en motocicletas.",
    "view_box": "0 0 600 400",
    "image_path": "engine/multi-disc-clutch.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mEmb\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#cbd5e1\"/><stop offset=\"50%\" stop-color=\"#e2e8f0\"/><stop offset=\"100%\" stop-color=\"#cbd5e1\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"300\" cy=\"220\" r=\"100\" fill=\"#e2e8f0\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"90\" fill=\"#f1f5f9\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"220\" r=\"35\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"300\" cy=\"220\" r=\"12\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"220\" r=\"5\" fill=\"#64748b\"/><rect x=\"280\" y=\"135\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><rect x=\"292\" y=\"135\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"304\" y=\"135\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><rect x=\"316\" y=\"135\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"280\" y=\"265\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><rect x=\"292\" y=\"265\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"304\" y=\"265\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#4b5563\" stroke=\"#374151\" stroke-width=\"1\"/><rect x=\"316\" y=\"265\" width=\"8\" height=\"40\" rx=\"2\" fill=\"#cbd5e1\" stroke=\"#64748b\" stroke-width=\"1\"/><rect x=\"260\" y=\"210\" width=\"15\" height=\"20\" rx=\"3\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"1\"/><rect x=\"325\" y=\"210\" width=\"15\" height=\"20\" rx=\"3\" fill=\"#475569\" stroke=\"#1e293b\" stroke-width=\"1\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 220,
        "part_name": "Eje primario (input shaft)"
      },
      {
        "point_number": 2,
        "x": 284,
        "y": 155,
        "part_name": "Disco de fricción (x4)"
      },
      {
        "point_number": 3,
        "x": 296,
        "y": 155,
        "part_name": "Disco de acero (x4)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 135,
        "part_name": "Cesta del embrague (clutch basket)"
      },
      {
        "point_number": 5,
        "x": 300,
        "y": 305,
        "part_name": "Placa de presión (pressure plate)"
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 265,
        "part_name": "Resortes del embrague"
      },
      {
        "point_number": 7,
        "x": 267,
        "y": 220,
        "part_name": "Leva de accionamiento (cam)"
      },
      {
        "point_number": 8,
        "x": 332,
        "y": 220,
        "part_name": "Cable de embrague"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 220,
        "part_name": "Eje de salida (output shaft)"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 175,
        "part_name": "Rodamiento (bearing)"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "sistema_electrico",
    "configuration": "cdi_bateria",
    "name": "Sistema eléctrico — CDI + batería 12V",
    "description": "Sistema de encendido CDI con batería de 12V — el más completo: arranque eléctrico, luces, encendido electrónico.",
    "view_box": "0 0 600 400",
    "image_path": "electrical/cdi-battery-system.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"eBat\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#15803d\"/><stop offset=\"30%\" stop-color=\"#16a34a\"/><stop offset=\"70%\" stop-color=\"#22c55e\"/><stop offset=\"100%\" stop-color=\"#15803d\"/></linearGradient><linearGradient id=\"eCdi\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#2563eb\"/><stop offset=\"100%\" stop-color=\"#1d4ed8\"/></linearGradient><linearGradient id=\"eCoil\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#1e3a8a\"/><stop offset=\"40%\" stop-color=\"#2563eb\"/><stop offset=\"60%\" stop-color=\"#3b82f6\"/><stop offset=\"100%\" stop-color=\"#1e3a8a\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><rect x=\"50\" y=\"220\" width=\"90\" height=\"60\" rx=\"6\" fill=\"url(#eBat)\" stroke=\"#15803d\" stroke-width=\"2\"/><rect x=\"55\" y=\"225\" width=\"35\" height=\"50\" rx=\"2\" fill=\"#dcfce7\" stroke=\"#16a34a\" stroke-width=\"1\"/><rect x=\"100\" y=\"225\" width=\"35\" height=\"50\" rx=\"2\" fill=\"#f0fdf4\" stroke=\"#16a34a\" stroke-width=\"1\"/><line x1=\"72\" y1=\"220\" x2=\"72\" y2=\"208\" stroke=\"#dc2626\" stroke-width=\"3\" stroke-linecap=\"round\"/><text x=\"72\" y=\"205\" text-anchor=\"middle\" font-size=\"10\" font-weight=\"bold\" fill=\"#dc2626\">+</text><line x1=\"117\" y1=\"220\" x2=\"117\" y2=\"208\" stroke=\"#1f2937\" stroke-width=\"3\" stroke-linecap=\"round\"/><text x=\"117\" y=\"205\" text-anchor=\"middle\" font-size=\"10\" font-weight=\"bold\" fill=\"#1f2937\">-</text><text x=\"95\" y=\"300\" text-anchor=\"middle\" font-size=\"10\" font-weight=\"bold\" fill=\"#15803d\">BATERÍA 12V</text><rect x=\"210\" y=\"120\" width=\"110\" height=\"70\" rx=\"8\" fill=\"url(#eCdi)\" stroke=\"#1d4ed8\" stroke-width=\"2\"/><rect x=\"220\" y=\"128\" width=\"90\" height=\"54\" rx=\"4\" fill=\"#f3f4f6\" stroke=\"#9ca3af\" stroke-width=\"1\"/><rect x=\"230\" y=\"138\" width=\"30\" height=\"20\" rx=\"2\" fill=\"#1f2937\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"245\" cy=\"148\" r=\"3\" fill=\"#10b981\"/><rect x=\"270\" y=\"138\" width=\"30\" height=\"20\" rx=\"2\" fill=\"#1f2937\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"285\" cy=\"148\" r=\"3\" fill=\"#3b82f6\"/><text x=\"265\" y=\"205\" text-anchor=\"middle\" font-size=\"10\" font-weight=\"bold\" fill=\"#4b5563\">CDI</text><rect x=\"420\" y=\"100\" width=\"50\" height=\"90\" rx=\"6\" fill=\"url(#eCoil)\" stroke=\"#1e3a8a\" stroke-width=\"2\"/><ellipse cx=\"445\" cy=\"130\" rx=\"18\" ry=\"12\" fill=\"none\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><ellipse cx=\"445\" cy=\"150\" rx=\"18\" ry=\"12\" fill=\"none\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><ellipse cx=\"445\" cy=\"170\" rx=\"18\" ry=\"12\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\"/><line x1=\"445\" y1=\"100\" x2=\"445\" y2=\"80\" stroke=\"#ef4444\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"445\" cy=\"78\" r=\"4\" fill=\"#ef4444\"/><text x=\"445\" y=\"207\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">BOBINA</text><rect x=\"500\" y=\"50\" width=\"8\" height=\"80\" rx=\"3\" fill=\"#f3f4f6\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"512\" y=\"50\" width=\"8\" height=\"80\" rx=\"3\" fill=\"#d1d5db\" stroke=\"#6b7280\" stroke-width=\"1\"/><circle cx=\"516\" cy=\"46\" r=\"5\" fill=\"#d1d5db\" stroke=\"#4b5563\" stroke-width=\"1.5\"/><line x1=\"516\" y1=\"130\" x2=\"516\" y2=\"155\" stroke=\"#6b7280\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M510,155 L510,165 Q510,175 516,180 Q522,175 522,165 L522,155\" fill=\"#fde68a\" stroke=\"#d97706\" stroke-width=\"1.5\"/><line x1=\"516\" y1=\"180\" x2=\"516\" y2=\"195\" stroke=\"#d97706\" stroke-width=\"2\"/><circle cx=\"516\" cy=\"198\" r=\"2\" fill=\"#d97706\"/><text x=\"516\" y=\"215\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">BUJÍA</text><circle cx=\"310\" cy=\"320\" r=\"35\" fill=\"#dbeafe\" stroke=\"#3b82f6\" stroke-width=\"2\"/><circle cx=\"310\" cy=\"320\" r=\"25\" fill=\"#bfdbfe\" stroke=\"#60a5fa\" stroke-width=\"1\"/><circle cx=\"310\" cy=\"320\" r=\"12\" fill=\"#93c5fd\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><text x=\"310\" y=\"370\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">ESTATOR</text><rect x=\"190\" y=\"55\" width=\"60\" height=\"35\" rx=\"5\" fill=\"#e5e7eb\" stroke=\"#4b5563\" stroke-width=\"1.5\"/><text x=\"220\" y=\"105\" text-anchor=\"middle\" font-size=\"8\" font-weight=\"bold\" fill=\"#4b5563\">REGULADOR</text><line x1=\"140\" y1=\"250\" x2=\"210\" y2=\"155\" stroke=\"#dc2626\" stroke-width=\"2\"/><line x1=\"265\" y1=\"190\" x2=\"265\" y2=\"285\" stroke=\"#f59e0b\" stroke-width=\"2\"/><line x1=\"320\" y1=\"155\" x2=\"420\" y2=\"145\" stroke=\"#2563eb\" stroke-width=\"2\"/><line x1=\"470\" y1=\"145\" x2=\"500\" y2=\"85\" stroke=\"#dc2626\" stroke-width=\"2.5\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 95,
        "y": 250,
        "part_name": "Batería 12V (plomo-ácido)"
      },
      {
        "point_number": 2,
        "x": 265,
        "y": 155,
        "part_name": "Módulo CDI (capacitor + circuito)"
      },
      {
        "point_number": 3,
        "x": 445,
        "y": 145,
        "part_name": "Bobina de encendido (primario + secundario)"
      },
      {
        "point_number": 4,
        "x": 516,
        "y": 170,
        "part_name": "Bujía (electrodo + aislante cerámico)"
      },
      {
        "point_number": 5,
        "x": 310,
        "y": 320,
        "part_name": "Estator (bobinas trifásicas + imanes)"
      },
      {
        "point_number": 6,
        "x": 220,
        "y": 72,
        "part_name": "Rectificador/regulador (disipador)"
      },
      {
        "point_number": 7,
        "x": 105,
        "y": 132,
        "part_name": "Interruptor de encendido (kill switch)"
      },
      {
        "point_number": 8,
        "x": 310,
        "y": 155,
        "part_name": "Cableado principal (harness)"
      },
      {
        "point_number": 9,
        "x": 72,
        "y": 215,
        "part_name": "Terminal positivo (+)"
      },
      {
        "point_number": 10,
        "x": 516,
        "y": 46,
        "part_name": "Torreta de bujía (HT cap)"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "sistema_electrico",
    "configuration": "solo_cdi",
    "name": "Sistema eléctrico — solo CDI (sin batería)",
    "description": "Encendido CDI alimentado directamente por el estator — sin batería. Común en motos económicas.",
    "view_box": "0 0 600 400",
    "image_path": "electrical/cdi-only-system.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"eMag\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#64748b\"/><stop offset=\"50%\" stop-color=\"#94a3b8\"/><stop offset=\"100%\" stop-color=\"#64748b\"/></linearGradient><linearGradient id=\"eCdiS\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0%\" stop-color=\"#2563eb\"/><stop offset=\"100%\" stop-color=\"#1d4ed8\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><circle cx=\"160\" cy=\"260\" r=\"55\" fill=\"url(#eMag)\" stroke=\"#475569\" stroke-width=\"2\"/><circle cx=\"160\" cy=\"260\" r=\"42\" fill=\"#e2e8f0\" stroke=\"#94a3b8\" stroke-width=\"1\"/><circle cx=\"160\" cy=\"260\" r=\"15\" fill=\"#64748b\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"160\" cy=\"260\" r=\"5\" fill=\"#374151\"/><rect x=\"140\" y=\"225\" width=\"10\" height=\"25\" rx=\"2\" fill=\"#3b82f6\" stroke=\"#1d4ed8\" stroke-width=\"1\"/><rect x=\"170\" y=\"225\" width=\"10\" height=\"25\" rx=\"2\" fill=\"#ef4444\" stroke=\"#dc2626\" stroke-width=\"1\"/><text x=\"160\" y=\"330\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">MAGNETO / VOLANTE</text><rect x=\"120\" y=\"160\" width=\"80\" height=\"40\" rx=\"5\" fill=\"#dbeafe\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><ellipse cx=\"140\" cy=\"175\" rx=\"8\" ry=\"5\" fill=\"none\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><ellipse cx=\"160\" cy=\"175\" rx=\"8\" ry=\"5\" fill=\"none\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><ellipse cx=\"180\" cy=\"175\" rx=\"8\" ry=\"5\" fill=\"none\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><text x=\"160\" y=\"213\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">ESTATOR</text><rect x=\"170\" y=\"120\" width=\"40\" height=\"25\" rx=\"4\" fill=\"#fef3c7\" stroke=\"#d97706\" stroke-width=\"1.5\"/><ellipse cx=\"190\" cy=\"130\" rx=\"10\" ry=\"6\" fill=\"none\" stroke=\"#d97706\" stroke-width=\"1.5\"/><text x=\"190\" y=\"150\" text-anchor=\"middle\" font-size=\"7\" font-weight=\"bold\" fill=\"#92400e\">PULSERA</text><rect x=\"300\" y=\"130\" width=\"110\" height=\"70\" rx=\"8\" fill=\"url(#eCdiS)\" stroke=\"#4b5563\" stroke-width=\"2\"/><rect x=\"310\" y=\"138\" width=\"90\" height=\"54\" rx=\"4\" fill=\"#f3f4f6\" stroke=\"#9ca3af\" stroke-width=\"1\"/><rect x=\"320\" y=\"148\" width=\"30\" height=\"20\" rx=\"2\" fill=\"#1f2937\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"335\" cy=\"158\" r=\"3\" fill=\"#10b981\"/><rect x=\"360\" y=\"148\" width=\"30\" height=\"20\" rx=\"2\" fill=\"#1f2937\" stroke=\"#374151\" stroke-width=\"1\"/><circle cx=\"375\" cy=\"158\" r=\"3\" fill=\"#3b82f6\"/><text x=\"355\" y=\"218\" text-anchor=\"middle\" font-size=\"10\" font-weight=\"bold\" fill=\"#4b5563\">CDI</text><rect x=\"460\" y=\"100\" width=\"50\" height=\"90\" rx=\"6\" fill=\"#2563eb\" stroke=\"#1d4ed8\" stroke-width=\"2\"/><ellipse cx=\"485\" cy=\"125\" rx=\"16\" ry=\"10\" fill=\"none\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><ellipse cx=\"485\" cy=\"145\" rx=\"16\" ry=\"10\" fill=\"none\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><ellipse cx=\"485\" cy=\"165\" rx=\"16\" ry=\"10\" fill=\"none\" stroke=\"#d1d5db\" stroke-width=\"2\"/><line x1=\"485\" y1=\"100\" x2=\"485\" y2=\"80\" stroke=\"#ef4444\" stroke-width=\"3\" stroke-linecap=\"round\"/><circle cx=\"485\" cy=\"78\" r=\"4\" fill=\"#ef4444\"/><text x=\"485\" y=\"207\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">BOBINA</text><rect x=\"520\" y=\"50\" width=\"8\" height=\"75\" rx=\"3\" fill=\"#f3f4f6\" stroke=\"#9ca3af\" stroke-width=\"1.5\"/><rect x=\"532\" y=\"50\" width=\"8\" height=\"75\" rx=\"3\" fill=\"#d1d5db\" stroke=\"#6b7280\" stroke-width=\"1\"/><circle cx=\"536\" cy=\"46\" r=\"5\" fill=\"#d1d5db\" stroke=\"#4b5563\" stroke-width=\"1.5\"/><line x1=\"536\" y1=\"125\" x2=\"536\" y2=\"150\" stroke=\"#6b7280\" stroke-width=\"3\" stroke-linecap=\"round\"/><path d=\"M530,150 L530,160 Q530,170 536,175 Q542,170 542,160 L542,150\" fill=\"#fde68a\" stroke=\"#d97706\" stroke-width=\"1.5\"/><line x1=\"536\" y1=\"175\" x2=\"536\" y2=\"190\" stroke=\"#d97706\" stroke-width=\"2\"/><circle cx=\"536\" cy=\"193\" r=\"2\" fill=\"#d97706\"/><text x=\"536\" y=\"210\" text-anchor=\"middle\" font-size=\"9\" font-weight=\"bold\" fill=\"#4b5563\">BUJÍA</text></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 160,
        "y": 260,
        "part_name": "Volante magnético (flywheel)"
      },
      {
        "point_number": 2,
        "x": 160,
        "y": 175,
        "part_name": "Estator (bobinas de carga)"
      },
      {
        "point_number": 3,
        "x": 190,
        "y": 130,
        "part_name": "Bobina pulsera (pickup coil)"
      },
      {
        "point_number": 4,
        "x": 355,
        "y": 165,
        "part_name": "Módulo CDI"
      },
      {
        "point_number": 5,
        "x": 485,
        "y": 145,
        "part_name": "Bobina de encendido (primario + secundario)"
      },
      {
        "point_number": 6,
        "x": 536,
        "y": 170,
        "part_name": "Bujía (electrodo + aislante)"
      },
      {
        "point_number": 7,
        "x": 355,
        "y": 130,
        "part_name": "Capacitor del CDI"
      },
      {
        "point_number": 8,
        "x": 160,
        "y": 260,
        "part_name": "Imanes permanentes"
      },
      {
        "point_number": 9,
        "x": 536,
        "y": 46,
        "part_name": "Torreta de bujía (HT cap)"
      },
      {
        "point_number": 10,
        "x": 250,
        "y": 155,
        "part_name": "Cableado estator a CDI"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "sistema_combustible",
    "configuration": "carburador",
    "name": "Sistema de combustible — carburador",
    "description": "Carburador de pistón deslizante (CV) — mezcla aire/combustible por depresión.",
    "view_box": "0 0 600 400",
    "image_path": "fuel/carburetor.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><defs><linearGradient id=\"mCarb\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0%\" stop-color=\"#94a3b8\"/><stop offset=\"50%\" stop-color=\"#cbd5e1\"/><stop offset=\"100%\" stop-color=\"#94a3b8\"/></linearGradient></defs><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><rect x=\"250\" y=\"100\" width=\"100\" height=\"120\" rx=\"10\" fill=\"url(#mCarb)\" stroke=\"#475569\" stroke-width=\"2\"/><rect x=\"270\" y=\"80\" width=\"60\" height=\"30\" rx=\"5\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1.5\"/><circle cx=\"300\" cy=\"95\" r=\"6\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"260\" y=\"140\" width=\"80\" height=\"25\" rx=\"4\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1\"/><circle cx=\"300\" cy=\"152\" r=\"8\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1\"/><rect x=\"280\" y=\"220\" width=\"40\" height=\"30\" rx=\"4\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"1.5\"/><line x1=\"300\" y1=\"250\" x2=\"300\" y2=\"310\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><text x=\"300\" y=\"330\" text-anchor=\"middle\" font-size=\"9\" fill=\"#6b7280\">Al motor</text><line x1=\"300\" y1=\"80\" x2=\"300\" y2=\"40\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><text x=\"300\" y=\"30\" text-anchor=\"middle\" font-size=\"9\" fill=\"#6b7280\">Aire</text><rect x=\"130\" y=\"200\" width=\"60\" height=\"40\" rx=\"5\" fill=\"#f59e0b\" stroke=\"#b45309\" stroke-width=\"1.5\"/><text x=\"160\" y=\"225\" text-anchor=\"middle\" font-size=\"9\" fill=\"#78350f\">Tanque</text><line x1=\"190\" y1=\"220\" x2=\"260\" y2=\"180\" stroke=\"#ea580c\" stroke-width=\"3\"/><circle cx=\"225\" cy=\"200\" r=\"5\" fill=\"#fed7aa\" stroke=\"#ea580c\" stroke-width=\"1\"/><text x=\"225\" y=\"215\" text-anchor=\"middle\" font-size=\"8\" fill=\"#c2410c\">Grifo</text><rect x=\"380\" y=\"130\" width=\"50\" height=\"30\" rx=\"4\" fill=\"#fde68a\" stroke=\"#d97706\" stroke-width=\"1\"/><text x=\"405\" y=\"150\" text-anchor=\"middle\" font-size=\"8\" fill=\"#92400e\">Filtro</text><line x1=\"380\" y1=\"145\" x2=\"350\" y2=\"152\" stroke=\"#d97706\" stroke-width=\"2\"/></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 152,
        "part_name": "Carburador (CV)"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 95,
        "part_name": "Pistón deslizante (slide)"
      },
      {
        "point_number": 3,
        "x": 300,
        "y": 95,
        "part_name": "Diafragma (diaphragm)"
      },
      {
        "point_number": 4,
        "x": 300,
        "y": 152,
        "part_name": "Choke (arranque en frío)"
      },
      {
        "point_number": 5,
        "x": 280,
        "y": 235,
        "part_name": "Cuba (float bowl)"
      },
      {
        "point_number": 6,
        "x": 300,
        "y": 230,
        "part_name": "Flotador (float)"
      },
      {
        "point_number": 7,
        "x": 260,
        "y": 180,
        "part_name": "Entrada de combustible"
      },
      {
        "point_number": 8,
        "x": 405,
        "y": 145,
        "part_name": "Filtro de combustible"
      },
      {
        "point_number": 9,
        "x": 300,
        "y": 310,
        "part_name": "Salida al motor (admisión)"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 40,
        "part_name": "Entrada de aire (filtro)"
      }
    ]
  },
  {
    "vehicle_type": "motocicleta",
    "system": "sistema_combustible",
    "configuration": "inyeccion",
    "name": "Sistema de combustible — inyección electrónica",
    "description": "Inyección electrónica de combustible (EFI) — ECU controla los inyectores según sensores.",
    "view_box": "0 0 600 400",
    "image_path": "fuel/fuel-injection.webp",
    "svg_content": "<svg viewBox=\"0 0 600 400\" xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"600\" height=\"400\" fill=\"#f9fafb\"/><rect x=\"260\" y=\"120\" width=\"80\" height=\"60\" rx=\"8\" fill=\"#e2e8f0\" stroke=\"#475569\" stroke-width=\"2\"/><text x=\"300\" y=\"155\" text-anchor=\"middle\" font-size=\"10\" fill=\"#334155\">ECU</text><rect x=\"260\" y=\"220\" width=\"80\" height=\"40\" rx=\"5\" fill=\"#cbd5e1\" stroke=\"#475569\" stroke-width=\"2\"/><text x=\"300\" y=\"245\" text-anchor=\"middle\" font-size=\"9\" fill=\"#334155\">Inyector</text><rect x=\"120\" y=\"200\" width=\"60\" height=\"40\" rx=\"5\" fill=\"#94a3b8\" stroke=\"#475569\" stroke-width=\"1.5\"/><text x=\"150\" y=\"225\" text-anchor=\"middle\" font-size=\"9\" fill=\"#1e293b\">Bomba</text><rect x=\"120\" y=\"130\" width=\"60\" height=\"30\" rx=\"4\" fill=\"#fde68a\" stroke=\"#d97706\" stroke-width=\"1\"/><text x=\"150\" y=\"150\" text-anchor=\"middle\" font-size=\"8\" fill=\"#92400e\">Filtro</text><circle cx=\"420\" cy=\"160\" r=\"15\" fill=\"#dbeafe\" stroke=\"#3b82f6\" stroke-width=\"1.5\"/><text x=\"420\" y=\"164\" text-anchor=\"middle\" font-size=\"8\" fill=\"#1d4ed8\">λ</text><text x=\"420\" y=\"185\" text-anchor=\"middle\" font-size=\"8\" fill=\"#6b7280\">Sensor O2</text><circle cx=\"420\" cy=\"250\" r=\"12\" fill=\"#fef3c7\" stroke=\"#d97706\" stroke-width=\"1.5\"/><text x=\"420\" y=\"254\" text-anchor=\"middle\" font-size=\"8\" fill=\"#92400e\">T°</text><text x=\"420\" y=\"275\" text-anchor=\"middle\" font-size=\"8\" fill=\"#6b7280\">Sensor TPS</text><line x1=\"180\" y1=\"220\" x2=\"260\" y2=\"230\" stroke=\"#ea580c\" stroke-width=\"2\"/><line x1=\"150\" y1=\"160\" x2=\"180\" y2=\"200\" stroke=\"#ea580c\" stroke-width=\"2\"/><line x1=\"340\" y1=\"230\" x2=\"400\" y2=\"250\" stroke=\"#475569\" stroke-width=\"2\"/><line x1=\"340\" y1=\"150\" x2=\"405\" y2=\"160\" stroke=\"#475569\" stroke-width=\"2\"/><line x1=\"300\" y1=\"260\" x2=\"300\" y2=\"320\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><text x=\"300\" y=\"340\" text-anchor=\"middle\" font-size=\"9\" fill=\"#6b7280\">Al motor</text><line x1=\"300\" y1=\"120\" x2=\"300\" y2=\"70\" stroke=\"#475569\" stroke-width=\"4\" stroke-linecap=\"round\"/><text x=\"300\" y=\"60\" text-anchor=\"middle\" font-size=\"9\" fill=\"#6b7280\">Aire</text></svg>",
    "points": [
      {
        "point_number": 1,
        "x": 300,
        "y": 150,
        "part_name": "ECU (unidad de control)"
      },
      {
        "point_number": 2,
        "x": 300,
        "y": 240,
        "part_name": "Inyector de combustible"
      },
      {
        "point_number": 3,
        "x": 150,
        "y": 220,
        "part_name": "Bomba de combustible"
      },
      {
        "point_number": 4,
        "x": 150,
        "y": 145,
        "part_name": "Filtro de combustible"
      },
      {
        "point_number": 5,
        "x": 420,
        "y": 160,
        "part_name": "Sensor de oxígeno (O2)"
      },
      {
        "point_number": 6,
        "x": 420,
        "y": 250,
        "part_name": "Sensor TPS (mariposa)"
      },
      {
        "point_number": 7,
        "x": 300,
        "y": 320,
        "part_name": "Salida al motor (admisión)"
      },
      {
        "point_number": 8,
        "x": 300,
        "y": 70,
        "part_name": "Entrada de aire (filtro)"
      },
      {
        "point_number": 9,
        "x": 270,
        "y": 135,
        "part_name": "Harness de la ECU"
      },
      {
        "point_number": 10,
        "x": 300,
        "y": 215,
        "part_name": "Rail de combustible"
      }
    ]
  }
];
