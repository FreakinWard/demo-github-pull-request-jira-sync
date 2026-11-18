/**
 * The pure half of the sync: reading work item keys out of a branch name and a PR description.
 * No network, no environment — kept apart from sync.js so it can be tested with `node --test`.
 */

// Case-insensitive throughout: branches are named dev-288-…, so "Closes dev-288" is what people
// will actually type. Keys are uppercased before they reach the Jira REST API.
const ISSUE_KEY = /[A-Z][A-Z0-9]+-\d+/gi;
const CLOSING =
  /\b(?:closes|closed|fixes|fixed|resolves|resolved)\s+((?:[A-Z][A-Z0-9]+-\d+[\s,]*)+)/gi;

/**
 * The work item a branch is for, read from the front of its name:
 * dev-288-ci-jira-automation → DEV-288.
 *
 * Only the branch. A PR title is a conventional-commit subject and carries no key, and a key in
 * the description is usually a reference to somebody else's item, not this PR's subject.
 */
export function keyFromBranch(ref, project) {
  const key = ref.match(new RegExp(`^(${project}-\\d{1,6})-`, "i"));
  return key ? key[1].toUpperCase() : null;
}

/**
 * The description with code spans and fenced blocks blanked out.
 *
 * A PR that documents this convention writes "Closes DEV-123" as an example, and without this
 * it would close DEV-123 for real. Code formatting is the one signal available for "quoting,
 * not saying".
 */
export function prose(body) {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

/**
 * Every work item the description explicitly declares this PR closes.
 *
 * Naming a key anywhere else attaches the PR to that item in Jira but must not move it — a PR
 * that says "unrelated to DEV-275" is attached to DEV-275 by Jira, and must not close it.
 */
export function closingKeys(body) {
  const keys = new Set();

  for (const [, run] of prose(body ?? "").matchAll(CLOSING)) {
    for (const key of run.match(ISSUE_KEY) ?? []) keys.add(key.toUpperCase());
  }

  return [...keys];
}
