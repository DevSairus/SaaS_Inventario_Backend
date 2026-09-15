'use strict';

module.exports = {
  up: async (queryInterface) => {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.sequelize.query(`
        DO $$ BEGIN
          CREATE TYPE enum_blog_posts_status AS ENUM ('draft', 'scheduled', 'published');
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `, { transaction });

      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS blog_posts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title VARCHAR(255) NOT NULL,
          slug VARCHAR(255) NOT NULL UNIQUE,
          excerpt VARCHAR(300),
          content TEXT NOT NULL,
          cover_image_url VARCHAR(255),
          category VARCHAR(50),
          tags VARCHAR(255)[] DEFAULT ARRAY[]::VARCHAR(255)[],
          meta_title VARCHAR(70),
          meta_description VARCHAR(160),
          focus_keyword VARCHAR(100),
          status enum_blog_posts_status NOT NULL DEFAULT 'draft',
          published_at TIMESTAMP WITH TIME ZONE,
          author_id UUID REFERENCES "public"."users"(id),
          reading_time_minutes INTEGER DEFAULT 1,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        );
      `, { transaction });

      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS blog_posts_status_idx ON blog_posts (status)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS blog_posts_published_at_idx ON blog_posts (published_at)`,
        { transaction }
      );
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS blog_posts_category_idx ON blog_posts (category)`,
        { transaction }
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('blog_posts');
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_blog_posts_status;`);
  },
};
