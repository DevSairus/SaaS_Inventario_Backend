// controllers/superadmin/blog.controller.js
const { BlogPost, User } = require('../../models');
const { Op } = require('sequelize');
const { triggerVercelDeploy } = require('../../utils/triggerVercelDeploy');
const { uploadToCloudinary } = require('../../utils/uploadToCloudinary');

const slugify = (text) => String(text || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const ensureUniqueSlug = async (baseSlug, excludeId = null) => {
  let slug = baseSlug;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const where = { slug };
    if (excludeId) where.id = { [Op.ne]: excludeId };
    const existing = await BlogPost.findOne({ where });
    if (!existing) return slug;
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }
};

const calcReadingTime = (content) => {
  const words = String(content || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
};

const REQUIRED_TO_PUBLISH = ['title', 'slug', 'meta_description', 'cover_image_url'];

exports.listPosts = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, category, search } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 200);
    const safePage = Math.max(1, parseInt(page) || 1);

    const where = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (search) where.title = { [Op.iLike]: `%${search}%` };

    const posts = await BlogPost.findAndCountAll({
      where,
      include: [{ model: User, as: 'author', attributes: ['id', 'first_name', 'last_name', 'email'], required: false }],
      order: [['created_at', 'DESC']],
      limit: safeLimit,
      offset: (safePage - 1) * safeLimit,
    });

    res.json({
      success: true,
      posts: posts.rows,
      pagination: {
        total: posts.count,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(posts.count / safeLimit),
      },
    });
  } catch (error) {
    console.error('Error al listar posts de blog:', error);
    res.status(500).json({ success: false, message: 'Error al listar posts', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.getPost = async (req, res) => {
  try {
    const post = await BlogPost.findByPk(req.params.id, {
      include: [{ model: User, as: 'author', attributes: ['id', 'first_name', 'last_name', 'email'], required: false }],
    });
    if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });
    res.json({ success: true, post });
  } catch (error) {
    console.error('Error al obtener post de blog:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el post', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.createPost = async (req, res) => {
  try {
    const { title, slug, excerpt, content, cover_image_url, category, tags, meta_title, meta_description, focus_keyword } = req.body;

    if (!title || !content) {
      return res.status(400).json({ success: false, message: 'title y content son obligatorios' });
    }

    const finalSlug = await ensureUniqueSlug(slugify(slug || title));

    const post = await BlogPost.create({
      title,
      slug: finalSlug,
      excerpt,
      content,
      cover_image_url,
      category,
      tags: tags || [],
      meta_title,
      meta_description,
      focus_keyword,
      status: 'draft',
      author_id: req.user.id,
      reading_time_minutes: calcReadingTime(content),
    });

    res.status(201).json({ success: true, message: 'Post creado exitosamente', post });
  } catch (error) {
    console.error('Error al crear post de blog:', error);
    res.status(500).json({ success: false, message: 'Error al crear el post', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.updatePost = async (req, res) => {
  try {
    const post = await BlogPost.findByPk(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });

    const updates = { ...req.body };
    delete updates.status;
    delete updates.published_at;
    delete updates.author_id;

    if (updates.slug && updates.slug !== post.slug) {
      updates.slug = await ensureUniqueSlug(slugify(updates.slug), post.id);
    }
    if (updates.content) {
      updates.reading_time_minutes = calcReadingTime(updates.content);
    }

    await post.update(updates);

    if (post.status === 'published') {
      triggerVercelDeploy(`blog:update:${post.slug}`).catch(() => {});
    }

    res.json({ success: true, message: 'Post actualizado exitosamente', post });
  } catch (error) {
    console.error('Error al actualizar post de blog:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el post', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const post = await BlogPost.findByPk(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });

    const wasPublished = post.status === 'published';
    await post.destroy();

    if (wasPublished) {
      triggerVercelDeploy(`blog:delete:${post.slug}`).catch(() => {});
    }

    res.json({ success: true, message: 'Post eliminado exitosamente' });
  } catch (error) {
    console.error('Error al eliminar post de blog:', error);
    res.status(500).json({ success: false, message: 'Error al eliminar el post', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.publishPost = async (req, res) => {
  try {
    const post = await BlogPost.findByPk(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });

    const missing = REQUIRED_TO_PUBLISH.filter((field) => !post[field]);
    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos obligatorios para publicar: ${missing.join(', ')}`,
        missing,
      });
    }

    const { scheduled_at } = req.body;
    const publishAt = scheduled_at ? new Date(scheduled_at) : new Date();
    const isFuture = publishAt.getTime() > Date.now();

    await post.update({
      status: isFuture ? 'scheduled' : 'published',
      published_at: publishAt,
    });

    triggerVercelDeploy(`blog:publish:${post.slug}`).catch(() => {});

    res.json({ success: true, message: isFuture ? 'Post programado exitosamente' : 'Post publicado exitosamente', post });
  } catch (error) {
    console.error('Error al publicar post de blog:', error);
    res.status(500).json({ success: false, message: 'Error al publicar el post', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.uploadCover = async (req, res) => {
  try {
    const post = await BlogPost.findByPk(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No se envió ninguna imagen' });
    }

    const { url } = await uploadToCloudinary(req.file.buffer, req.file.originalname, 'blog-covers', {
      mimeType: req.file.mimetype,
    });

    await post.update({ cover_image_url: url });

    if (post.status === 'published') {
      triggerVercelDeploy(`blog:cover:${post.slug}`).catch(() => {});
    }

    res.json({ success: true, message: 'Portada actualizada', cover_image_url: url, post });
  } catch (error) {
    console.error('Error al subir portada del post:', error);
    res.status(500).json({ success: false, message: 'Error al subir la portada', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};

exports.unpublishPost = async (req, res) => {
  try {
    const post = await BlogPost.findByPk(req.params.id);
    if (!post) return res.status(404).json({ success: false, message: 'Post no encontrado' });

    const wasPublished = post.status === 'published';
    await post.update({ status: 'draft', published_at: null });

    if (wasPublished) {
      triggerVercelDeploy(`blog:unpublish:${post.slug}`).catch(() => {});
    }

    res.json({ success: true, message: 'Post despublicado exitosamente', post });
  } catch (error) {
    console.error('Error al despublicar post de blog:', error);
    res.status(500).json({ success: false, message: 'Error al despublicar el post', error: process.env.NODE_ENV === 'production' ? undefined : error.message });
  }
};
