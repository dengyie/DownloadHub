CREATE TABLE cards_v1 (
 card_id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL,
 quota INTEGER NOT NULL CHECK(quota>=0), perm_group TEXT NOT NULL,
 prefixes TEXT NOT NULL, resources TEXT NOT NULL,
 expires_at_ms INTEGER, created_at_ms INTEGER NOT NULL,
 revoked INTEGER NOT NULL CHECK(revoked IN(0,1))
);
CREATE TABLE grants (
 id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE,
 card_id TEXT NOT NULL REFERENCES cards_v1(card_id), resource TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('ready','processing','issued','expired')),
 credential_expires_at INTEGER NOT NULL, claim_id TEXT NOT NULL DEFAULT '',
 lease_until INTEGER NOT NULL DEFAULT 0, issued_at INTEGER,
 expires_at INTEGER NOT NULL DEFAULT 0, result_url TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL
);
CREATE INDEX grants_expiry ON grants(credential_expires_at);
CREATE INDEX grants_result_expiry ON grants(expires_at) WHERE state='issued';
CREATE INDEX grants_card ON grants(card_id);
CREATE TABLE quota_events (
 grant_id TEXT PRIMARY KEY REFERENCES grants(id), card_id TEXT NOT NULL,
 delta INTEGER NOT NULL CHECK(delta=-1), committed_at INTEGER NOT NULL
);
