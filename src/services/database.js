'use strict';

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

const connectionString = String(process.env.DATABASE_URL || '').trim();
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'));
const localConfigPath = path.join(dataDirectory, 'config.json');
const localAuditPath = path.join(dataDirectory, 'audit.log');

let pool = null;
let initialized = false;
let saveQueue = Promise.resolve();
let databaseType = connectionString ? 'postgresql' : 'json-file';

function ensureDataDirectory() {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

function createPool() {
  if (!connectionString) return null;
  if (pool) return pool;

  const { Pool } = require('pg');
  const isLocalDatabase = /localhost|127\.0\.0\.1/.test(connectionString);
  const sslEnabled = process.env.DATABASE_SSL === 'true' ||
    (process.env.DATABASE_SSL !== 'false' && !isLocalDatabase);

  pool = new Pool({
    connectionString,
    ssl: sslEnabled ? { rejectUnauthorized: false } : false,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'fenixexelent-security',
  });
  pool.on('error', error => logger.error('PostgreSQL pool error:', error));
  return pool;
}

async function initializeDatabase() {
  if (initialized) return;
  if (!connectionString) {
    ensureDataDirectory();
    initialized = true;
    logger.info({ path: localConfigPath }, 'Local JSON storage initialized');
    return;
  }

  const db = createPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      config_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT,
      user_id TEXT,
      event_type TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_guild_created
      ON audit_log(guild_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_created
      ON audit_log(event_type, created_at DESC);
  `);
  initialized = true;
  logger.info('PostgreSQL database initialized');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    logger.error(`Cannot read JSON file ${filePath}:`, error);
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDataDirectory();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

async function migrateLegacyConfigIfNeeded(legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return false;

  if (!connectionString) {
    if (fs.existsSync(localConfigPath)) return false;
    const legacy = readJson(legacyPath);
    if (!legacy) return false;
    writeJsonAtomic(localConfigPath, legacy);
    logger.info('Copied legacy config.json to local data storage');
    return true;
  }

  const db = createPool();
  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM guild_config');
  if (countResult.rows[0].count > 0) return false;
  const legacy = readJson(legacyPath);
  if (!legacy) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO app_config(key, value_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `, ['dashboardPort', JSON.stringify(legacy.dashboardPort || 3000)]);
    await client.query(`
      INSERT INTO app_config(key, value_json, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `, ['dashboardUrl', JSON.stringify(legacy.dashboardUrl || null)]);
    for (const [guildId, guildConfig] of Object.entries(legacy.guilds || {})) {
      await client.query(`
        INSERT INTO guild_config(guild_id, config_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT(guild_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = NOW()
      `, [guildId, JSON.stringify(guildConfig)]);
    }
    await client.query('COMMIT');
    logger.info('Migrated legacy config.json to PostgreSQL');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function getAppValue(key, fallback) {
  const result = await createPool().query('SELECT value_json FROM app_config WHERE key = $1', [key]);
  return result.rows[0]?.value_json ?? fallback;
}

async function loadConfig({ legacyPath, defaultPort, defaultUrl }) {
  await initializeDatabase();
  await migrateLegacyConfigIfNeeded(legacyPath);

  if (!connectionString) {
    const saved = fs.existsSync(localConfigPath) ? readJson(localConfigPath) : null;
    return {
      dashboardPort: Number(process.env.PORT || saved?.dashboardPort || defaultPort || 3000),
      dashboardUrl: process.env.DASHBOARD_URL || saved?.dashboardUrl || defaultUrl,
      guilds: saved?.guilds && typeof saved.guilds === 'object' ? saved.guilds : {},
    };
  }

  const guildResult = await createPool().query('SELECT guild_id, config_json FROM guild_config');
  const guilds = {};
  for (const row of guildResult.rows) guilds[row.guild_id] = row.config_json || {};
  return {
    dashboardPort: Number(process.env.PORT || await getAppValue('dashboardPort', defaultPort) || defaultPort),
    dashboardUrl: process.env.DASHBOARD_URL || await getAppValue('dashboardUrl', defaultUrl) || defaultUrl,
    guilds,
  };
}

async function persistConfig(config) {
  await initializeDatabase();
  if (!connectionString) {
    writeJsonAtomic(localConfigPath, config);
    return;
  }

  const client = await createPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO app_config(key, value_json, updated_at)
      VALUES ('dashboardPort', $1::jsonb, NOW())
      ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `, [JSON.stringify(config.dashboardPort)]);
    await client.query(`
      INSERT INTO app_config(key, value_json, updated_at)
      VALUES ('dashboardUrl', $1::jsonb, NOW())
      ON CONFLICT(key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `, [JSON.stringify(config.dashboardUrl)]);
    for (const [guildId, guildConfig] of Object.entries(config.guilds || {})) {
      await client.query(`
        INSERT INTO guild_config(guild_id, config_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT(guild_id) DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = NOW()
      `, [guildId, JSON.stringify(guildConfig)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function saveConfig(config) {
  const snapshot = JSON.parse(JSON.stringify(config));
  saveQueue = saveQueue.then(() => persistConfig(snapshot));
  saveQueue.catch(error => logger.error('Configuration save failed:', error));
  return saveQueue;
}

function writeAudit({ guildId = null, userId = null, eventType, payload = {} }) {
  if (connectionString) {
    return createPool().query(`
      INSERT INTO audit_log(guild_id, user_id, event_type, payload_json)
      VALUES ($1, $2, $3, $4::jsonb)
    `, [guildId, userId, eventType, JSON.stringify(payload)]).catch(error => {
      logger.error('PostgreSQL audit write failed:', error);
    });
  }

  try {
    ensureDataDirectory();
    fs.appendFileSync(localAuditPath, `${JSON.stringify({ guildId, userId, eventType, payload, createdAt: new Date().toISOString() })}\n`, 'utf8');
    return Promise.resolve();
  } catch (error) {
    logger.error('Local audit write failed:', error);
    return Promise.resolve();
  }
}

async function closeDatabase() {
  await saveQueue.catch(() => {});
  if (pool) await pool.end();
}

module.exports = {
  get databaseType() { return databaseType; },
  get pool() { return pool; },
  get localConfigPath() { return localConfigPath; },
  initializeDatabase,
  loadConfig,
  saveConfig,
  writeAudit,
  closeDatabase,
};
