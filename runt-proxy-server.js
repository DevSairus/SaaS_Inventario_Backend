// runt-proxy-server.js
// Proxy local para el RUNT — se expone con ngrok y Railway lo usa como intermediario.
// Ejecutar: node runt-proxy-server.js
// Luego: ngrok http 4444

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4444;
const RUNT_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaVehiculoMS';

const runtHeaders = {
  'Content-Type': 'application/json',
  'Origin':       'https://portalpublico.runt.gov.co',
  'Referer':      'https://portalpublico.runt.gov.co/',
  'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

// Token simple para proteger el proxy
const PROXY_TOKEN = process.env.PROXY_TOKEN || 'pitrunt2026';

// Middleware de autenticación
function authProxy(req, res, next) {
  const token = req.headers['x-proxy-token'] || req.query.token;
  if (token !== PROXY_TOKEN) {
    return res.status(401).json({ error: 'Token inválido' });
  }
  next();
}

// GET /captcha
app.get('/captcha', authProxy, async (req, res) => {
  try {
    const response = await axios.get(
      `${RUNT_BASE}/captcha/libre-captcha/generar`,
      { headers: runtHeaders, timeout: 15000 }
    );
    res.json(response.data);
  } catch (err) {
    console.error('[Proxy] captcha error:', err.message);
    res.status(err.response?.status || 502).json({
      error: true,
      message: err.message,
      data: err.response?.data || null,
    });
  }
});

// POST /auth
app.post('/auth', authProxy, async (req, res) => {
  try {
    const response = await axios.post(
      `${RUNT_BASE}/auth`,
      req.body,
      { headers: runtHeaders, timeout: 20000 }
    );
    // Reenviar cookies de sesión
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      res.setHeader('Set-Cookie', setCookie);
    }
    res.json(response.data);
  } catch (err) {
    console.error('[Proxy] auth error:', err.message);
    res.status(err.response?.status || 502).json({
      error: true,
      message: err.message,
      data: err.response?.data || null,
    });
  }
});

// GET /soat
app.get('/soat', authProxy, async (req, res) => {
  try {
    const headers = { ...runtHeaders, ...extractAuthHeaders(req) };
    const response = await axios.get(`${RUNT_BASE}/soat`, { headers, timeout: 10000 });
    res.json(response.data);
  } catch (err) {
    console.error('[Proxy] soat error:', err.message);
    res.status(err.response?.status || 502).json({ error: true, message: err.message });
  }
});

// GET /rtms
app.get('/rtms', authProxy, async (req, res) => {
  try {
    const headers = { ...runtHeaders, ...extractAuthHeaders(req) };
    const response = await axios.get(
      `${RUNT_BASE}/rtms`,
      { headers, params: req.query, timeout: 10000 }
    );
    res.json(response.data);
  } catch (err) {
    console.error('[Proxy] rtms error:', err.message);
    res.status(err.response?.status || 502).json({ error: true, message: err.message });
  }
});

function extractAuthHeaders(req) {
  const headers = {};
  if (req.headers['auth-token']) headers['auth-token'] = req.headers['auth-token'];
  if (req.headers['x-funcionalidad']) headers['x-funcionalidad'] = req.headers['x-funcionalidad'];
  return headers;
}

app.listen(PORT, () => {
  console.log(`RUNT Proxy corriendo en puerto ${PORT}`);
  console.log(`Token: ${PROXY_TOKEN}`);
  console.log('Ejecuta: ngrok http ' + PORT);
});
