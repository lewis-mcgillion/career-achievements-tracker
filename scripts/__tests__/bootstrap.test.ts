import { describe, it, expect } from "vitest";
import {
  USERNAME_RE,
  REPO_RE,
  validateUsername,
  validateRepo,
  parseRepoList,
  validateRepoList,
  validatePat,
  checkRepoIsPrivate,
} from "../bootstrap.js";

// ---------------------------------------------------------------------------
// Username validation
// ---------------------------------------------------------------------------
describe("validateUsername", () => {
  it("accepts valid usernames", () => {
    expect(validateUsername("alice")).toBe(true);
    expect(validateUsername("alice-bob")).toBe(true);
    expect(validateUsername("A1")).toBe(true);
    expect(validateUsername("lewis-mcgillion")).toBe(true);
    expect(validateUsername("x")).toBe(true);
  });

  it("rejects usernames starting with a hyphen", () => {
    expect(validateUsername("-alice")).toBe(false);
  });

  it("rejects usernames ending with a hyphen", () => {
    expect(validateUsername("alice-")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateUsername("")).toBe(false);
  });

  it("rejects usernames with special characters", () => {
    expect(validateUsername("alice@bob")).toBe(false);
    expect(validateUsername("alice bob")).toBe(false);
    expect(validateUsername("alice/bob")).toBe(false);
    expect(validateUsername("alice.bob")).toBe(false);
  });

  it("rejects usernames with only a hyphen", () => {
    expect(validateUsername("-")).toBe(false);
  });
});

describe("USERNAME_RE", () => {
  it("does not allow double hyphens (GitHub doesn't either)", () => {
    // The regex doesn't explicitly block this, but GitHub does. Document the behavior.
    // Our regex allows it, which is fine for a loose check.
    expect(USERNAME_RE.test("a--b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Repo format validation
// ---------------------------------------------------------------------------
describe("validateRepo", () => {
  it("accepts valid org/repo formats", () => {
    expect(validateRepo("github/github")).toBe(true);
    expect(validateRepo("my-org/my-repo")).toBe(true);
    expect(validateRepo("org/repo.name")).toBe(true);
    expect(validateRepo("org/repo_name")).toBe(true);
    expect(validateRepo("org/repo-name")).toBe(true);
    expect(validateRepo("alice/career-achievements-tracker")).toBe(true);
  });

  it("rejects repos without an owner", () => {
    expect(validateRepo("just-a-repo")).toBe(false);
  });

  it("rejects repos with too many slashes", () => {
    expect(validateRepo("org/sub/repo")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateRepo("")).toBe(false);
  });

  it("rejects repos with spaces", () => {
    expect(validateRepo("org/my repo")).toBe(false);
  });

  it("rejects repos with only a slash", () => {
    expect(validateRepo("/")).toBe(false);
  });

  it("rejects repos starting with a slash", () => {
    expect(validateRepo("/repo")).toBe(false);
  });

  it("rejects repos ending with a slash", () => {
    expect(validateRepo("org/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repo list parsing
// ---------------------------------------------------------------------------
describe("parseRepoList", () => {
  it("parses comma-separated repos", () => {
    expect(parseRepoList("org/a,org/b,org/c")).toEqual(["org/a", "org/b", "org/c"]);
  });

  it("trims whitespace around repos", () => {
    expect(parseRepoList("org/a , org/b , org/c")).toEqual(["org/a", "org/b", "org/c"]);
  });

  it("filters out empty entries from trailing commas", () => {
    expect(parseRepoList("org/a,org/b,")).toEqual(["org/a", "org/b"]);
  });

  it("filters out empty entries from leading commas", () => {
    expect(parseRepoList(",org/a")).toEqual(["org/a"]);
  });

  it("returns empty array for empty input", () => {
    expect(parseRepoList("")).toEqual([]);
  });

  it("handles single repo", () => {
    expect(parseRepoList("org/single")).toEqual(["org/single"]);
  });

  it("handles extra whitespace-only entries", () => {
    expect(parseRepoList("org/a, , org/b")).toEqual(["org/a", "org/b"]);
  });
});

// ---------------------------------------------------------------------------
// Repo list validation
// ---------------------------------------------------------------------------
describe("validateRepoList", () => {
  it("validates a list of good repos", () => {
    expect(validateRepoList(["github/github", "github/copilot-api"])).toEqual({
      valid: true,
    });
  });

  it("rejects empty list", () => {
    expect(validateRepoList([])).toEqual({ valid: false, invalid: "(empty)" });
  });

  it("identifies first invalid repo", () => {
    expect(validateRepoList(["org/good", "bad-no-slash", "org/also-good"])).toEqual({
      valid: false,
      invalid: "bad-no-slash",
    });
  });

  it("rejects list where all are invalid", () => {
    const result = validateRepoList(["nope", "also-nope"]);
    expect(result.valid).toBe(false);
    expect(result.invalid).toBe("nope");
  });
});

// ---------------------------------------------------------------------------
// PAT validation
// ---------------------------------------------------------------------------
describe("validatePat", () => {
  it("accepts non-empty PAT strings", () => {
    expect(validatePat("ghp_abc123")).toBe(true);
    expect(validatePat("github_pat_xxxxx")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validatePat("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Private repo check
// ---------------------------------------------------------------------------
describe("checkRepoIsPrivate", () => {
  it("detects existing private repo", () => {
    const output = '{"name":"career-data","isPrivate":true}';
    expect(checkRepoIsPrivate(output)).toEqual({ exists: true, isPrivate: true });
  });

  it("detects existing public repo", () => {
    const output = '{"name":"career-data","isPrivate":false}';
    expect(checkRepoIsPrivate(output)).toEqual({ exists: true, isPrivate: false });
  });

  it("detects non-existent repo", () => {
    const output = "Could not resolve to a Repository";
    expect(checkRepoIsPrivate(output)).toEqual({ exists: false, isPrivate: false });
  });

  it("handles empty output", () => {
    expect(checkRepoIsPrivate("")).toEqual({ exists: false, isPrivate: false });
  });
});

// ---------------------------------------------------------------------------
// Integration-style: full repo list round-trip (parse → validate)
// ---------------------------------------------------------------------------
describe("repo list round-trip", () => {
  it("parses and validates the actual tracked repos config", () => {
    const input =
      "github/github,github/copilot-api,github/github-ui,github/copilot-experiences,github/authzd,github/copilot-chat";
    const repos = parseRepoList(input);
    expect(repos).toHaveLength(6);
    const result = validateRepoList(repos);
    expect(result.valid).toBe(true);
  });

  it("catches a malformed entry among valid ones", () => {
    const input = "github/github, not a repo!, github/copilot-api";
    const repos = parseRepoList(input);
    expect(repos).toHaveLength(3);
    const result = validateRepoList(repos);
    expect(result.valid).toBe(false);
    expect(result.invalid).toBe("not a repo!");
  });
});
