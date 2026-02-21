const nodemailer = require('nodemailer');

/**
 * Crear transporter de email basado en configuración del tenant
 */
const createEmailTransporter = (config) => {
  if (!config || !config.smtp_host) {
    throw new Error('Configuración de email no disponible');
  }

  return nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port || 587,
    secure: config.smtp_secure || false, // true para 465, false para otros puertos
    auth: {
      user: config.smtp_user,
      pass: config.smtp_password,
    },
    tls: {
      rejectUnauthorized: false, // Para desarrollo
    },
  });
};

/**
 * Verificar configuración de email
 */
const verifyEmailConfig = async (config) => {
  try {
    const transporter = createEmailTransporter(config);
    await transporter.verify();
    return { success: true, message: 'Configuración válida' };
  } catch (error) {
    return { success: false, message: error.message };
  }
};

/**
 * Configuraciones predefinidas para proveedores comunes
 */
const EMAIL_PROVIDERS = {
  gmail: {
    smtp_host: 'smtp.gmail.com',
    smtp_port: 587,
    smtp_secure: false,
    instructions:
      'Use su email de Gmail y una contraseña de aplicación (no su contraseña normal)',
  },
  outlook: {
    smtp_host: 'smtp-mail.outlook.com',
    smtp_port: 587,
    smtp_secure: false,
    instructions: 'Use su email de Outlook/Hotmail y contraseña',
  },
  office365: {
    smtp_host: 'smtp.office365.com',
    smtp_port: 587,
    smtp_secure: false,
    instructions: 'Use su email de Office 365 y contraseña',
  },
  yahoo: {
    smtp_host: 'smtp.mail.yahoo.com',
    smtp_port: 587,
    smtp_secure: false,
    instructions: 'Use su email de Yahoo y una contraseña de aplicación',
  },
  custom: {
    smtp_host: '',
    smtp_port: 587,
    smtp_secure: false,
    instructions: 'Configure manualmente su servidor SMTP',
  },
};

module.exports = {
  createEmailTransporter,
  verifyEmailConfig,
  EMAIL_PROVIDERS,
};
