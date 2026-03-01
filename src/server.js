require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const { testConnection } = require('./config/db');

// ── Routes ───────────────────────────────────────────────────────
const authRouter          = require('./routes/auth');
const assetsRouter        = require('./routes/assets');
const rigsRouter          = require('./routes/rigs');
const companiesRouter     = require('./routes/companies');
const contractsRouter     = require('./routes/contracts');
const usersRouter         = require('./routes/users');
const bomRouter           = require('./routes/bom');
const maintenanceRouter   = require('./routes/maintenance');
const transfersRouter     = require('./routes/transfers');
const notificationsRouter = require('./routes/notifications');
const reportsRouter       = require('./routes/reports');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security ─────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// ── CORS ─────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim());
const corsOptions = {
  origin: allowedOrigins.includes('*') ? '*' : (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  // credentials:true is INCOMPATIBLE with origin:'*' — omit when wildcard
  credentials: !allowedOrigins.includes('*'),
};
app.use(cors(corsOptions));
// Handle preflight for ALL routes (required for DELETE/PUT/PATCH)
app.options('*', cors(corsOptions));

// ── Body parsers ─────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(compression());

// ── Logging ──────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Global rate limiter ──────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please try again later.' },
}));

// ── Stricter limiter for auth ────────────────────────────────────
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
}));

// ── Health check ─────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  const dbOk = await testConnection().catch(() => false);
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'error',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

app.get('/', (_req, res) => {
  res.json({ name: 'Asset Management API', version: '1.0.0', status: 'running' });
});

// ── API Routes ───────────────────────────────────────────────────
app.use('/api/auth',          authRouter);
app.use('/api/assets',        assetsRouter);
app.use('/api/rigs',          rigsRouter);
app.use('/api/companies',     companiesRouter);
app.use('/api/contracts',     contractsRouter);
app.use('/api/users',         usersRouter);
app.use('/api/bom',           bomRouter);
app.use('/api/maintenance',   maintenanceRouter);
app.use('/api/transfers',     transfersRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/reports',       reportsRouter);

// ── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// ── Global error handler ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err.stack || err.message);
  res.status(err.status || 500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────
async function start() {
  console.log(`\n🔧  Asset Management API – starting...`);
  console.log(`   NODE_ENV : ${process.env.NODE_ENV || 'development'}`);

  const dbReady = await testConnection();
  if (!dbReady && process.env.NODE_ENV === 'production') {
    console.error('❌  Database not reachable. Exiting.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅  Server listening on port ${PORT}\n`);
  });
}

start();

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err.message);
  process.exit(1);
});

module.exports = app;
