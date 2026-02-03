// Ejecutar desde la carpeta backend:  node diagnose.js
require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5433,
  database: process.env.DB_NAME || 'inventario_db',
  user: process.env.DB_USER || 'inventario_user',
  password: process.env.DB_PASSWORD || 'Inventario2026',
});

(async () => {
  await client.connect();
  console.log('✅ Conectado a:', process.env.DB_NAME || 'inventario_db');

  // 1. Tenants
  const tenants = await client.query('SELECT id, company_name, slug, is_active FROM tenants');
  console.log('\n=== TENANTS ===');
  tenants.rows.forEach(t => console.log(t));

  // 2. Usuarios y su tenant_id
  const users = await client.query('SELECT id, email, role, tenant_id FROM users');
  console.log('\n=== USUARIOS ===');
  users.rows.forEach(u => console.log(u));

  // 3. Productos agrupados por tenant_id
  const products = await client.query(
    'SELECT tenant_id, COUNT(*)::int as cantidad FROM products GROUP BY tenant_id'
  );
  console.log('\n=== PRODUCTOS por tenant_id ===');
  products.rows.forEach(p => console.log(p));

  // 4. Categorías agrupadas por tenant_id
  const categories = await client.query(
    'SELECT tenant_id, COUNT(*)::int as cantidad FROM categories GROUP BY tenant_id'
  );
  console.log('\n=== CATEGORIAS por tenant_id ===');
  categories.rows.forEach(c => console.log(c));

  // 5. Verificación directa: ¿los productos del tenant del usuario existen?
  console.log('\n=== VERIFICACION CRUZADA ===');
  for (const user of users.rows) {
    if (user.tenant_id) {
      const check = await client.query(
        'SELECT COUNT(*)::int as productos FROM products WHERE tenant_id = $1',
        [user.tenant_id]
      );
      console.log(`  Usuario ${user.email} (${user.role}) → tenant_id=${user.tenant_id} → productos=${check.rows[0].productos}`);
    } else {
      console.log(`  Usuario ${user.email} (${user.role}) → tenant_id=NULL ⚠️`);
    }
  }

  await client.end();
})();