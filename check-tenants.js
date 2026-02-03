const { Sequelize } = require('sequelize');
const seq = new Sequelize('inventario_db', 'inventario_user', 'Inventario2026', {
  host: 'localhost', port: 5433, dialect: 'postgres', logging: false
});

(async () => {
  const [products] = await seq.query('SELECT tenant_id, COUNT(*) as count FROM products GROUP BY tenant_id');
  console.log(' Productos por tenant_id:');
  console.table(products);
  
  const [users] = await seq.query("SELECT email, role, tenant_id FROM users WHERE email = 'admin@inventario.com'");
  console.log('\n Usuario admin:');
  console.table(users);
  
  await seq.close();
})();
