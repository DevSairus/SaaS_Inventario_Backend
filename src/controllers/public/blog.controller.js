// controllers/public/blog.controller.js
// Endpoints públicos sin autenticación — solo posts publicados y vigentes.
const { BlogPost } = require('../../models');
const { Op } = require('sequelize');

const PUBLISHED_WHERE = () => ({
  status: 'published',
  published_at: { [Op.lte]: new Date() },
});

const PUBLIC_ATTRIBUTES = [
  'id', 'title', 'slug', 'excerpt', 'content', 'cover_image_url', 'category',
  'tags', 'meta_title', 'meta_description', 'published_at', 'reading_time_minutes',
  'created_at', 'updated_at',
];

exports.getPublicPosts = async (req, res) => {
  try {
    const { page = 1, limit = 20, category, tag } = req.query;
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 20), 100);
    const safePage = Math.max(1, parseInt(page) || 1);

    const where = PUBLISHED_WHERE();
    if (category) where.category = category;
    if (tag) where.tags = { [Op.contains]: [tag] };

    const posts = await BlogPost.findAndCountAll({
      where,
      attributes: PUBLIC_ATTRIBUTES.filter((a) => a !== 'content'),
      order: [['published_at', 'DESC']],
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
    console.error('Error al listar posts públicos del blog:', error);
    res.status(500).json({ success: false, message: 'Error al obtener los artículos' });
  }
};

exports.getPublicPostBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const post = await BlogPost.findOne({
      where: { slug, ...PUBLISHED_WHERE() },
      attributes: PUBLIC_ATTRIBUTES,
    });

    if (!post) {
      return res.status(404).json({ success: false, message: 'Artículo no encontrado' });
    }

    const related = await BlogPost.findAll({
      where: {
        ...PUBLISHED_WHERE(),
        category: post.category,
        id: { [Op.ne]: post.id },
      },
      attributes: PUBLIC_ATTRIBUTES.filter((a) => a !== 'content'),
      order: [['published_at', 'DESC']],
      limit: 3,
    });

    res.json({ success: true, post, related });
  } catch (error) {
    console.error('Error al obtener post público del blog:', error);
    res.status(500).json({ success: false, message: 'Error al obtener el artículo' });
  }
};
