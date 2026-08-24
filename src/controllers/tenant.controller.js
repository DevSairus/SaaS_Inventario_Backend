// backend/src/controllers/tenant.controller.js
const { Tenant } = require('../models');
const path = require('path');
const fs = require('fs');
const { getEffectiveModulesForTenantId } = require('../services/moduleAccess');

// Cloudinary — siempre requerido (Vercel es stateless, sin disco persistente)
const { v2: cloudinary } = require('cloudinary');
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});
const useCloudinary = true; // siempre Cloudinary

/**
 * Obtener configuración del tenant actual
 */
const getTenantConfig = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'ID de tenant no encontrado en la solicitud'
      });
    }
    
    const tenant = await Tenant.findByPk(tenantId, {
      attributes: [
        'id',
        'slug',
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
        'business_config',
        'features',
        'plan_id',
        'tax_config'
      ]
    });

    if (!tenant) {
      return res.status(404).json({
        success: false,
        message: 'Tenant no encontrado'
      });
    }

    const effectiveModules = await getEffectiveModulesForTenantId(tenantId);

    res.json({
      success: true,
      data: {
        ...tenant.toJSON(),
        effective_modules: effectiveModules
      }
    });
  } catch (error) {
    console.error('Error obteniendo configuración:', error);
    res.status(500).json({
      success: false,
      message: 'Error obteniendo configuración',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Actualizar configuración del tenant
 */
const updateTenantConfig = async (req, res) => {
  try {
    const tenantId = req.tenant_id;
    
    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'ID de tenant no encontrado en la solicitud'
      });
    }
    
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
      business_config,
      features,
      tax_config
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
    if (business_config !== undefined) updates.business_config = { ...(tenant.business_config || {}), ...business_config };
    if (features !== undefined) updates.features = { ...(tenant.features || {}), ...features };
    if (tax_config !== undefined) updates.tax_config = { ...(tenant.tax_config || {}), ...tax_config };

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
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

/**
 * Subir logo del tenant
 * Soporta almacenamiento local (desarrollo) y Cloudinary (producción)
 */
const uploadLogo = async (req, res) => {
  try {
    const tenantId = req.tenant_id;

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'ID de tenant no encontrado en la solicitud'
      });
    }

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

    let logoUrl;

    if (useCloudinary) {
      // ========== CLOUDINARY (PRODUCCIÓN) ==========
      console.log('📤 Subiendo logo a Cloudinary...');
      
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'tenant-logos',
            public_id: `logo-${tenantId}-${Date.now()}`,
            resource_type: 'image',
            transformation: [
              { width: 500, height: 500, crop: 'limit' },
              { quality: 'auto' }
            ]
          },
          (error, result) => {
            if (error) {
              console.error('❌ Error en Cloudinary:', error);
              reject(error);
            } else {
              console.log('✅ Logo subido a Cloudinary:', result.secure_url);
              resolve(result);
            }
          }
        );
        uploadStream.end(req.file.buffer);
      });

      // Eliminar logo anterior de Cloudinary si existe
      if (tenant.logo_url && tenant.logo_url.includes('cloudinary')) {
        try {
          const urlParts = tenant.logo_url.split('/');
          const publicIdWithExt = urlParts[urlParts.length - 1];
          const publicId = publicIdWithExt.split('.')[0];
          console.log('🗑️ Eliminando logo anterior de Cloudinary...');
          await cloudinary.uploader.destroy(`tenant-logos/${publicId}`);
          console.log('✅ Logo anterior eliminado');
        } catch (err) {
          console.error('⚠️ Error eliminando logo anterior:', err);
        }
      }

      logoUrl = uploadResult.secure_url;

    }

    // Actualizar tenant
    await tenant.update({ logo_url: logoUrl });

    res.json({
      success: true,
      message: 'Logo subido exitosamente',
      data: {
        logo_url: logoUrl,
        storage: 'cloudinary'
      }
    });

  } catch (error) {
    console.error('❌ Error subiendo logo:', error);
    res.status(500).json({
      success: false,
      message: 'Error subiendo logo',
      error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

/**
 * Eliminar logo del tenant
 */
const deleteLogo = async (req, res) => {
  try {
    const tenantId = req.tenant_id;

    if (!tenantId) {
      return res.status(400).json({
        success: false,
        message: 'ID de tenant no encontrado en la solicitud'
      });
    }

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

    // Eliminar de Cloudinary (único storage soportado)
    if (tenant.logo_url.includes('cloudinary')) {
      try {
        const urlParts = tenant.logo_url.split('/');
        const publicIdWithExt = urlParts[urlParts.length - 1];
        const publicId = publicIdWithExt.split('.')[0];
        await cloudinary.uploader.destroy(`tenant-logos/${publicId}`);
      } catch (err) {
        console.error('Error eliminando logo de Cloudinary:', err.message);
      }
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
      error: process.env.NODE_ENV === 'production' ? undefined : error.message
    });
  }
};

module.exports = {
  getTenantConfig,
  updateTenantConfig,
  uploadLogo,
  deleteLogo
};