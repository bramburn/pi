-- Replace the session_name trigger from 002 so it also fires on the clearing
-- case. The original trigger only handled the value-IS-NOT-NULL branch, so
-- `setName(undefined)` (which inserts a name fact with value=NULL) left the
-- denormalised `sessions.session_name` column stale. After this migration the
-- trigger fires for any name fact insert: sets the column to the new value
-- when present, or to NULL when the user is clearing the name.

DROP TRIGGER IF EXISTS trg_session_name_insert;

CREATE TRIGGER IF NOT EXISTS trg_session_name_insert AFTER INSERT ON facts
WHEN NEW.kind = 'name' AND NEW.key IS NULL
BEGIN
    UPDATE sessions SET session_name = NEW.value WHERE id = NEW.session_id;
END;
