import { describe, expect, it } from "vitest";
import { effectiveStatusForMantisSync } from "../src/mantis-sync.js";
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
