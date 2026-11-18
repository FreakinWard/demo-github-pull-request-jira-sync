import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closingKeys, keyFromBranch } from "./parse.js";

describe("keyFromBranch", () => {
  const theories = [
    ["dev-288-ci-jira-automation", "DEV-288"],
    ["DEV-288-ci-jira-automation", "DEV-288"],
    ["chore-bump-deps", null],
    ["dependabot/npm_and_yarn/next-16.0.1", null],
    ["feature/dev-288-not-at-the-front", null],
    ["ops-12-other-project", null],
  ];

  for (const [branch, expected] of theories) {
    it(`reads ${expected} from ${branch}`, () => {
      assert.equal(keyFromBranch(branch, "DEV"), expected);
    });
  }
});

describe("closingKeys", () => {
  const theories = [
    ["Closes DEV-123", ["DEV-123"]],
    ["closes dev-123", ["DEV-123"]],
    ["Fixes DEV-1, DEV-2 and resolves DEV-3", ["DEV-1", "DEV-2", "DEV-3"]],
    ["Related to DEV-456", []],
    ["Example: `Closes DEV-123`", []],
    ["```\nCloses DEV-123\n```", []],
    ["", []],
  ];

  for (const [body, expected] of theories) {
    it(`reads ${JSON.stringify(expected)} from ${JSON.stringify(body)}`, () => {
      assert.deepEqual(closingKeys(body), expected);
    });
  }

  it("reads nothing from a missing description", () => {
    assert.deepEqual(closingKeys(null), []);
  });
});
