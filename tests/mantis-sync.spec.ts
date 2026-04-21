import { describe, expect, it } from "vitest";
import {
  effectiveStatusForMantisSync,
  isMantisReopenTransition,
  resolveTargetStatusAfterDonePush,
  resolveExistingIssueStatusForMantisSync,
} from "../src/mantis-sync.js";
import { mapMantisStatusToPaperclip } from "../src/mantis-http.js";

describe("effectiveStatusForMantisSync", () => {
  it("keeps in_progress when a default assignee agent is configured", () => {
    expect(
      effectiveStatusForMantisSync(
        { defaultAssigneeAgentId: "00000000-0000-4000-8000-000000000001" },
        "in_progress",
      ),
    ).toBe("in_progress");
  });

  it("downgrades in_progress to todo when no default assignee (Paperclip server rule)", () => {
    expect(effectiveStatusForMantisSync({}, "in_progress")).toBe("todo");
  });

  it("does not change non in_progress statuses", () => {
    expect(effectiveStatusForMantisSync({}, "backlog")).toBe("backlog");
  });
});

describe("mapMantisStatusToPaperclip", () => {
  it("maps acknowledged/confirmed pre-triage statuses to backlog", () => {
    expect(mapMantisStatusToPaperclip("acknowledged")).toBe("backlog");
    expect(mapMantisStatusToPaperclip("confirmed")).toBe("backlog");
  });
});

describe("resolveExistingIssueStatusForMantisSync", () => {
  it("keeps only in-flight/review Paperclip status when Mantis is still assigned/in progress", () => {
    expect(resolveExistingIssueStatusForMantisSync(
      { defaultPaperclipStatus: "todo" },
      "in_review",
      "in_progress",
    )).toBe("in_review");
    expect(resolveExistingIssueStatusForMantisSync(
      {
        defaultPaperclipStatus: "todo",
        defaultAssigneeAgentId: "00000000-0000-4000-8000-000000000001",
      },
      "in_progress",
      "in_progress",
    )).toBe("in_progress");
  });

  it("applies Mantis mapped status when issue is not actively being handled", () => {
    expect(resolveExistingIssueStatusForMantisSync(
      { defaultPaperclipStatus: "todo" },
      "todo",
      "in_progress",
    )).toBe("todo");
    expect(resolveExistingIssueStatusForMantisSync(
      { defaultPaperclipStatus: "todo" },
      "done",
      "in_progress",
    )).toBe("todo");
    expect(resolveExistingIssueStatusForMantisSync(
      { defaultPaperclipStatus: "todo" },
      "blocked",
      "in_progress",
    )).toBe("todo");
    expect(resolveExistingIssueStatusForMantisSync({}, "todo", "done")).toBe("done");
  });
});

describe("resolveTargetStatusAfterDonePush", () => {
  it("keeps done when done->fixed push succeeded in same sync cycle", () => {
    expect(resolveTargetStatusAfterDonePush(
      { defaultPaperclipStatus: "todo" },
      "done",
      "todo",
      true,
    )).toBe("done");
    expect(resolveTargetStatusAfterDonePush(
      { defaultPaperclipStatus: "todo" },
      "done",
      "in_progress",
      true,
    )).toBe("done");
  });

  it("falls back to normal status mapping when no done->fixed push happened", () => {
    expect(resolveTargetStatusAfterDonePush(
      { defaultPaperclipStatus: "todo" },
      "done",
      "in_progress",
      false,
    )).toBe("todo");
  });

  it("moves done back to todo when Mantis reopen-to-assigned is detected", () => {
    expect(resolveTargetStatusAfterDonePush(
      { defaultPaperclipStatus: "todo" },
      "done",
      "in_progress",
      true,
      true,
    )).toBe("todo");
    expect(resolveTargetStatusAfterDonePush(
      {},
      "done",
      "done",
      false,
      true,
    )).toBe("todo");
  });
});

describe("isMantisReopenTransition", () => {
  it("detects fixed -> assigned transitions only", () => {
    expect(isMantisReopenTransition("fixed", "assigned")).toBe(true);
    expect(isMantisReopenTransition(" fixed ", " assigned ")).toBe(true);
    expect(isMantisReopenTransition("resolved", "assigned")).toBe(false);
    expect(isMantisReopenTransition("fixed", "new")).toBe(false);
    expect(isMantisReopenTransition(undefined, "assigned")).toBe(false);
  });
});
