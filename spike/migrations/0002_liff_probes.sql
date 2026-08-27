-- M0.0 (a): does a LINE Login ID token's `sub` equal the messaging-API
-- `userId` for the same person, when both channels sit under one provider?
-- The answer decides whether LIFF can serve as the fallback for recovering
-- identity when a postback arrives without a userId.
--
-- Stores decoded ID-token claims only. The raw token is a credential and is
-- never written here.

CREATE TABLE liff_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT,                  -- subject claim = the Login channel's user id
  aud TEXT,                  -- audience = Login channel id
  iss TEXT,
  token_exp INTEGER,
  name_claim TEXT,           -- display name, when the profile scope is granted
  verified_by_line INTEGER,  -- 1 = LINE's verify endpoint accepted the token
  verify_status INTEGER,
  verify_error TEXT,
  matched_known_user_id TEXT,-- which known messaging userId this sub equals, if any
  user_agent TEXT,
  probed_at INTEGER NOT NULL
);

CREATE INDEX idx_liff_probes_sub ON liff_probes(sub);
