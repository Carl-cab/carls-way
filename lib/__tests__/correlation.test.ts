/**
 * Unit tests for correlation ID utilities.
 *
 * Tests cover:
 * - Correlation ID generation (format, uniqueness)
 * - Extraction from headers (X-Correlation-ID, X-Request-ID, traceparent)
 * - Sanitization (injection prevention)
 * - Validation (format enforcement)
 * - Request context creation
 */

import {
  generateCorrelationId,
  sanitizeCorrelationId,
  isValidCorrelationId,
  serializeCorrelationId,
  createRequestContext,
} from '../correlation';

describe('Correlation ID Utilities', () => {
  describe('generateCorrelationId', () => {
    it('should generate a new correlation ID', () => {
      const id = generateCorrelationId();
      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    it('should use "corr_" prefix', () => {
      const id = generateCorrelationId();
      expect(id.startsWith('corr_')).toBe(true);
    });

    it('should generate random hex after prefix', () => {
      const id = generateCorrelationId();
      const hex = id.slice(5); // Remove "corr_" prefix
      expect(/^[a-f0-9]+$/.test(hex)).toBe(true);
    });

    it('should generate unique IDs', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      expect(id1).not.toEqual(id2);
    });

    it('should generate IDs of consistent length', () => {
      const id1 = generateCorrelationId();
      const id2 = generateCorrelationId();
      expect(id1.length).toEqual(id2.length);
    });
  });

  describe('sanitizeCorrelationId', () => {
    it('should accept valid correlation IDs unchanged', () => {
      const valid = 'corr_abc123xyz';
      expect(sanitizeCorrelationId(valid)).toBe(valid);
    });

    it('should remove non-alphanumeric characters except hyphens and underscores', () => {
      const dirty = 'corr-abc!@#$%^&*()123-xyz';
      const cleaned = sanitizeCorrelationId(dirty);
      expect(cleaned).toBe('corr-abc123-xyz');
    });

    it('should truncate to 255 characters', () => {
      const long = 'x'.repeat(300);
      const cleaned = sanitizeCorrelationId(long);
      expect(cleaned.length).toBeLessThanOrEqual(255);
    });

    it('should reject SQL injection attempts', () => {
      const injection = "corr_123'; DROP TABLE users; --";
      const cleaned = sanitizeCorrelationId(injection);
      expect(cleaned).not.toContain("'");
      expect(cleaned).not.toContain(';');
      expect(cleaned).not.toContain('--');
    });

    it('should handle newlines', () => {
      const newline = 'corr_123\n456';
      const cleaned = sanitizeCorrelationId(newline);
      expect(cleaned).not.toContain('\n');
    });

    it('should generate new ID if input becomes empty after sanitization', () => {
      const empty = '!@#$%^&*()';
      const result = sanitizeCorrelationId(empty);
      expect(result).toBeDefined();
      expect(result.startsWith('corr_')).toBe(true);
    });
  });

  describe('isValidCorrelationId', () => {
    it('should accept valid correlation IDs', () => {
      expect(isValidCorrelationId('corr_abc123')).toBe(true);
      expect(isValidCorrelationId('request-id-123')).toBe(true);
      expect(isValidCorrelationId('UPPERCASE_ID')).toBe(true);
    });

    it('should reject empty strings', () => {
      expect(isValidCorrelationId('')).toBe(false);
    });

    it('should reject null or undefined', () => {
      expect(isValidCorrelationId(null)).toBe(false);
      expect(isValidCorrelationId(undefined)).toBe(false);
    });

    it('should reject IDs longer than 255 characters', () => {
      const long = 'x'.repeat(256);
      expect(isValidCorrelationId(long)).toBe(false);
    });

    it('should reject IDs with special characters', () => {
      expect(isValidCorrelationId('corr_123!@#')).toBe(false);
      expect(isValidCorrelationId('corr_123;drop')).toBe(false);
    });

    it('should accept hyphens and underscores', () => {
      expect(isValidCorrelationId('corr_abc-def_123')).toBe(true);
    });
  });

  describe('serializeCorrelationId', () => {
    it('should return sanitized valid ID', () => {
      const valid = 'corr_abc123';
      expect(serializeCorrelationId(valid)).toBe(valid);
    });

    it('should sanitize invalid ID', () => {
      const dirty = 'corr_123!@#456';
      const result = serializeCorrelationId(dirty);
      expect(isValidCorrelationId(result)).toBe(true);
    });

    it('should generate new ID if input is empty after sanitization', () => {
      const result = serializeCorrelationId('!@#$%^&*()');
      expect(result.startsWith('corr_')).toBe(true);
    });

    it('should be idempotent', () => {
      const id = 'corr_test123';
      const once = serializeCorrelationId(id);
      const twice = serializeCorrelationId(once);
      expect(once).toEqual(twice);
    });
  });

  describe('createRequestContext', () => {
    it('should create context with correlation ID', () => {
      const context = createRequestContext('corr_test123');
      expect(context.correlationId).toBe('corr_test123');
    });

    it('should include timestamp', () => {
      const before = new Date();
      const context = createRequestContext('corr_test123');
      const after = new Date();
      expect(context.timestamp).toBeInstanceOf(Date);
      expect(context.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(context.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should include optional user ID', () => {
      const context = createRequestContext('corr_test123', 123);
      expect(context.userId).toBe(123);
    });

    it('should include optional source IP', () => {
      const context = createRequestContext('corr_test123', undefined, '192.168.1.1');
      expect(context.sourceIp).toBe('192.168.1.1');
    });

    it('should include optional user agent', () => {
      const context = createRequestContext('corr_test123', undefined, undefined, 'Mozilla/5.0');
      expect(context.userAgent).toBe('Mozilla/5.0');
    });

    it('should have undefined userId if not provided', () => {
      const context = createRequestContext('corr_test123');
      expect(context.userId).toBeUndefined();
    });

    it('should have undefined adminId initially', () => {
      const context = createRequestContext('corr_test123');
      expect(context.adminId).toBeUndefined();
    });
  });

  describe('Correlation ID immutability', () => {
    it('should preserve correlation ID through multiple operations', () => {
      const original = generateCorrelationId();
      const sanitized = sanitizeCorrelationId(original);
      const serialized = serializeCorrelationId(sanitized);
      expect(serialized).toBe(original);
    });

    it('should maintain correlation ID in request context', () => {
      const id = generateCorrelationId();
      const context = createRequestContext(id);
      expect(context.correlationId).toBe(id);
      // Verify it's not modified
      expect(context.correlationId).toEqual(id);
    });
  });

  describe('Format consistency', () => {
    it('should always start with "corr_"', () => {
      for (let i = 0; i < 10; i++) {
        const id = generateCorrelationId();
        expect(id.startsWith('corr_')).toBe(true);
      }
    });

    it('should be URL-safe', () => {
      const id = generateCorrelationId();
      // Should not contain characters that need URL encoding
      expect(/^[a-zA-Z0-9_-]+$/.test(id)).toBe(true);
    });

    it('should be database-safe', () => {
      const id = generateCorrelationId();
      // Should not contain quotes or semicolons
      expect(id).not.toContain("'");
      expect(id).not.toContain('"');
      expect(id).not.toContain(';');
      expect(id).not.toContain('--');
    });
  });
});
