'use strict';

class VerificationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    this.status = status;
  }
}

module.exports = { VerificationError };
