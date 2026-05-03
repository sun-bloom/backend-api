const test = require('node:test');
const assert = require('node:assert/strict');

test('error contract — ValidationError maps to 400', () => {
  const { ValidationError, toHttpResponse } = require('../src/domain/errors/index.js');
  const err = new ValidationError('email is required');
  const response = toHttpResponse(err);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Validation');
  assert.equal(response.body.message, 'email is required');
});

test('error contract — AuthError maps to 401', () => {
  const { AuthError, toHttpResponse } = require('../src/domain/errors/index.js');
  const err = new AuthError('token expired');
  const response = toHttpResponse(err);
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'Auth');
  assert.equal(response.body.message, 'token expired');
});

test('error contract — NotFoundError maps to 404', () => {
  const { NotFoundError, toHttpResponse } = require('../src/domain/errors/index.js');
  const err = new NotFoundError('product not found');
  const response = toHttpResponse(err);
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'NotFound');
  assert.equal(response.body.message, 'product not found');
});

test('error contract — ConflictError maps to 409', () => {
  const { ConflictError, toHttpResponse } = require('../src/domain/errors/index.js');
  const err = new ConflictError('slug already exists');
  const response = toHttpResponse(err);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'Conflict');
  assert.equal(response.body.message, 'slug already exists');
});

test('error contract — InternalError maps to 500', () => {
  const { InternalError, toHttpResponse } = require('../src/domain/errors/index.js');
  const err = new InternalError('database unavailable');
  const response = toHttpResponse(err);
  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'Internal');
  assert.equal(response.body.message, 'database unavailable');
});

test('error contract — unknown Error coerced to 500', () => {
  const { toHttpResponse } = require('../src/domain/errors/index.js');
  const err = new Error('something weird');
  const response = toHttpResponse(err);
  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'InternalError');
  assert.equal(response.body.message, 'Internal server error');
});

test('logger — createLogger returns expected methods', () => {
  const { createLogger } = require('../src/domain/logger.js');
  const log = createLogger('test-id');
  assert.ok(typeof log.debug === 'function');
  assert.ok(typeof log.info === 'function');
  assert.ok(typeof log.warn === 'function');
  assert.ok(typeof log.error === 'function');
  assert.ok(typeof log.auth === 'function');
});

test('logger — generateCorrelationId returns non-empty string', () => {
  const { generateCorrelationId } = require('../src/domain/logger.js');
  const id = generateCorrelationId();
  assert.ok(typeof id === 'string');
  assert.ok(id.length > 0);
});
