-- Privacy: read receipts (receipts.rs). Off = others don't see when you read their DMs, and you don't see when they
-- read yours (delivered still shows).
ALTER TABLE users ADD COLUMN read_receipts BOOLEAN NOT NULL DEFAULT true;
