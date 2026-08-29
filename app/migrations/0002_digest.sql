-- Daily meeting minutes.
--
-- A digest is a set of *candidates*, never a record. Nothing here can become a
-- decision or a confirmation on its own: the only path is a designer reading
-- it and choosing to turn an item into a decision card, which then goes
-- through the normal publish and confirmation flow.
--
-- Every claim carries the message ids it came from, so a reader can always
-- open the original conversation rather than taking the summary's word for it.

CREATE TABLE digest (
  id TEXT PRIMARY KEY,                 -- dig_...
  organization_id TEXT NOT NULL REFERENCES organization(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  line_group_id TEXT NOT NULL REFERENCES line_group(id),

  -- The day being summarised, as a date in the organization's timezone.
  -- Stored as text because that is how a person refers to it.
  digest_date TEXT NOT NULL,           -- 'YYYY-MM-DD'
  -- The window actually covered. A cursor rather than a calendar boundary, so
  -- a run that starts late or after downtime picks up where the last one
  -- finished instead of skipping the gap.
  covered_from INTEGER NOT NULL,
  covered_to INTEGER NOT NULL,

  message_count INTEGER NOT NULL,
  -- Set when the day's conversation exceeded what one request can summarise.
  -- Recorded so the interface can say so rather than silently presenting a
  -- partial summary as complete.
  segment_count INTEGER NOT NULL DEFAULT 1,
  truncated INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'reviewed', 'published', 'dismissed', 'failed')),

  -- What the model returned, kept verbatim alongside the edited version so an
  -- edit never destroys the evidence of what was generated.
  raw_json TEXT,
  summary_text TEXT,                   -- editable rendering shown to the designer
  edited_at INTEGER,
  edited_by TEXT,

  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT,

  published_at INTEGER,
  published_outbox_id TEXT,
  created_at INTEGER NOT NULL
);

-- One digest per group per day; a rerun updates rather than duplicates.
CREATE UNIQUE INDEX idx_digest_day ON digest(line_group_id, digest_date);
CREATE INDEX idx_digest_project ON digest(organization_id, project_id, digest_date DESC);

-- Individual candidates within a digest, so each can be cited, edited, or
-- promoted to a decision card independently.
CREATE TABLE digest_item (
  id TEXT PRIMARY KEY,                 -- dgi_...
  organization_id TEXT NOT NULL,
  digest_id TEXT NOT NULL REFERENCES digest(id),
  seq INTEGER NOT NULL,

  kind TEXT NOT NULL
    CHECK (kind IN ('decision', 'pending', 'cost', 'schedule', 'note')),
  title TEXT NOT NULL,
  detail TEXT,

  -- Only ever populated when the figure appears verbatim in a source message.
  -- A model must not infer an amount that nobody wrote down: on this product a
  -- fabricated number is the exact failure it exists to prevent.
  amount_inc_tax_cents INTEGER,
  amount_verbatim TEXT,                -- the text the figure was read from

  -- Message ids backing this item. Without them the claim is unverifiable and
  -- the interface says so.
  source_message_ids TEXT NOT NULL DEFAULT '[]',

  -- Set once a designer turns this into a decision card.
  promoted_decision_id TEXT REFERENCES decision(id),
  dismissed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_digest_item_digest ON digest_item(digest_id, seq);

-- Records that the group was told, before any of its conversation was sent
-- abroad for summarising. Generation checks this table, so the obligation is
-- enforced by the code rather than by remembering to do it.
CREATE TABLE consent_notice (
  line_group_id TEXT PRIMARY KEY REFERENCES line_group(id),
  -- Bumped when the wording changes materially, so an existing group is
  -- re-notified rather than silently covered by an older, narrower notice.
  notice_version INTEGER NOT NULL,
  sent_at INTEGER,
  outbox_id TEXT,
  created_at INTEGER NOT NULL
);
