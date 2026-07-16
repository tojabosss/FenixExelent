'use strict';

const util = require('util');

let base = null;
try {
  const pino = require('pino');
  const transport = process.env.NODE_ENV !== 'production'
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } })
    : undefined;
  base = pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: 'fenixexelent-security' },
    redact: {
      paths: ['token', 'BOT_TOKEN', 'CLIENT_SECRET', 'SESSION_SECRET', '*.token', '*.authorization'],
      censor: '[REDACTED]',
    },
  }, transport);
} catch {
  base = null;
}

function normalize(args) {
  const values = Array.from(args);
  const error = values.find(value => value instanceof Error);
  const messageValues = values.filter(value => !(value instanceof Error));
  const object = messageValues.find(value => value && typeof value === 'object');
  const printable = messageValues.filter(value => value !== object);
  return { error, object, message: util.format(...printable) };
}

function write(level, ...args) {
  const { error, object, message } = normalize(args);
  if (base) {
    const payload = { ...(object || {}) };
    if (error) payload.err = error;
    base[level](payload, message || error?.message || '');
    return;
  }
  const method = level === 'fatal' ? 'error' : level === 'trace' ? 'debug' : level;
  const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
  console[method]?.(prefix, message, object || '', error || '');
}

const logger = {
  trace: (...args) => write('trace', ...args),
  debug: (...args) => write('debug', ...args),
  info: (...args) => write('info', ...args),
  log: (...args) => write('info', ...args),
  warn: (...args) => write('warn', ...args),
  error: (...args) => write('error', ...args),
  fatal: (...args) => write('fatal', ...args),
  child: bindings => base?.child(bindings) || logger,
  commandError(error, interaction, commandName) {
    write('error', error, {
      event: 'command_error', command: commandName,
      guildId: interaction?.guildId || null, channelId: interaction?.channelId || null,
      userId: interaction?.user?.id || null,
    }, `Command failed: ${commandName}`);
  },
  buttonError(error, interaction) {
    write('error', error, {
      event: 'button_error', customId: interaction?.customId || null,
      guildId: interaction?.guildId || null, channelId: interaction?.channelId || null,
      userId: interaction?.user?.id || null,
    }, `Button failed: ${interaction?.customId || 'unknown'}`);
  },
};

module.exports = { logger };
