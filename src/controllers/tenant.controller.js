// backend/src/controllers/tenant.controller.js
const { Tenant } = require('../models');
const path = require('path');
const fs = require('fs');

/**
 * Obtener configuración del tenant actual
 */
const getTenantConfig = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    
    const tenant = await Tenant.findByPk(tenantId, {
      attributes: [
        'id',
        'company_name',
        'business_name',
        'tax_id',
        'email',
        'phone',
        'address',
        'website',
        'logo_url',
        'primary_color',
        'secondary_color',
        'pdf_config',
        'business_config'
      ]
    });

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado'
      });
    }

    res.json({
      success: true,
      data: tenant
    });
  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo configuración',
      error: error.message
    });
  }
};

/**
 * Actualizar configuración del tenant
 */
const updateTenantConfig = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    const {
      company_name,
      business_name,
      tax_id,
      email,
      phone,
      address,
      website,
      primary_color,
      secondary_color,
      pdf_config,
      business_config
    } = req.body;

    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado'
      });
    }

    // Actualizar campos permitidos
    const updates = {};
    if (company_name !== undefined) updates.company_name = company_name;
    if (business_name !== undefined) updates.business_name = business_name;
    if (tax_id !== undefined) updates.tax_id = tax_id;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (website !== undefined) updates.website = website;
    if (primary_color !== undefined) updates.primary_color = primary_color;
    if (secondary_color !== undefined) updates.secondary_color = secondary_color;
    if (pdf_config !== undefined) updates.pdf_config = pdf_config;
    if (business_config !== undefined) updates.business_config = business_config;

    await tenant.update(updates);

    res.json({
      success: true,
      message: 'Configuración actualizada exitosamente',
      data: tenant
    });
  } catch (error) {
    console.error('Error actualizando configuración:', error);
    res.status(500).json({
      success: false,
      message: 'Error actualizando configuración',
      error: error.message
    });
  }
};

/**
 * Subir logo del tenant
 */
const uploadLogo = async (req, res) => {
  try {
    const tenantId = req.tenant_id;

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No se proporcionó ningún archivo'
      });
    }

    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado'
      });
    }

    // Eliminar logo anterior si existe
    if (tenant.logo_url) {
      const oldLogoPath = path.join(__dirname, '../../uploads/logos', tenant.logo_url);
      if (fs.existsSync(oldLogoPath)) {
        fs.unlinkSync(oldLogoPath);
      }
    }

    // Guardar nuevo logo
    const fileName = `logo-${tenantId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const logoPath = path.join(__dirname, '../../uploads/logos', fileName);

    // Asegurar que el directorio existe
    const logoDir = path.join(__dirname, '../../uploads/logos');
    if (!fs.existsSync(logoDir)) {
      fs.mkdirSync(logoDir, { recursive: true });
    }

    fs.writeFileSync(logoPath, req.file.buffer);

    // Actualizar tenant con nueva URL del logo
    await tenant.update({ logo_url: fileName });

    res.json({
      success: true,
      message: 'Logo subido exitosamente',
      data: {
        logo_url: fileName
      }
    });
  } catch (error) {
    console.error('Error subiendo logo:', error);
    res.status(500).json({
      success: false,
      message: 'Error subiendo logo',
      error: error.message
    });
  }
};

/**
 * Eliminar logo del tenant
 */
const deleteLogo = async (req, res) => {
  try {
    const tenantId = req.tenant_id;

    const tenant = await Tenant.findByPk(tenantId);

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado'
      });
    }

    if (!tenant.logo_url) {
      return res.status(400).json({
        success: false,
        message: 'El tenant no tiene logo configurado'
      });
    }

    // Eliminar archivo físico
    const logoPath = path.join(__dirname, '../../uploads/logos', tenant.logo_url);
    if (fs.existsSync(logoPath)) {
      fs.unlinkSync(logoPath);
    }

    // Actualizar tenant
    await tenant.update({ logo_url: null });

    res.json({
      success: true,
      message: 'Logo eliminado exitosamente'
    });
  } catch (error) {
    console.error('Error eliminando logo:', error);
    res.status(500).json({
      success: false,
      message: 'Error eliminando logo',
      error: error.message
    });
  }
};

module.exports = {
  getTenantConfig,
  updateTenantConfig,
  uploadLogo,
  deleteLogo
};