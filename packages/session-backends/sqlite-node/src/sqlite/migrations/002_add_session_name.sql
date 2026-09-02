-- Denormalize the latest 'name' fact onto sessions so readSessionRow and
-- readSessionRows no longer need a correlated subquery per row.
--
-- The trigger keeps the column current for new name facts.  It does NOT fire
-- on fact deletions, so the column may be stale after a name fact is removed —
-- callers that need a definitive answer should fall back to a direct fact lookup.

ALTER TABLE sessions ADD COLUMN session_name TEXT NULL;

-- Populate existing rows from the facts table.
-- facts.value is JSON-encoded (a string), so we decode it back to the raw name.
UPDATE sessions
SET session_name = (
    SELECT value
    FROM facts
    WHERE facts.session_id = sessions.id
      AND facts.kind = 'name'
      AND facts.key IS NULL
    ORDER BY facts.seq DESC
    LIMIT 1
)
WHERE EXISTS (
    SELECT 1 FROM facts
    WHERE facts.session_id = sessions.id
      AND facts.kind = 'name'
      AND facts.key IS NULL
);

CREATE TRIGGER IF NOT EXISTS trg_session_name_insert AFTER INSERT ON facts
WHEN NEW.kind = 'name' AND NEW.key IS NULL AND NEW.value IS NOT NULL
BEGIN
    UPDATE sessions SET session_name = NEW.value WHERE id = NEW.session_id;
END;
