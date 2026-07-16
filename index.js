'use strict';

const { bootstrap } = require('./src/application');

bootstrap().catch(error => {
  console.error('Application bootstrap failed:', error);
  process.exitCode = 1;
});
