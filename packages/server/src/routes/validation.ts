import { getDb } from '@decigraph/core/db/index.js';
import { ValidationError, ConflictError } from '@decigraph/core/types.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUUID(val: unknown, field: string): string {
  if (typeof val !== 'string' || !UUID_RE.test(val)) {
    throw new ValidationError(`${field} must be a valid UUID`);
  }
  return val;
}

export function requireString(val: unknown, field: string, maxLen = 10000): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ValidationError(`${field} is required`);
  }
  if (val.length > maxLen) {
    throw new ValidationError(`${field} exceeds maximum length of ${maxLen}`);
  }
  return val.trim();
}

export function optionalString(val: unknown, field: string, maxLen = 10000): string | undefined {
  if (val === undefined || val === null) return undefined;
  return requireString(val, field, maxLen);
}

export function validateTags(val: unknown): string[] {
  if (!val) return [];
  if (!Array.isArray(val)) throw new ValidationError('tags must be an array');
  if (val.length > 50) throw new ValidationError('tags: maximum 50 items');
  return val.map((t, i) => {
    if (typeof t !== 'string') throw new ValidationError(`tags[${i}] must be a string`);
    if (t.length > 100) throw new ValidationError(`tags[${i}] exceeds 100 characters`);
    return t;
  });
}

export function validateAffects(val: unknown): string[] {
  if (!val) return [];
  if (!Array.isArray(val)) throw new ValidationError('affects must be an array');
  if (val.length > 50) throw new ValidationError('affects: maximum 50 items');
  return val.map((a, i) => {
    if (typeof a !== 'string') throw new ValidationError(`affects[${i}] must be a string`);
    if (a.length > 100) throw new ValidationError(`affects[${i}] exceeds 100 characters`);
    return a;
  });
}

export function validateAlternatives(
  val: unknown,
): Array<{ option: string; rejected_reason: string }> {
  if (!val) return [];
  if (!Array.isArray(val)) throw new ValidationError('alternatives_considered must be an array');
  if (val.length > 20) throw new ValidationError('alternatives_considered: maximum 20 items');
  return val;
}

// Map PostgreSQL error codes to safe application errors
export function mapDbError(err: unknown): never {
  const code = (err as { code?: string }).code;
  if (code === '23505') throw new ConflictError('Resource already exists');
  if (code === '23503') throw new ValidationError('Referenced resource not found');
  throw err;
}

// Re-export embedding from core (uses centralized LLM config)
import { generateEmbedding as coreGenerateEmbedding } from '@decigraph/core/decision-graph/embeddings.js';

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const embedding = await coreGenerateEmbedding(text);
    const isZero = embedding.every((v) => v === 0);
    return isZero ? null : embedding;
  } catch {
    return null;
  }
}

// Rough token approximation: 4 chars ≈ 1 token
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Append-only audit log helper
export function logAudit(
  eventType: string,
  projectId: string | null,
  details: Record<string, unknown>,
): void {
  getDb().query(`INSERT INTO audit_log (event_type, project_id, details) VALUES (?, ?, ?)`, [
    eventType,
    projectId,
    JSON.stringify(details),
  ]).catch((err: Error) => {
    console.error('[decigraph] Audit log error:', err.message);
  });
}
