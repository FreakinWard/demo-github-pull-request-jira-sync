#!/usr/bin/env node
/**
 * Keeps a Jira work item in step with the branch and pull request doing its work.
 *
 *   branch created                        → In Progress, assign, put in the active sprint
 *   opened / reopened / ready_for_review  → assign the author, put the item in the active sprint
 *   closed, merged                        → move every item the PR says it Closes to QA Ready
 *   closed, not merged                    → put the item back to In Progress
 *
 * Branch creation is where work actually starts; the pull request often follows days later, and
 * until it does the item sits in To Do looking untouched.
 *
 * An item is only moved to QA Ready when the pull request says so in as many words. Jira
 * attaches a pull request to an item whenever the key appears anywhere in it — description
 * included — so closing on "a linked PR merged" would close items from PRs that only mentioned
 * them.
 *
 * Nothing here throws on a missing person, sprint or key: the run reports what it skipped in the
 * job summary and exits 0, so a gap in the lookup table or a Jira outage never blocks a merge.
 */

import { appendFile, readFile } from "node:fs/promises";
import { closingKeys, keyFromBranch } from "./parse.js";

const BASE = process.env.JIRA_BASE_URL;
const EMAIL = process.env.JIRA_USER_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

const PROJECT = process.env.JIRA_PROJECT_KEY || "DEV";

// Status names differ per Jira workflow — override them with repository variables.
const STARTED_STATUS = process.env.JIRA_STARTED_STATUS || "In Progress";
const MERGED_STATUS = process.env.JIRA_MERGED_STATUS || "QA Ready";

/**
 * Work that has already been handed on. Neither a declined pull request nor a fresh branch cut
 * from a delivered item drags it back to In Progress — a follow-up branch off DEV-123 must not
 * make DEV-123 look unfinished again. Any status in Jira's "done" category also counts.
 */
const ALREADY_DELIVERED = new Set(
  (process.env.JIRA_DELIVERED_STATUSES || "QA Ready,QA Passed,Release Ready")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const notes = [];

function note(line) {
  console.log(line);
  notes.push(line);
}

async function jira(path, init = {}) {
  const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const error = new Error(
      `${init.method ?? "GET"} ${path} → ${response.status} ${await response.text()}`,
    );
    // Callers distinguish "that key does not exist" from a real outage.
    error.status = response.status;
    throw error;
  }

  return response.status === 204 ? null : response.json();
}

async function transitionTo(key, statusName) {
  // Many workflows allow a status to transition to itself, so without this check a second PR
  // closing the same item would leave a no-op entry in its history.
  const { fields } = await jira(`/rest/api/3/issue/${key}?fields=status`);

  if (fields.status.name === statusName) {
    note(`${key} is already ${statusName}`);
    return;
  }

  const { transitions } = await jira(`/rest/api/3/issue/${key}/transitions`);
  const target = transitions.find((t) => t.to.name === statusName);

  if (!target) {
    note(
      `⚠️ ${key}: no transition to "${statusName}" from its current status — left alone`,
    );
    return;
  }

  await jira(`/rest/api/3/issue/${key}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: target.id } }),
  });
  note(`${key} → ${statusName}`);
}

async function assignTo(key, login) {
  const map = JSON.parse(
    await readFile(new URL("../../.github/jira-users.json", import.meta.url)),
  );
  const accountId = map[login];

  if (!accountId) {
    note(
      `⚠️ no Jira account mapped for GitHub user "${login}" — ${key} left unassigned.`,
    );
    note(`   Add them to .github/jira-users.json.`);
    return;
  }

  await jira(`/rest/api/3/issue/${key}/assignee`, {
    method: "PUT",
    body: JSON.stringify({ accountId }),
  });
  note(`${key} assigned to ${login}`);
}

/** The Sprint field's id differs per site, so look it up rather than hard-coding it. */
async function sprintFieldId() {
  const fields = await jira("/rest/api/3/field");
  return fields.find((f) => f.name === "Sprint")?.id ?? null;
}

async function addToActiveSprint(key) {
  const project = key.split("-")[0];
  const { values: boards } = await jira(
    `/rest/agile/1.0/board?projectKeyOrId=${project}`,
  );
  const board = boards.find((b) => b.type === "scrum");

  if (!board) {
    note(`⚠️ ${project} has no scrum board — sprint left unset on ${key}`);
    return;
  }

  const { values: sprints } = await jira(
    `/rest/agile/1.0/board/${board.id}/sprint?state=active`,
  );

  if (sprints.length !== 1) {
    note(
      `⚠️ ${sprints.length} active sprints on board ${board.id} — sprint left unset on ${key}`,
    );
    return;
  }

  const [sprint] = sprints;
  const fieldId = await sprintFieldId();

  if (fieldId) {
    const issue = await jira(`/rest/api/3/issue/${key}?fields=${fieldId}`);
    const current = issue.fields[fieldId] ?? [];

    if (current.some((s) => s.id === sprint.id)) {
      note(`${key} already in sprint "${sprint.name}"`);
      return;
    }
  }

  await jira(`/rest/agile/1.0/sprint/${sprint.id}/issue`, {
    method: "POST",
    body: JSON.stringify({ issues: [key] }),
  });
  note(`${key} added to sprint "${sprint.name}"`);
}

/** The status name when the item has moved past development and must not be pulled back. */
async function alreadyDelivered(key) {
  const { fields } = await jira(`/rest/api/3/issue/${key}?fields=status`);
  const { status } = fields;

  if (
    status.statusCategory.key === "done" ||
    ALREADY_DELIVERED.has(status.name)
  ) {
    return status.name;
  }

  return null;
}

function noKey() {
  note(
    `Branch does not start with a ${PROJECT.toLowerCase()}-NNN key — nothing to sync.`,
  );
}

async function onBranchCreated(ref, login) {
  const key = keyFromBranch(ref, PROJECT);
  if (!key) return noKey();

  const delivered = await alreadyDelivered(key);

  if (delivered) {
    note(`${key} is "${delivered}" — a new branch will not reopen it.`);
  } else {
    await transitionTo(key, STARTED_STATUS);
  }

  await assignTo(key, login);
  await addToActiveSprint(key);
}

async function onOpened(pr) {
  const key = keyFromBranch(pr.head.ref, PROJECT);
  if (!key) return noKey();

  await assignTo(key, pr.user.login);
  await addToActiveSprint(key);
}

async function onMerged(pr) {
  const keys = closingKeys(pr.body);

  if (keys.length === 0) {
    note(`No "Closes ${PROJECT}-NNN" in the description — no work item moved.`);
    return;
  }

  // Each key is handled on its own: a description naming four items must not lose three of
  // them because the first does not exist.
  for (const key of keys) {
    try {
      await transitionTo(key, MERGED_STATUS);
    } catch (error) {
      note(
        error.status === 404
          ? `⚠️ ${key} does not exist — named in the description, so nothing was moved.`
          : `⚠️ ${key} not moved: ${error.message}`,
      );
    }
  }
}

async function onDeclined(pr) {
  const key = keyFromBranch(pr.head.ref, PROJECT);
  if (!key) return noKey();

  // A PR closed after a different one already delivered the work must not undo that.
  const delivered = await alreadyDelivered(key);

  if (delivered) {
    note(
      `${key} is "${delivered}" — a declined PR will not move it backwards.`,
    );
    return;
  }

  await transitionTo(key, STARTED_STATUS);
}

async function main() {
  if (!BASE || !EMAIL || !TOKEN) {
    note("⚠️ Jira credentials are not configured — skipping sync.");
    return;
  }

  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );

  // Which workflow called us is inferred from the payload rather than passed in, so the two
  // workflows stay identical apart from their trigger.
  if (event.pull_request) {
    const pr = event.pull_request;

    if (event.action === "closed") {
      await (pr.merged ? onMerged(pr) : onDeclined(pr));
    } else {
      await onOpened(pr);
    }

    return;
  }

  // A create event also fires for tags, which carry no work item.
  if (event.ref_type === "branch") {
    await onBranchCreated(event.ref, event.sender.login);
    return;
  }

  note(`Nothing to sync for a ${event.ref_type ?? "unrecognised"} event.`);
}

try {
  await main();
} catch (error) {
  // A Jira outage or a permissions change must not fail somebody's pull request.
  note(`⚠️ Jira sync failed: ${error.message}`);
} finally {
  if (process.env.GITHUB_STEP_SUMMARY && notes.length) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Jira\n\n${notes.join("\n")}\n`,
    );
  }
}
