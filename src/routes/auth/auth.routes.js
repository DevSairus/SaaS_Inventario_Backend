const express = require('express');
const router = express.Router();
const { login, getProfile, verifyToken } = require('../../controllers/auth/auth.controller');
const { forgotPassword, resetPassword } = require('../../controllers/auth/passwordReset.controller');
const { authMiddleware } = require('../../middleware/auth');

router.post('/login', login);
router.get('/profile', authMiddleware, getProfile);
router.get('/verify', authMiddleware, verifyToken);

// Password reset
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;