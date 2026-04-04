// Error Types Unit Tests

import { describe, it, expect } from 'vitest';
import { DeciGraphError, NotFoundError, ValidationError, ConflictError } from '../src/types.js';

// ── DeciGraphError ────────────────────────────────────────────────────────────────

describe('DeciGraphError', () => {
  it('constructs with message, code, and default statusCode 500', () => {
    const err = new DeciGraphError('Something broke', 'INTERNAL_ERROR');
    expect(err.message).toBe('Something broke');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.statusCode).toBe(500);
    expect(err.details).toBeUndefined();
  });

  it('accepts a custom statusCode', () => {
    const err = new DeciGraphError('Not allowed', 'FORBIDDEN', 403);
    expect(err.statusCode).toBe(403);
  });

  it('accepts optional details', () => {
    const details = { field: 'name', issue: 'required' };
    const err = new DeciGraphError('Bad input', 'BAD_REQUEST', 400, details);
    expect(err.details).toEqual(details);
  });

  it('is an instance of Error', () => {
    const err = new DeciGraphError('oops', 'OOPS');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name = "DeciGraphError"', () => {
    const err = new DeciGraphError('oops', 'OOPS');
    expect(err.name).toBe('DeciGraphError');
  });

  it('has a stack trace', () => {
    const err = new DeciGraphError('oops', 'OOPS');
    expect(err.stack).toBeDefined();
  });

  it('is instance of DeciGraphError', () => {
    const err = new DeciGraphError('oops', 'OOPS');
    expect(err).toBeInstanceOf(DeciGraphError);
  });
});

// ── NotFoundError ─────────────────────────────────────────────────────────────

describe('NotFoundError', () => {
  it('constructs with resource and id', () => {
    const err = new NotFoundError('Project', 'abc-123');
    expect(err.message).toBe('Project not found: abc-123');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.statusCode).toBe(404);
  });

  it('is an instance of DeciGraphError and Error', () => {
    const err = new NotFoundError('Decision', 'def-456');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeciGraphError);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('formats message correctly for Agent resource', () => {
    const err = new NotFoundError('Agent', 'agent-007');
    expect(err.message).toBe('Agent not found: agent-007');
  });

  it('has statusCode 404', () => {
    const err = new NotFoundError('Artifact', 'xyz');
    expect(err.statusCode).toBe(404);
  });

  it('has code NOT_FOUND', () => {
    const err = new NotFoundError('Session', 'sess-1');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('can be caught as a DeciGraphError', () => {
    function mayThrow() {
      throw new NotFoundError('Foo', 'bar');
    }

    try {
      mayThrow();
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeciGraphError);
      const decigraphErr = e as DeciGraphError;
      expect(decigraphErr.statusCode).toBe(404);
      expect(decigraphErr.code).toBe('NOT_FOUND');
    }
  });
});

// ── ValidationError ───────────────────────────────────────────────────────────

describe('ValidationError', () => {
  it('constructs with message only', () => {
    const err = new ValidationError('name is required');
    expect(err.message).toBe('name is required');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    expect(err.details).toBeUndefined();
  });

  it('accepts details', () => {
    const details = [{ field: 'email', message: 'invalid format' }];
    const err = new ValidationError('Invalid input', details);
    expect(err.details).toEqual(details);
  });

  it('is an instance of DeciGraphError and Error', () => {
    const err = new ValidationError('bad input');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeciGraphError);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it('has statusCode 400', () => {
    const err = new ValidationError('oops');
    expect(err.statusCode).toBe(400);
  });

  it('has code VALIDATION_ERROR', () => {
    const err = new ValidationError('oops');
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('can distinguish from NotFoundError', () => {
    const validationErr = new ValidationError('bad');
    const notFoundErr = new NotFoundError('Foo', 'bar');

    expect(validationErr).not.toBeInstanceOf(NotFoundError);
    expect(notFoundErr).not.toBeInstanceOf(ValidationError);
  });
});

// ── ConflictError ─────────────────────────────────────────────────────────────

describe('ConflictError', () => {
  it('constructs with message', () => {
    const err = new ConflictError('Resource already exists');
    expect(err.message).toBe('Resource already exists');
    expect(err.code).toBe('CONFLICT');
    expect(err.statusCode).toBe(409);
  });

  it('is an instance of DeciGraphError and Error', () => {
    const err = new ConflictError('duplicate key');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeciGraphError);
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('has statusCode 409', () => {
    const err = new ConflictError('conflict');
    expect(err.statusCode).toBe(409);
  });

  it('has code CONFLICT', () => {
    const err = new ConflictError('conflict');
    expect(err.code).toBe('CONFLICT');
  });

  it('has no details by default', () => {
    const err = new ConflictError('conflict');
    expect(err.details).toBeUndefined();
  });
});

// ── Error hierarchy (instanceof discrimination) ───────────────────────────────

describe('Error hierarchy discrimination', () => {
  const errors = [
    new DeciGraphError('base', 'BASE'),
    new NotFoundError('X', 'y'),
    new ValidationError('bad'),
    new ConflictError('conflict'),
  ];

  it('all errors are instances of Error', () => {
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it('all errors are instances of DeciGraphError', () => {
    for (const e of errors) {
      expect(e).toBeInstanceOf(DeciGraphError);
    }
  });

  it('subclass errors are NOT instances of sibling classes', () => {
    const notFound = new NotFoundError('X', 'y');
    const validation = new ValidationError('bad');
    const conflict = new ConflictError('conflict');

    expect(notFound).not.toBeInstanceOf(ValidationError);
    expect(notFound).not.toBeInstanceOf(ConflictError);
    expect(validation).not.toBeInstanceOf(NotFoundError);
    expect(validation).not.toBeInstanceOf(ConflictError);
    expect(conflict).not.toBeInstanceOf(NotFoundError);
    expect(conflict).not.toBeInstanceOf(ValidationError);
  });

  it('switch-on statusCode correctly routes error types', () => {
    function classify(err: DeciGraphError): string {
      switch (err.statusCode) {
        case 400:
          return 'validation';
        case 404:
          return 'not_found';
        case 409:
          return 'conflict';
        default:
          return 'server_error';
      }
    }

    expect(classify(new ValidationError('bad'))).toBe('validation');
    expect(classify(new NotFoundError('X', 'y'))).toBe('not_found');
    expect(classify(new ConflictError('conflict'))).toBe('conflict');
    expect(classify(new DeciGraphError('oops', 'ERR', 500))).toBe('server_error');
  });
});
