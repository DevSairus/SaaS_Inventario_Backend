const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sequelize } = require('../../config/database');
const { DataTypes } = require('sequelize');
const { sendEmail } = require('../../services/emailService');

// Minimal User model reference
const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING, allowNull: false },
  first_name: { type: DataTypes.STRING },
  last_name: { type: DataTypes.STRING },
  is_active: { type: DataTypes.BOOLEAN, defaultValue: true },
  password_reset_token: { type: DataTypes.STRING, allowNull: true },
  password_reset_expires: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

/**
 * POST /auth/forgot-password
 * Body: { email }
 */
const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: 'El email es requerido' });
    }

    // Always return success to avoid user enumeration
    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });

    if (user && user.is_active) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await user.update({
        password_reset_token: token,
        password_reset_expires: expires,
      });

      const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`;

      await sendEmail({
        to: user.email,
        subject: 'Restablecer contraseña',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #4F46E5;">Restablecer contraseña</h2>
            <p>Hola <strong>${user.first_name}</strong>,</p>
            <p>Recibimos una solicitud para restablecer tu contraseña. Haz clic en el siguiente enlace:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}"
                 style="background: linear-gradient(135deg,#6366f1,#8b5cf6); color: white; padding: 14px 28px;
                        text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                Restablecer contraseña
              </a>
            </div>
            <p style="color: #6b7280; font-size: 14px;">Este enlace expira en 1 hora.</p>
            <p style="color: #6b7280; font-size: 14px;">Si no solicitaste esto, puedes ignorar este mensaje.</p>
            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
            <p style="color: #9ca3af; font-size: 12px;">© 2026 ESC Data Core Solutions</p>
          </div>
        `,
      });
    }

    // Always return 200 to avoid user enumeration
    return res.json({ success: true, message: 'Si el correo está registrado, recibirás un enlace de recuperación.' });

  } catch (error) {
    console.error('Error en forgotPassword:', error);
    return res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

/**
 * POST /auth/reset-password
 * Body: { token, password }
 */
const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token y contraseña son requeridos' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const user = await User.findOne({
      where: {
        password_reset_token: token,
      },
    });

    if (!user) {
      return res.status(400).json({ success: false, message: 'Token inválido o expirado' });
    }

    if (!user.password_reset_expires || new Date() > new Date(user.password_reset_expires)) {
      return res.status(400).json({ success: false, message: 'El enlace de recuperación ha expirado. Solicita uno nuevo.' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    await user.update({
      password_hash,
      password_reset_token: null,
      password_reset_expires: null,
    });

    return res.json({ success: true, message: 'Contraseña actualizada correctamente. Ya puedes iniciar sesión.' });

  } catch (error) {
    console.error('Error en resetPassword:', error);
    return res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
};

module.exports = { forgotPassword, resetPassword };