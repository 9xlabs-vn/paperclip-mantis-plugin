import { describe, expect, it } from "vitest";
import {
  mergeMantisPluginConfig,
  normalizeMantisPluginConfig,
  type MantisConnectorPluginConfig,
} from "../src/mantis-config.js";

describe("mergeMantisPluginConfig companyAdvancedSync", () => {
  it("removes defaultPaperclipStatus when patch sets null (clear From Mantis vs backlog)", () => {
    const prev = normalizeMantisPluginConfig({
      companyAdvancedSync: {
        co1: { defaultPaperclipStatus: "backlog", syncAssigneeFilter: "any" },
      },
    });
    const merged = mergeMantisPluginConfig(
      prev,
      {
        companyAdvancedSync: {
          co1: { syncAssigneeFilter: "any", defaultPaperclipStatus: null },
        },
      } as unknown as MantisConnectorPluginConfig,
    );
    expect(merged.companyAdvancedSync?.co1?.defaultPaperclipStatus).toBeUndefined();
  });

  it("removes defaultPaperclipStatus when patch sends empty string for optional fields", () => {
    const prev = normalizeMantisPluginConfig({
      companyAdvancedSync: {
        co1: { defaultPaperclipStatus: "backlog" },
      },
    });
    const patch = {
      companyAdvancedSync: {
        co1: {
          defaultPaperclipStatus: "",
        },
      },
    };
    const merged = mergeMantisPluginConfig(prev, patch as MantisConnectorPluginConfig);
    expect(merged.companyAdvancedSync?.co1?.defaultPaperclipStatus).toBeUndefined();
  });

  it("keeps existing status when patch only updates other advanced fields", () => {
    const prev = normalizeMantisPluginConfig({
      companyAdvancedSync: {
        co1: { defaultPaperclipStatus: "backlog", syncAssigneeFilter: "any" },
      },
    });
    const patch: MantisConnectorPluginConfig = {
      companyAdvancedSync: {
        co1: {
          syncOnlyOpenIssues: true,
        },
      },
    };
    const merged = mergeMantisPluginConfig(prev, patch);
    expect(merged.companyAdvancedSync?.co1?.defaultPaperclipStatus).toBe("backlog");
    expect(merged.companyAdvancedSync?.co1?.syncOnlyOpenIssues).toBe(true);
  });
});
