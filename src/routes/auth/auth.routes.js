const express = require('express');
const router = express.Router();
const { login, getProfile, verifyToken } = require('../../controllers/auth/auth.controller');
const { authMiddleware } = require('../../middleware/auth');

router.post('/login', login);
router.get('/profile', authMiddleware, getProfile);
router.get('/verify', authMiddleware, verifyToken);

module.exports = router;