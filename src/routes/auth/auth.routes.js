const express = require('express');
const router = express.Router();
const { login, getProfile, verifyToken, refreshToken, endImpersonation, selectTenant, myCompanies, switchTenant } = require('../../controllers/auth/auth.controller');
const { forgotPassword, resetPassword } = require('../../controllers/auth/passwordReset.controller');
const { authMiddleware } = require('../../middleware/auth');
const { loginValidator } = require('../../validators/auth.validator');
const { validate } = require('../../middleware/validate');
const { authLimiter } = require('../../middleware/rateLimiter');

router.post('/login', authLimiter, loginValidator, validate, login);
router.post('/refresh', authMiddleware, refreshToken);

// Una persona en varias empresas (services/auth/identity.service.js):
// elegir empresa tras el login, listar las suyas y cambiar sin cerrar sesión.
router.post('/select-tenant', authLimiter, selectTenant);
router.get('/companies', authMiddleware, myCompanies);
router.post('/switch-tenant', authMiddleware, switchTenant);
router.post('/impersonate/end', authMiddleware, endImpersonation);
router.get('/profile', authMiddleware, getProfile);
router.get('/verify', authMiddleware, verifyToken);

// Password reset
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password', authLimiter, resetPassword);

module.exports = router;