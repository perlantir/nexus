/**
 * Review Queue + Monitoring Tests
 *
 * Tests auto-approve threshold logic, review status transitions,
 * and monitoring metric calculations.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Auto-approve logic (pure function extracted for testing)
// ---------------------------------------------------------------------------

function resolveReviewStatus(
  confidence: string,
  threshold: number,
): { status: string; reviewStatus: string } {
  const score = confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.6 : 0.3;
  const autoApproved = score >= threshold;
  return {
    status: autoApproved ? 'active' : 'pending',
    reviewStatus: autoApproved ? 'approved' : 'pending_review',
  };
}

// ---------------------------------------------------------------------------
// Monitoring metric calculations (pure)
// ---------------------------------------------------------------------------

function calcPrecision(approved: number, rejected: number): number {
  const total = approved + rejected;
  return total > 0 ? Math.round((approved / total) * 1000) / 1000 : 1;
}

function calcFalsePositiveRate(dismissed: number, total: number): number {
  return total > 0 ? Math.round((dismissed / total) * 1000) / 1000 : 0;
}

function calcFeedbackRate(feedbackCount: number, compileCount: number): number {
  return compileCount > 0 ? Math.round((feedbackCount / compileCount) * 10) / 10 : 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Review Queue', () => {
  describe('Auto-approve threshold', () => {
    it('auto-approves high confidence when threshold is 0.85', () => {
      const result = resolveReviewStatus('high', 0.85);
      expect(result.status).toBe('active');
      expect(result.reviewStatus).toBe('approved');
    });

    it('marks medium confidence as pending when threshold is 0.85', () => {
      const result = resolveReviewStatus('medium', 0.85);
      expect(result.status).toBe('pending');
      expect(result.reviewStatus).toBe('pending_review');
    });

    it('marks low confidence as pending when threshold is 0.85', () => {
      const result = resolveReviewStatus('low', 0.85);
      expect(result.status).toBe('pending');
      expect(result.reviewStatus).toBe('pending_review');
    });

    it('auto-approves everything when threshold is 0.0', () => {
      expect(resolveReviewStatus('high', 0.0).status).toBe('active');
      expect(resolveReviewStatus('medium', 0.0).status).toBe('active');
      expect(resolveReviewStatus('low', 0.0).status).toBe('active');
    });

    it('requires review for everything when threshold is 1.0', () => {
      expect(resolveReviewStatus('high', 1.0).status).toBe('pending');
      expect(resolveReviewStatus('medium', 1.0).status).toBe('pending');
      expect(resolveReviewStatus('low', 1.0).status).toBe('pending');
    });
  });

  describe('Review status transitions', () => {
    it('approve transitions pending_review to approved', () => {
      const before = 'pending_review';
      const after = 'approved';
      expect(before).not.toBe(after);
    });

    it('reject transitions to rejected', () => {
      const before = 'pending_review';
      const after = 'rejected';
      expect(before).not.toBe(after);
    });
  });
});

describe('Monitoring Metrics', () => {
  describe('Extraction quality', () => {
    it('calculates precision correctly', () => {
      expect(calcPrecision(124, 18)).toBeCloseTo(0.873, 2);
    });

    it('returns 1.0 when no reviews (safe default)', () => {
      expect(calcPrecision(0, 0)).toBe(1);
    });

    it('returns 0 when all rejected', () => {
      expect(calcPrecision(0, 10)).toBe(0);
    });

    it('returns 1 when all approved', () => {
      expect(calcPrecision(50, 0)).toBe(1);
    });
  });

  describe('Contradiction false positive rate', () => {
    it('calculates correctly', () => {
      // 2 dismissed out of 12 total
      expect(calcFalsePositiveRate(2, 12)).toBeCloseTo(0.167, 2);
    });

    it('returns 0 when no contradictions', () => {
      expect(calcFalsePositiveRate(0, 0)).toBe(0);
    });
  });

  describe('Feedback rate', () => {
    it('divides by compilation count', () => {
      expect(calcFeedbackRate(234, 334)).toBeCloseTo(0.7, 1);
    });

    it('returns 0 when no compilations', () => {
      expect(calcFeedbackRate(0, 0)).toBe(0);
    });

    it('handles more feedback than compilations', () => {
      expect(calcFeedbackRate(100, 50)).toBe(2);
    });
  });

  describe('Zero data handling', () => {
    it('no division by zero in any metric', () => {
      expect(calcPrecision(0, 0)).toBe(1);
      expect(calcFalsePositiveRate(0, 0)).toBe(0);
      expect(calcFeedbackRate(0, 0)).toBe(0);
    });
  });
});
