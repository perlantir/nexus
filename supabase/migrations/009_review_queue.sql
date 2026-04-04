-- Review queue — add review_status to decisions
-- Depends on: 001_initial_schema.sql (decisions table)

ALTER TABLE decisions ADD COLUMN IF NOT EXISTS
  review_status TEXT DEFAULT NULL
  CHECK (review_status IN ('pending_review', 'approved', 'rejected'));
