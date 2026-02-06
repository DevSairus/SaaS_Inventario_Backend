// backend/src/controllers/tenant.controller.js
const { Tenant } = require('../models');

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
 * SOLUCIÓN PARA VERCEL: Usar Cloudinary en lugar de filesystem
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

    // ========================================================================
    // OPCIÓN A: CLOUDINARY (RECOMENDADA PARA PRODUCCIÓN)
    // ========================================================================
    // Descomentar este bloque si usas Cloudinary
    /*
    const cloudinary = require('cloudinary').v2;
    
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET
    });

    // Subir a Cloudinary
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
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    // Eliminar logo anterior de Cloudinary si existe
    if (tenant.logo_url && !tenant.logo_url.startsWith('data:') && tenant.logo_url.includes('cloudinary')) {
      try {
        const urlParts = tenant.logo_url.split('/');
        const publicIdWithExt = urlParts[urlParts.length - 1];
        const publicId = publicIdWithExt.split('.')[0];
        await cloudinary.uploader.destroy(`tenant-logos/${publicId}`);
      } catch (err) {
        console.error('Error eliminando logo anterior:', err);
      }
    }

    // Actualizar tenant con URL de Cloudinary
    await tenant.update({ logo_url: uploadResult.secure_url });

    res.json({
      success: true,
      message: 'Logo subido exitosamente',
      data: {
        logo_url: uploadResult.secure_url
      }
    });
    */

    // ========================================================================
    // OPCIÓN B: VERCEL BLOB STORAGE
    // ========================================================================
    // Descomentar este bloque si usas Vercel Blob
    /*
    const { put, del } = require('@vercel/blob');

    // Subir a Vercel Blob
    const filename = `tenant-logos/logo-${tenantId}-${Date.now()}.${req.file.originalname.split('.').pop()}`;
    const blob = await put(filename, req.file.buffer, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    // Eliminar logo anterior si existe
    if (tenant.logo_url && tenant.logo_url.startsWith('https://') && tenant.logo_url.includes('vercel-storage')) {
      try {
        await del(tenant.logo_url, {
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
      } catch (err) {
        console.error('Error eliminando logo anterior:', err);
      }
    }

    await tenant.update({ logo_url: blob.url });

    res.json({
      success: true,
      message: 'Logo subido exitosamente',
      data: {
        logo_url: blob.url
      }
    });
    */

    // ========================================================================
    // OPCIÓN C: BASE64 EN BASE DE DATOS (TEMPORAL - Solo para desarrollo)
    // ========================================================================
    // Comentar este bloque cuando migres a Cloudinary o Vercel Blob
    
    // Validar tamaño del archivo (máximo 2MB para base64)
    if (req.file.size > 2 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        message: 'El archivo es demasiado grande. Máximo 2MB permitido.'
      });
    }

    const base64Logo = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const logoDataUrl = `data:${mimeType};base64,${base64Logo}`;

    await tenant.update({ logo_url: logoDataUrl });

    res.json({
      success: true,
      message: 'Logo subido exitosamente',
      data: {
        logo_url: logoDataUrl
      }
    });
    
    // FIN OPCIÓN C
    // ========================================================================

  } catch (error) {
    console.error('Error subiendo logo:', error);
    res.status(500).json({
      success: false,
      message: 'Error subiendo logo',
      error: error.message,
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

    // ========================================================================
    // ELIMINAR DE CLOUDINARY
    // ========================================================================
    /*
    if (!tenant.logo_url.startsWith('data:') && tenant.logo_url.includes('cloudinary')) {
      const cloudinary = require('cloudinary').v2;
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
      });

      try {
        const urlParts = tenant.logo_url.split('/');
        const publicIdWithExt = urlParts[urlParts.length - 1];
        const publicId = publicIdWithExt.split('.')[0];
        await cloudinary.uploader.destroy(`tenant-logos/${publicId}`);
      } catch (err) {
        console.error('Error eliminando de Cloudinary:', err);
      }
    }
    */

    // ========================================================================
    // ELIMINAR DE VERCEL BLOB
    // ========================================================================
    /*
    if (tenant.logo_url.startsWith('https://') && tenant.logo_url.includes('vercel-storage')) {
      const { del } = require('@vercel/blob');
      try {
        await del(tenant.logo_url, {
          token: process.env.BLOB_READ_WRITE_TOKEN,
        });
      } catch (err) {
        console.error('Error eliminando de Vercel Blob:', err);
      }
    }
    */

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