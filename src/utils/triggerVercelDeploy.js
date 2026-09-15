const axios = require('axios');
const logger = require('../config/logger');

/**
 * Dispara el Deploy Hook de Vercel del frontend (Opción B del blog: SSG
 * dirigido al publicar). El hook se crea a mano en Vercel (Project Settings
 * → Git → Deploy Hooks) y su URL se guarda en VERCEL_DEPLOY_HOOK_URL. Sin
 * esa variable, no hace nada más que avisar por log — no rompe el flujo de
 * publicar/despublicar un post.
 */
const triggerVercelDeploy = async (reason = 'blog') => {
  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    logger.warn(`VERCEL_DEPLOY_HOOK_URL no configurada — no se disparó el rebuild (${reason}).`);
    return;
  }

  try {
    await axios.post(hookUrl);
    logger.info(`Deploy hook de Vercel disparado (${reason}).`);
  } catch (error) {
    logger.error(`Error disparando el deploy hook de Vercel (${reason}):`, error.message);
  }
};

module.exports = { triggerVercelDeploy };
