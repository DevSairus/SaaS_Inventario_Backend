// runt-remote-service/index.js
// Mini servidor para Raspberry Pi / VPS — recibe peticiones de Railway y las reenvía al RUNT.
// Ejecutar: node index.js
// Puerto: 4445 (configurable via PORT)

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 4445;
const RUNT_BASE = 'https://runtproapi.runt.gov.co/CYRConsultaVehiculoMS';
const API_KEY = process.env.RUNT_API_KEY || 'pitbox-runt-2026';

const runtHeaders = {
  'Content-Type': 'application/json',
  'Origin': 'https://portalpublico.runt.gov.co',
  'Referer': 'https://portalpublico.runt.gov.co/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'runt-proxy' }));

// POST /api/runt/captcha — obtener captcha
app.post('/api/runt/captcha', auth, async (req, res) => {
  try {
    const response = await axios.get(
      `${RUNT_BASE}/captcha/libre-captcha/generar`,
      { headers: runtHeaders, timeout: 15000 }
    );
    res.json(response.data);
  } catch (err) {
    console.error('[RUNT] captcha error:', err.message);
    res.status(err.response?.status || 502).json({
      error: true, message: err.message, data: err.response?.data
    });
  }
});

// POST /api/runt/auth — consultar vehículo
app.post('/api/runt/auth', auth, async (req, res) => {
  try {
    const response = await axios.post(
      `${RUNT_BASE}/auth`,
      req.body,
      { headers: runtHeaders, timeout: 20000 }
    );
    // Reenviar cookies
    const setCookie = response.headers['set-cookie'];
    if (setCookie) res.setHeader('Set-Cookie', setCookie);
    res.json(response.data);
  } catch (err) {
    console.error('[RUNT] auth error:', err.message);
    res.status(err.response?.status || 502).json({
      error: true, message: err.message, data: err.response?.data
    });
  }
});

// POST /api/runt/soat — consultar SOAT
app.post('/api/runt/soat', auth, async (req, res) => {
  try {
    const headers = { ...runtHeaders, ...req.body.extraHeaders };
    const response = await axios.get(`${RUNT_BASE}/soat`, { headers, timeout: 10000 });
    res.json(response.data);
  } catch (err) {
    console.error('[RUNT] soat error:', err.message);
    res.status(err.response?.status || 502).json({ error: true, message: err.message });
  }
});

// POST /api/runt/rtms — consultar RTM
app.post('/api/runt/rtms', auth, async (req, res) => {
  try {
    const headers = { ...runtHeaders, ...req.body.extraHeaders };
    const response = await axios.get(`${RUNT_BASE}/rtms`, {
      headers, params: req.body.params || {}, timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    console.error('[RUNT] rtms error:', err.message);
    res.status(err.response?.status || 502).json({ error: true, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`RUNT Remote Service corriendo en puerto ${PORT}`);
  console.log(`API Key: ${API_KEY}`);
});
