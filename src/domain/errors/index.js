/**
 * Shared error contract for the API.
 * All domain errors extend AppError and carry an HTTP status code.
 */

class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400);
  }
}

class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409);
  }
}

class InternalError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500);
  }
}

/**
 * Map an AppError (or any Error) to an HTTP response body + status.
 * Unknown errors are coerced to 500 with a safe message.
 */
function toHttpResponse(error) {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: {
        error: error.name.replace('Error', ''),
        message: error.message,
      },
    };
  }
  // Unknown error — hide details from client
  return {
    status: 500,
    body: {
      error: 'InternalError',
      message: 'Internal server error',
    },
  };
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InternalError,
  toHttpResponse,
};
