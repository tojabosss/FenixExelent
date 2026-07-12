'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { logger } = require('./logger');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Brak DATABASE_URL. Ustaw adres PostgreSQL w zmiennych środowiskowych.');
}

const isLocalDatabase = /localhost|127\.0\.0\.1/.test(connectionString);
const sslEnabled = process.env.DATABASE_SSL === 'true' ||
  (process.env.DATABASE_SSL !== 'false' && !isLocalDatabase);

const pool = new Pool({
  connectionString,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DATABASE_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'fenixexelent-security',
});

pool.on('error', error => {
  logger.error('PostgreSQL pool error:', error);
});

let initialized = false;
let saveQueue = Promise.resolve();

async function initializeDatabase() {
  if (initialized) return;

  await pool.query(`
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

async function migrateLegacyConfigIfNeeded(legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return false;

  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM guild_config');
  if (countResult.rows[0].count > 0) return false;

  try {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO app_config(key, value_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT(key) DO UPDATE
          SET value_json = EXCLUDED.value_json, updated_at = NOW()
      `, ['dashboardPort', JSON.stringify(legacy.dashboardPort || 3000)]);

      await client.query(`
        INSERT INTO app_config(key, value_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT(key) DO UPDATE
          SET value_json = EXCLUDED.value_json, updated_at = NOW()
      `, ['dashboardUrl', JSON.stringify(legacy.dashboardUrl || null)]);

      for (const [guildId, guildConfig] of Object.entries(legacy.guilds || {})) {
        await client.query(`
          INSERT INTO guild_config(guild_id, config_json, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT(guild_id) DO UPDATE
            SET config_json = EXCLUDED.config_json, updated_at = NOW()
        `, [guildId, JSON.stringify(guildConfig)]);
      }

      await client.query('COMMIT');
      fs.renameSync(legacyPath, `${legacyPath}.migrated`);
      logger.info('Migrated config.json to PostgreSQL');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Legacy config migration failed:', error);
    return false;
  }
}

async function getAppValue(key, fallback) {
  const result = await pool.query('SELECT value_json FROM app_config WHERE key = $1', [key]);
  return result.rows[0]?.value_json ?? fallback;
}

async function loadConfig({ legacyPath, defaultPort, defaultUrl }) {
  await initializeDatabase();
  await migrateLegacyConfigIfNeeded(legacyPath);

  const guildResult = await pool.query('SELECT guild_id, config_json FROM guild_config');
  const guilds = {};
  for (const row of guildResult.rows) {
    guilds[row.guild_id] = row.config_json || {};
  }

  const storedPort = await getAppValue('dashboardPort', defaultPort);
  const storedUrl = await getAppValue('dashboardUrl', defaultUrl);

  return {
    dashboardPort: Number(process.env.PORT || storedPort || defaultPort),
    dashboardUrl: process.env.DASHBOARD_URL || storedUrl || defaultUrl,
    guilds,
  };
}

async function persistConfig(config) {
  await initializeDatabase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO app_config(key, value_json, updated_at)
      VALUES ('dashboardPort', $1::jsonb, NOW())
      ON CONFLICT(key) DO UPDATE
        SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `, [JSON.stringify(config.dashboardPort)]);

    await client.query(`
      INSERT INTO app_config(key, value_json, updated_at)
      VALUES ('dashboardUrl', $1::jsonb, NOW())
      ON CONFLICT(key) DO UPDATE
        SET value_json = EXCLUDED.value_json, updated_at = NOW()
    `, [JSON.stringify(config.dashboardUrl)]);

    for (const [guildId, guildConfig] of Object.entries(config.guilds || {})) {
      await client.query(`
        INSERT INTO guild_config(guild_id, config_json, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT(guild_id) DO UPDATE
          SET config_json = EXCLUDED.config_json, updated_at = NOW()
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
  saveQueue = saveQueue
    .then(() => persistConfig(snapshot))
    .catch(error => {
      logger.error('PostgreSQL config save failed:', error);
    });
  return saveQueue;
}

function writeAudit({ guildId = null, userId = null, eventType, payload = {} }) {
  return pool.query(`
    INSERT INTO audit_log(guild_id, user_id, event_type, payload_json)
    VALUES ($1, $2, $3, $4::jsonb)
  `, [guildId, userId, eventType, JSON.stringify(payload)]).catch(error => {
    logger.error('PostgreSQL audit write failed:', error);
  });
}

async function closeDatabase() {
  await saveQueue.catch(() => {});
  await pool.end();
}

module.exports = {
  databaseType: 'postgresql',
  pool,
  initializeDatabase,
  loadConfig,
  saveConfig,
  writeAudit,
  closeDatabase,
};
