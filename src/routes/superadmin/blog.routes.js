// routes/superadmin/blog.routes.js
//
// Gestión del blog editorial desde superadmin (SEO long-tail). Mismo patrón
// que routes/superadmin/support.routes.js: montado bajo /api/superadmin/blog,
// nada de este router es alcanzable desde una sesión impersonada.
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../../middleware/auth');
const { checkPermission } = require('../../middleware/checkPermission');
const { denyImpersonation } = require('../../middleware/denyImpersonation');
const uploadBlogCover = require('../../middleware/uploadBlogCover');

const blogController = require('../../controllers/superadmin/blog.controller');

router.use(authMiddleware, denyImpersonation);

router.get('/', authMiddleware, checkPermission('superadmin.content_manage'), blogController.listPosts);
router.post('/', authMiddleware, checkPermission('superadmin.content_manage'), blogController.createPost);
router.get('/:id', authMiddleware, checkPermission('superadmin.content_manage'), blogController.getPost);
router.put('/:id', authMiddleware, checkPermission('superadmin.content_manage'), blogController.updatePost);
router.delete('/:id', authMiddleware, checkPermission('superadmin.content_manage'), blogController.deletePost);
router.post('/:id/publish', authMiddleware, checkPermission('superadmin.content_manage'), blogController.publishPost);
router.post('/:id/unpublish', authMiddleware, checkPermission('superadmin.content_manage'), blogController.unpublishPost);
router.post(
  '/:id/cover',
  authMiddleware,
  checkPermission('superadmin.content_manage'),
  uploadBlogCover.single('cover'),
  blogController.uploadCover
);

module.exports = router;
