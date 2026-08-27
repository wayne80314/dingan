-- 定案 M0.1 — initial schema.
--
-- Conventions, applied without exception (see docs/m0-plan.md §1):
--
--   * Primary keys are TEXT ULIDs with a type prefix, never AUTOINCREMENT,
--     so ids stay stable if the database is later split per organization.
--   * Every table carries organization_id even where it could be derived by
--     join. It is the shard key and the tenant boundary, and every query
--     filters on it first. Cross-organization joins are forbidden.
--   * Times are INTEGER epoch milliseconds, UTC.
--   * Money is INTEGER cents (1/100 TWD) and signed: an addition is positive,
--     a deduction negative. Quantities are quantity_milli (thousandths) so
--     nothing touches floating point.
--
-- Verified against real remote D1 during M0.0, not Miniflare:
--   * Foreign keys ARE enforced through the Worker binding, so the REFERENCES
--     clauses below are real constraints rather than documentation.
--   * Partial (filtered) unique indexes work, which is what lets line_group
--     keep historical rows while allowing only one live binding per group.
--   * db.batch() rolls back as a unit, so the publish path can write
--     snapshot + nonce + outbox atomically.

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE organization (
  id TEXT PRIMARY KEY,                 -- org_...
  name TEXT NOT NULL,
  tax_id TEXT,                         -- 統編, printed on invoicing exports
  -- LINE user ids are scoped to a provider. Recording which provider and
  -- channel produced them keeps historical audit records interpretable if the
  -- account is ever moved.
  line_provider_id TEXT NOT NULL,
  line_channel_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,                 -- prj_...
  organization_id TEXT NOT NULL REFERENCES organization(id),
  name TEXT NOT NULL,
  client_name TEXT,                    -- 業主稱謂, for display and exports
  site_address TEXT,
  contract_no TEXT,
  -- Baseline the additions and deductions are measured against.
  contract_amount_inc_tax_cents INTEGER,
  tax_mode TEXT NOT NULL DEFAULT 'exclusive'
    CHECK (tax_mode IN ('inclusive', 'exclusive', 'exempt', 'zero')),
  tax_rate_bp INTEGER NOT NULL DEFAULT 500,   -- basis points; 5% = 500
  -- Allocates D-001, D-002 ... Incremented inside the create transaction so a
  -- deleted draft never lets a number be reused: card numbers are printed on
  -- records people may rely on later.
  decision_seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  retention_until INTEGER,             -- personal-data retention horizon
  started_at INTEGER,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_project_org ON project(organization_id, status);

-- ---------------------------------------------------------------------------
-- LINE binding
-- ---------------------------------------------------------------------------

-- A LINE group is an endpoint a project is reachable at, not a tenant. One
-- project may bind several groups (owner group, crew group), and a group may
-- be rebound over time while history is kept.
CREATE TABLE line_group (
  id TEXT PRIMARY KEY,                 -- grp_...
  organization_id TEXT,                -- NULL until claimed
  project_id TEXT REFERENCES project(id),
  line_provider_id TEXT NOT NULL,
  line_channel_id TEXT NOT NULL,
  line_group_id TEXT NOT NULL,         -- C-prefixed
  -- LINE now delivers multi-person chats as groups (verified in F0: 28/28
  -- events arrived as source.type "group"). 'room' is kept only so a legacy
  -- source would still be storable rather than rejected.
  source_type TEXT NOT NULL DEFAULT 'group' CHECK (source_type IN ('group', 'room')),
  purpose TEXT NOT NULL DEFAULT 'owner' CHECK (purpose IN ('owner', 'crew', 'internal')),
  group_name_snapshot TEXT,
  member_count INTEGER,                -- from members/count; excludes the bot
  member_count_synced_at INTEGER,
  -- 'unclaimed' is a privacy gate as much as a workflow state: until someone
  -- claims the group into a project, message bodies are not persisted.
  status TEXT NOT NULL DEFAULT 'unclaimed'
    CHECK (status IN ('unclaimed', 'active', 'left', 'revoked')),
  -- Set when a postback is seen without a userId, so the group escalates to
  -- LIFF-backed confirmation instead of silently losing attribution.
  liff_required INTEGER NOT NULL DEFAULT 0,
  consent_notified_at INTEGER,         -- personal-data notice sent on join
  joined_at INTEGER,
  claimed_at INTEGER,
  claimed_by TEXT,
  left_at INTEGER
);
-- One live binding per LINE group, while historical rows remain queryable.
CREATE UNIQUE INDEX idx_line_group_live ON line_group(line_provider_id, line_group_id)
  WHERE status IN ('unclaimed', 'active');
CREATE INDEX idx_line_group_project ON line_group(project_id, status);

-- Who is in a group, and how confident we are about who they really are.
CREATE TABLE group_member (
  line_group_id TEXT NOT NULL REFERENCES line_group(id),
  line_user_id TEXT NOT NULL,
  organization_id TEXT,
  project_id TEXT,
  role TEXT NOT NULL DEFAULT 'unknown'
    CHECK (role IN ('owner', 'co_owner', 'designer', 'pm', 'crew', 'vendor', 'unknown')),
  declared_name TEXT,                  -- real name as registered in the dashboard
  display_name_last_seen TEXT,         -- LINE nickname; user-changeable
  display_name_synced_at INTEGER,
  -- 'whitelisted' is reserved for identity the person asserted themselves.
  -- A designer naming someone else is 'asserted' and must not be presented as
  -- equivalent -- exports render the two differently.
  identity_confidence TEXT NOT NULL DEFAULT 'seen_before'
    CHECK (identity_confidence IN ('whitelisted', 'asserted', 'seen_before', 'unknown')),
  whitelist_source TEXT
    CHECK (whitelist_source IN ('self_registered', 'designer_assigned', 'liff_login', NULL)),
  first_seen_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (line_group_id, line_user_id)
);
CREATE INDEX idx_group_member_project ON group_member(project_id, role);

-- ---------------------------------------------------------------------------
-- Decisions
-- ---------------------------------------------------------------------------

CREATE TABLE decision (
  id TEXT PRIMARY KEY,                 -- dec_...
  organization_id TEXT NOT NULL REFERENCES organization(id),
  project_id TEXT NOT NULL REFERENCES project(id),
  decision_no TEXT NOT NULL,           -- 'D-001', revision 'D-001-R1'
  -- Bumped on every publish. Confirmations point at (decision_id, version),
  -- so a re-published card never inherits an older version's approvals.
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  change_scope TEXT,
  change_reason TEXT,
  category TEXT
    CHECK (category IN ('design', 'material', 'sequence', 'other', NULL)),
  tax_mode TEXT NOT NULL DEFAULT 'exclusive'
    CHECK (tax_mode IN ('inclusive', 'exclusive', 'exempt', 'zero')),
  tax_rate_bp INTEGER NOT NULL DEFAULT 500,
  -- All three are stored rather than recomputed at export time, so a later
  -- change to rounding rules cannot retroactively alter a confirmed record.
  amount_ex_tax_cents INTEGER NOT NULL DEFAULT 0,
  amount_tax_cents INTEGER NOT NULL DEFAULT 0,
  amount_inc_tax_cents INTEGER NOT NULL DEFAULT 0,
  schedule_delta_days INTEGER NOT NULL DEFAULT 0,   -- signed; negative = earlier
  required_approval_count INTEGER NOT NULL DEFAULT 1,
  risk_level TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'high')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'confirmed', 'rejected',
                      'request_changes', 'expired', 'withdrawn')),
  line_group_id TEXT REFERENCES line_group(id),     -- where it was published
  source_line_message_ids TEXT,        -- JSON array of originating messages
  -- A confirmed decision is never edited; a correction is a new card that
  -- supersedes it, keeping the original and its approvals intact.
  supersedes_id TEXT REFERENCES decision(id),
  superseded_by_id TEXT REFERENCES decision(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  decided_at INTEGER,
  expires_at INTEGER
);
CREATE UNIQUE INDEX idx_decision_no ON decision(project_id, decision_no);
CREATE INDEX idx_decision_status ON decision(organization_id, project_id, status, created_at);
-- The supersede chain stays linear: a decision may be replaced once.
CREATE UNIQUE INDEX idx_decision_supersedes ON decision(supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Written once at publish, never updated. This is what a confirmation
-- attests to: recomputing the hash later would prove nothing about what the
-- client actually saw.
CREATE TABLE decision_snapshot (
  id TEXT PRIMARY KEY,                 -- snp_...
  organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decision(id),
  version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,        -- NFC-normalized, key-ordered
  content_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_snapshot_version ON decision_snapshot(decision_id, version);

CREATE TABLE decision_line_item (
  id TEXT PRIMARY KEY,                 -- itm_...
  organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decision(id),
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  area TEXT,                           -- 客廳 / 主臥 ...
  description TEXT NOT NULL,
  spec_note TEXT,
  unit TEXT NOT NULL,                  -- 式 / 坪 / 才 / 樘 ...
  quantity_milli INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  -- Rounded per line, then summed -- matching how quotations are read in the
  -- trade. Summing first and rounding once produces totals that do not
  -- reconcile against the printed line values.
  line_total_cents INTEGER NOT NULL
);
CREATE INDEX idx_line_item_decision ON decision_line_item(decision_id, version, seq);

-- ---------------------------------------------------------------------------
-- Confirmation
-- ---------------------------------------------------------------------------

-- Single-use token binding a tappable button to one decision version, one
-- action, and one group. Without it a forwarded card could be replayed
-- elsewhere and recorded as a confirmation.
CREATE TABLE decision_nonce (
  nonce TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decision(id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'request_changes')),
  bound_line_group_id TEXT NOT NULL,   -- LINE's C-id, compared to source.groupId
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,
  invalidated_at INTEGER
);
CREATE INDEX idx_nonce_decision ON decision_nonce(decision_id, version);

CREATE TABLE confirmation (
  id TEXT PRIMARY KEY,                 -- cfm_...
  organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES decision(id),
  version INTEGER NOT NULL,
  line_group_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'reject', 'request_changes')),
  channel TEXT NOT NULL CHECK (channel IN ('postback', 'message', 'liff', 'dashboard')),

  -- Nullable on purpose. Group postbacks carry source.userId in practice but
  -- LINE documents it as message-events-only, so an absent id is a case the
  -- product must survive visibly rather than a case that cannot happen.
  confirmed_by_user_id TEXT,
  identity_source TEXT NOT NULL
    CHECK (identity_source IN ('postback', 'postback_no_uid', 'message',
                               'member_profile', 'liff_id_token', 'dashboard')),
  identity_confidence TEXT NOT NULL
    CHECK (identity_confidence IN ('whitelisted', 'asserted', 'seen_before', 'unknown')),
  resolution_status TEXT NOT NULL DEFAULT 'resolved'
    CHECK (resolution_status IN ('resolved', 'unidentified', 'late', 'revoked', 'superseded')),

  -- Captured at confirmation time: display names change, and members who
  -- leave the group can no longer be looked up.
  display_name_snapshot TEXT,
  snapshot_source TEXT,
  declared_name TEXT,
  declared_role TEXT,

  confirm_text TEXT NOT NULL,          -- the exact wording presented/received
  content_sha256_at_confirm TEXT NOT NULL,   -- ties the act to a snapshot

  line_provider_id TEXT NOT NULL,
  line_channel_id TEXT NOT NULL,
  line_event_timestamp INTEGER,        -- LINE's clock
  server_received_at INTEGER NOT NULL, -- ours
  webhook_event_id TEXT,
  nonce_used TEXT,

  -- A confirmation nobody can see is indistinguishable from one that never
  -- happened, so receipt delivery is tracked and surfaced when it fails.
  receipt_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (receipt_status IN ('pending', 'sent', 'failed')),
  receipt_delivery TEXT CHECK (receipt_delivery IN ('reply', 'push_fallback', NULL)),
  receipt_sent_at INTEGER,

  created_at INTEGER NOT NULL
);
-- Redelivery of the same webhook event must not create a second vote.
CREATE UNIQUE INDEX idx_confirmation_event ON confirmation(webhook_event_id)
  WHERE webhook_event_id IS NOT NULL;
-- One vote per person per decision version. Changing a decision means the
-- designer issues a revision, not that a vote is overwritten.
CREATE UNIQUE INDEX idx_confirmation_vote
  ON confirmation(decision_id, version, confirmed_by_user_id)
  WHERE confirmed_by_user_id IS NOT NULL;
CREATE INDEX idx_confirmation_open
  ON confirmation(organization_id, resolution_status, receipt_status);

-- ---------------------------------------------------------------------------
-- Ingestion
-- ---------------------------------------------------------------------------

-- Every webhook event, recorded before anything is interpreted. The raw body
-- lives in R2; this row is the index and the processing state.
CREATE TABLE raw_event (
  webhook_event_id TEXT PRIMARY KEY,
  line_group_id TEXT,
  event_type TEXT,
  is_redelivery INTEGER NOT NULL DEFAULT 0,
  ingest_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (ingest_state IN ('pending', 'done', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  last_error TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_raw_event_sweep ON raw_event(ingest_state, next_attempt_at);

-- Per-event checkpoints so a retry resumes rather than redoing side effects.
CREATE TABLE event_step (
  webhook_event_id TEXT NOT NULL,
  step TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (webhook_event_id, step)
);

CREATE TABLE line_message (
  id TEXT PRIMARY KEY,                 -- msg_...
  organization_id TEXT,
  project_id TEXT,
  line_group_id TEXT NOT NULL,
  line_message_id TEXT NOT NULL,
  line_user_id TEXT,
  display_name_snapshot TEXT,
  role TEXT,
  message_type TEXT NOT NULL,
  text_content TEXT,
  r2_key TEXT,
  media_status TEXT CHECK (media_status IN ('pending', 'stored', 'failed', NULL)),
  media_sha256 TEXT,
  mime TEXT,
  size_bytes INTEGER,
  -- Passive monitor for the undocumented behaviour the product depends on.
  -- A drop below 100% is the earliest possible signal that LINE changed it.
  has_user_id INTEGER NOT NULL,
  line_timestamp INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  webhook_event_id TEXT,
  unsent_at INTEGER
);
CREATE UNIQUE INDEX idx_message_line_id ON line_message(line_message_id);
CREATE INDEX idx_message_group_time ON line_message(line_group_id, line_timestamp);

-- ---------------------------------------------------------------------------
-- Outbound
-- ---------------------------------------------------------------------------

-- Every outbound LINE message is written here first. A push that times out
-- leaves us unsure whether it arrived; retrying with the same retry_key is
-- safe because LINE answers 409 for a key it already accepted (verified in
-- M0.0) and returns the original message id.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,                 -- obx_...
  organization_id TEXT,
  project_id TEXT,
  line_group_id TEXT NOT NULL,         -- LINE's C-id (push target)
  kind TEXT NOT NULL,                  -- decision_card | receipt | notice ...
  priority INTEGER NOT NULL DEFAULT 1,
  -- Application-level identity of the send, so the same logical message is
  -- never enqueued twice.
  dedupe_key TEXT NOT NULL UNIQUE,
  retry_key TEXT NOT NULL,             -- X-Line-Retry-Key (UUID)
  payload_json TEXT NOT NULL,
  recipient_count INTEGER NOT NULL,    -- billing is per recipient
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sent', 'failed', 'uncertain')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_status_code INTEGER,
  last_error TEXT,
  sent_line_message_id TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX idx_outbox_dispatch ON outbox(state, next_attempt_at, priority);

-- Usage is recorded once, keyed by the outbox row, so replaying a dispatch
-- cannot double-count. Quota is charged per recipient, not per API call.
CREATE TABLE usage_ledger (
  outbox_id TEXT PRIMARY KEY REFERENCES outbox(id),
  organization_id TEXT,
  ym TEXT NOT NULL,                    -- 'YYYY-MM' in the org's timezone
  units INTEGER NOT NULL,
  kind TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_org_month ON usage_ledger(organization_id, ym);

-- ---------------------------------------------------------------------------
-- Diagnostics
-- ---------------------------------------------------------------------------

-- Anything rejected before it could be understood -- a bad signature, an
-- unparseable body. Kept because a silent drop here is indistinguishable
-- from an outage.
CREATE TABLE dead_letter (
  id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  detail TEXT,
  raw_sha256 TEXT,
  r2_key TEXT,
  status_code INTEGER,
  created_at INTEGER NOT NULL
);

-- Append-only trail. Chain roots are computed daily by a single writer
-- rather than linked on write, which would serialize concurrent approvals.
CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  event_type TEXT NOT NULL,
  decision_id TEXT,
  confirmation_id TEXT,
  actor TEXT,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_org_time ON audit_event(organization_id, created_at);
