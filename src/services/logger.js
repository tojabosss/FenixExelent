
'use strict';

const util = require('util');
const pino = require('pino');

const isDevelopment = process.env.NODE_ENV !== 'production';
const transport = isDevelopment
  ? pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', singleLine: false },
    })
  : undefined;

const base = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'fenixexelent-security' },
  redact: {
    paths: ['token', 'BOT_TOKEN', 'CLIENT_SECRET', 'SESSION_SECRET', '*.token'],
    censor: '[REDACTED]',
  },
}, transport);

function normalizeArgs(args) {
  const values = Array.from(args);
  const error = values.find(value => value instanceof Error);
  const messageValues = values.filter(value => !(value instanceof Error));
  return {
    error,
    message: util.format(...messageValues),
  };
}

function write(level, ...args) {
  const { error, message } = normalizeArgs(args);
  if (error) base[level]({ err: error }, message || error.message);
  else base[level](message);
}

const logger = {
  trace: (...args) => write('trace', ...args),
  debug: (...args) => write('debug', ...args),
  info: (...args) => write('info', ...args),
  log: (...args) => write('info', ...args),
  warn: (...args) => write('warn', ...args),
  error: (...args) => write('error', ...args),
  fatal: (...args) => write('fatal', ...args),
  child: bindings => base.child(bindings),
  commandError(error, interaction, commandName) {
    base.error({
      err: error,
      event: 'command_error',
      command: commandName,
      guildId: interaction?.guildId || null,
      channelId: interaction?.channelId || null,
      userId: interaction?.user?.id || null,
    }, `Command failed: ${commandName}`);
  },
  buttonError(error, interaction) {
    base.error({
      err: error,
      event: 'button_error',
      customId: interaction?.customId || null,
      guildId: interaction?.guildId || null,
      channelId: interaction?.channelId || null,
      userId: interaction?.user?.id || null,
    }, `Button failed: ${interaction?.customId || 'unknown'}`);
  },
};

process.on('uncaughtException', error => {
  base.fatal({ err: error, event: 'uncaught_exception' }, 'Uncaught exception');
});

process.on('unhandledRejection', error => {
  base.error({ err: error, event: 'unhandled_rejection' }, 'Unhandled rejection');
});

module.exports = { logger };
