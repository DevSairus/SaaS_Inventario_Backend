const bcrypt = require('bcryptjs');

(async () => {
  const hash = await bcrypt.hash('123456', 10);
  console.log(hash);
})();
