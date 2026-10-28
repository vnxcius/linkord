-- Forwarded messages, like Discord's: a copy of the original's content, attachments and embeds plus where it
-- came from (models::Forwarded). The copy stays when the original is edited or deleted; attachment files are
-- shared and only removed once no message uses them (uploads::delete_attachment).
ALTER TABLE messages ADD COLUMN forwarded JSONB;
CREATE INDEX messages_forwarded ON messages(id) WHERE forwarded IS NOT NULL;
