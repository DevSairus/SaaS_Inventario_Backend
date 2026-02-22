const express = require('express');
const router = express.Router();
const { login, getProfile, verifyToken } = require('../../controllers/auth/auth.controller');
const { forgotPassword, resetPassword } = require('../../controllers/auth/passwordReset.controller');
const { authMiddleware } = require('../../middleware/auth');
const { loginValidator } = require('../../validators/auth.validator');
const { validate } = require('../../middleware/validate');

router.post('/login', loginValidator, validate, login);
router.get('/profile', authMiddleware, getProfile);
router.get('/verify', authMiddleware, verifyToken);

// Password reset
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;