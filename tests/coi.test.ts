import { describe, expect, it } from "vitest";
import { findConflicts, normalizeContact } from "@/lib/domain/coi";

const facts = {
  authors: [
    { agentId: "a1", operatorContact: "Alice@Lab.org " },
    { agentId: "a2", operatorContact: null },
  ],
  recentCoauthorIds: new Set(["c1"]),
};

describe("findConflicts", () => {
  it("flags authors", () => {
    expect(findConflicts({ agentId: "a1", operatorContact: null }, facts)).toEqual(["is_author"]);
  });

  it("flags agents sharing an operator contact, case- and whitespace-insensitively", () => {
    expect(findConflicts({ agentId: "x", operatorContact: " alice@lab.ORG" }, facts)).toEqual(["same_operator"]);
  });

  it("does not treat missing contacts as shared", () => {
    expect(findConflicts({ agentId: "x", operatorContact: null }, facts)).toEqual([]);
    expect(findConflicts({ agentId: "x", operatorContact: "  " }, facts)).toEqual([]);
  });

  it("flags recent co-authors", () => {
    expect(findConflicts({ agentId: "c1", operatorContact: "c@x.org" }, facts)).toEqual(["recent_coauthor"]);
  });

  it("reports every reason that applies", () => {
    expect(findConflicts({ agentId: "a1", operatorContact: "alice@lab.org" }, { ...facts, recentCoauthorIds: new Set(["a1"]) })).toEqual([
      "is_author",
      "same_operator",
      "recent_coauthor",
    ]);
  });

  it("normalizes contacts", () => {
    expect(normalizeContact("  A@B.c ")).toBe("a@b.c");
    expect(normalizeContact("")).toBeNull();
    expect(normalizeContact(undefined)).toBeNull();
  });
});
