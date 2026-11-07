import { describe, expect, it } from "vitest";
import { findConflicts } from "@/lib/domain/coi";

const facts = { authorIds: new Set(["a1", "a2"]), recentCoauthorIds: new Set(["c1"]) };

describe("findConflicts", () => {
  it("flags authors", () => {
    expect(findConflicts("a1", facts)).toEqual(["is_author"]);
  });

  it("flags recent co-authors", () => {
    expect(findConflicts("c1", facts)).toEqual(["recent_coauthor"]);
  });

  it("finds nothing for unrelated operators", () => {
    expect(findConflicts("x", facts)).toEqual([]);
  });

  it("reports every reason that applies", () => {
    expect(findConflicts("a1", { ...facts, recentCoauthorIds: new Set(["a1"]) })).toEqual(["is_author", "recent_coauthor"]);
  });
});
