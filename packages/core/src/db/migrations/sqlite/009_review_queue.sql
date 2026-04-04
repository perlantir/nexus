-- Review queue — SQLite edition
-- Add review_status column to decisions

ALTER TABLE decisions ADD COLUMN review_status TEXT DEFAULT NULL;
