import { describe, expect, it } from "vitest";
import {
  extractFirstIssueFromIssuesGetResponse,
  formatMantisNotePaperclipBody,
  normalizeMantisNotesFromIssuePayload,
} from "../src/mantis-http.js";

describe("Mantis issue notes (REST)", () => {
  it("unwraps issue from bugs[] envelope", () => {
    const payload = {
      bugs: [
        {
          id: 7,
          bugnotes: [{ id: 1, body: "via bugs", created_at: "2020-01-01T00:00:00Z", reporter: { name: "u" } }],
        },
      ],
    };
    const issue = extractFirstIssueFromIssuesGetResponse(payload);
    expect(issue?.id).toBe(7);
    const notes = normalizeMantisNotesFromIssuePayload(issue as Record<string, unknown>);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toBe("via bugs");
  });

  it("normalizes notes from a single-issue payload", () => {
    const issue = {
      id: 1,
      notes: [
        {
          id: 10,
          text: "First note",
          created_at: "2020-01-01T00:00:00Z",
          reporter: { name: "Alice" },
        },
        {
          id: 2,
          text: "Earlier",
          created_at: "2019-12-01T00:00:00Z",
          reporter: { name: "Bob" },
        },
      ],
    } as Record<string, unknown>;
    const notes = normalizeMantisNotesFromIssuePayload(issue);
    expect(notes).toHaveLength(2);
    expect(notes[0]!.id).toBe(2);
    expect(notes[0]!.reporterLabel).toBe("Bob");
    expect(notes[1]!.id).toBe(10);
  });

  it("reads Mantis bugnotes array (common REST shape)", () => {
    const issue = {
      id: 42,
      bugnotes: [
        {
          id: 9001,
          body: "Comment via bugnotes",
          created_at: "2022-01-01T00:00:00Z",
          reporter: { name: "qa" },
        },
      ],
    } as Record<string, unknown>;
    const notes = normalizeMantisNotesFromIssuePayload(issue);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(9001);
    expect(notes[0]!.text).toBe("Comment via bugnotes");
  });

  it("merges notes and bugnotes without duplicate ids", () => {
    const issue = {
      id: 1,
      notes: [{ id: 1, text: "A", created_at: "2020-01-01T00:00:00Z", reporter: { name: "a" } }],
      bugnotes: [{ id: 1, text: "A", created_at: "2020-01-01T00:00:00Z", reporter: { name: "a" } }],
    } as Record<string, unknown>;
    const notes = normalizeMantisNotesFromIssuePayload(issue);
    expect(notes).toHaveLength(1);
  });

  it("formats a Paperclip comment body with header and text", () => {
    const s = formatMantisNotePaperclipBody(
      {
        id: 5,
        text: "Hello",
        reporterLabel: "dev",
        createdAt: "2021-06-15T12:00:00Z",
      },
      "https://mantis.example.com",
      99,
    );
    expect(s).toContain("Mantis");
    expect(s).toContain("note #5");
    expect(s).toContain("_dev_");
    expect(s).toContain("Hello");
  });
});
