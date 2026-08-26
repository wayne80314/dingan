import { describe, expect, it } from "vitest";
import { analyzeEvents } from "../src/report";
import type { MediaFetchRow, ProfileProbeRow, RawEventRow } from "../src/types";

import messageFixture from "./fixtures/message.json";
import messageNoUserIdFixture from "./fixtures/message-no-userid.json";
import postbackWithUserIdFixture from "./fixtures/postback-with-userid.json";
import postbackNoUserIdFixture from "./fixtures/postback-no-userid.json";
import messageEditedFixture from "./fixtures/message-edited.json";
import unsendFixture from "./fixtures/unsend.json";
import joinFixture from "./fixtures/join.json";
import leaveFixture from "./fixtures/leave.json";
import memberJoinedFixture from "./fixtures/member-joined.json";
import memberLeftFixture from "./fixtures/member-left.json";

let rowId = 0;

function toRow(event: Record<string, unknown>, overrides: Partial<RawEventRow> = {}): RawEventRow {
  rowId += 1;
  const source = event.source as { type?: string; groupId?: string; userId?: string } | undefined;
  const deliveryContext = event.deliveryContext as { isRedelivery?: boolean } | undefined;
  return {
    id: rowId,
    webhook_event_id: (event.webhookEventId as string) ?? null,
    received_at: Date.now(),
    line_timestamp: (event.timestamp as number) ?? null,
    source_type: source?.type ?? null,
    group_id: source?.groupId ?? null,
    user_id: source?.userId ?? null,
    event_type: (event.type as string) ?? null,
    is_redelivery: deliveryContext?.isRedelivery ? 1 : 0,
    raw_json: JSON.stringify(event),
    ...overrides,
  };
}

describe("analyzeEvents", () => {
  it("counts events by type", () => {
    const result = analyzeEvents({
      rawEvents: [toRow(messageFixture), toRow(postbackWithUserIdFixture), toRow(joinFixture)],
      mediaFetches: [],
      profileProbes: [],
    });
    expect(result.totalRawEvents).toBe(3);
    expect(result.eventTypeCounts.message).toBe(1);
    expect(result.eventTypeCounts.postback).toBe(1);
    expect(result.eventTypeCounts.join).toBe(1);
  });

  it("(1) buckets postback userId coverage by group+userId, separating present vs missing", () => {
    const result = analyzeEvents({
      rawEvents: [toRow(postbackWithUserIdFixture), toRow(postbackNoUserIdFixture)],
      mediaFetches: [],
      profileProbes: [],
    });
    expect(result.postbackUserIdCoverage.withUserId).toBe(1);
    expect(result.postbackUserIdCoverage.withoutUserId).toBe(1);
    const withUser = result.postbackUserIdCoverage.byGroupAndUserId.find(
      (b) => b.userId === "Ufixtureuser01",
    );
    expect(withUser?.count).toBe(1);
    const missing = result.postbackUserIdCoverage.byGroupAndUserId.find(
      (b) => b.userId === "(missing)",
    );
    expect(missing?.count).toBe(1);
  });

  it("(2) buckets message-action-style text message userId coverage the same way", () => {
    const result = analyzeEvents({
      rawEvents: [toRow(messageFixture), toRow(messageNoUserIdFixture)],
      mediaFetches: [],
      profileProbes: [],
    });
    expect(result.messageUserIdCoverage.withUserId).toBe(1);
    expect(result.messageUserIdCoverage.withoutUserId).toBe(1);
  });

  it("(3) summarizes structural event payloads including messageEdited and unsend", () => {
    const result = analyzeEvents({
      rawEvents: [
        toRow(joinFixture),
        toRow(leaveFixture),
        toRow(memberJoinedFixture),
        toRow(memberLeftFixture),
        toRow(messageEditedFixture),
        toRow(unsendFixture),
      ],
      mediaFetches: [],
      profileProbes: [],
    });
    const byType = Object.fromEntries(result.structuralEventSamples.map((s) => [s.eventType, s]));
    expect(byType.join.count).toBe(1);
    expect(byType.leave.count).toBe(1);
    expect(byType.memberJoined.count).toBe(1);
    expect(byType.memberLeft.count).toBe(1);
    expect(byType.messageEdited.count).toBe(1);
    expect(byType.unsend.count).toBe(1);
    expect((byType.messageEdited.samples[0] as { type: string }).type).toBe("messageEdited");
  });

  it("(4) computes media fetch success rate and per-mime breakdown", () => {
    const mediaFetches: MediaFetchRow[] = [
      { id: 1, message_id: "m1", webhook_event_id: "w1", mime: "image/jpeg", size_bytes: 100, success: 1, duration_ms: 50, error: null, fetched_at: Date.now() },
      { id: 2, message_id: "m2", webhook_event_id: "w2", mime: "image/jpeg", size_bytes: null, success: 0, duration_ms: 30, error: "HTTP 404", fetched_at: Date.now() },
      { id: 3, message_id: "m3", webhook_event_id: "w3", mime: "video/mp4", size_bytes: 5000, success: 1, duration_ms: 200, error: null, fetched_at: Date.now() },
    ];
    const result = analyzeEvents({ rawEvents: [], mediaFetches, profileProbes: [] });
    expect(result.media.total).toBe(3);
    expect(result.media.successCount).toBe(2);
    expect(result.media.successRate).toBeCloseTo(2 / 3);
    expect(result.media.byMime["image/jpeg"].count).toBe(2);
    expect(result.media.byMime["image/jpeg"].successCount).toBe(1);
  });

  it("(5) counts LINE-flagged redeliveries and detects out-of-order messageEdited timestamps", () => {
    const first = toRow(messageEditedFixture, { line_timestamp: 1000, id: 1 });
    // Second edit of the SAME message.id arrives with an earlier timestamp
    // than the first -- exactly the out-of-order case LINE's docs warn
    // about for messageEdited.
    const secondEditedRaw = { ...messageEditedFixture, webhookEventId: "01HFIXTUREEDITED000000002", timestamp: 500 };
    const second = toRow(secondEditedRaw, { line_timestamp: 500, id: 2 });
    const redelivered = toRow(messageFixture, { is_redelivery: 1, id: 3 });

    const result = analyzeEvents({
      rawEvents: [first, second, redelivered],
      mediaFetches: [],
      profileProbes: [],
    });

    expect(result.redelivery.redeliveryFlaggedCount).toBe(1);
    const entry = result.redelivery.messageEditedOutOfOrder.find((m) => m.messageId === "msgfixtureedit01");
    expect(entry?.eventCount).toBe(2);
    expect(entry?.isOutOfOrder).toBe(true);
  });

  it("(6) computes profile API success rate and flags observed displayName changes", () => {
    const profileProbes: ProfileProbeRow[] = [
      { id: 1, group_id: "Cfixturegroup01", user_id: "Ufixtureuser01", display_name: "小明", status_code: 200, success: 1, raw_response: "{}", probed_at: 1000 },
      { id: 2, group_id: "Cfixturegroup01", user_id: "Ufixtureuser01", display_name: "小明設計師", status_code: 200, success: 1, raw_response: "{}", probed_at: 2000 },
      { id: 3, group_id: "Cfixturegroup01", user_id: "Ufixtureuser99", display_name: null, status_code: 404, success: 0, raw_response: "not found", probed_at: 3000 },
    ];
    const result = analyzeEvents({ rawEvents: [], mediaFetches: [], profileProbes });
    expect(result.profileApi.total).toBe(3);
    expect(result.profileApi.successCount).toBe(2);
    expect(result.profileApi.byStatusCode["404"]).toBe(1);
    const change = result.profileApi.displayNameChanges.find((c) => c.userId === "Ufixtureuser01");
    expect(change?.observedDisplayNames).toEqual(["小明", "小明設計師"]);
  });
});
