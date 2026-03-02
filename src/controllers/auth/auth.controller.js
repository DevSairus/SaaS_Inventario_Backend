const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User, Tenant } = require('../models');

const login = async (req, res) => {
  try {
    const { email, password, tenant_id } = req.body;

    if (!email || !password || !tenant_id) {
      return res.status(400).json({
        success: false,
        message: 'Email, contraseña y tenant_id son requeridos'
      });
    }

    // Validar tenant
    const tenant = await Tenant.findByPk(tenant_id);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Empresa no encontrada'
      });
    }

    if (!tenant.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Empresa desactivada'
      });
    }

    // Buscar usuario dentro del tenant
    const user = await User.findOne({
      where: {
        email: email.toLowerCase().trim(),
        tenant_id: tenant_id
      }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: 'Usuario desactivado'
      });
    }

    // ⚠️ IMPORTANTE: usar password_hash
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    return res.status(200).json({
      success: true,
      message: 'Login exitoso',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        tenant_id: user.tenant_id
      }
    });

  } catch (error) {
    console.error('LOGIN ERROR:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  }
};

module.exports = {
  login
};