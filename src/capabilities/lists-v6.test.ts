import { strict as assert } from "node:assert";

import { listV6Capabilities, projectListIndexResponse } from "./lists-v6.js";

const normal = {
  id: 1,
  name: "Normal project",
  color: null,
  sort: 0,
  created_by: null,
  category: { id: 3, key: "credit", name: "Lending" },
  category_id: 3,
  folder_id: 1,
  visibility: "open",
  project_count: 3,
  settings: { archived: false },
  external_system: "clickup",
  external_id: "clickup-1",
  members: [{ member_id: "member-1", display_name: "A member" }],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
} satisfies Parameters<typeof projectListIndexResponse>[0][number];

const lockedHidden = {
  ...normal,
  id: 2,
  name: "Locked project",
  locked: true,
  projects_hidden: true,
};

const lists = [normal, lockedHidden];

assert.deepEqual(projectListIndexResponse(lists), [
  {
    id: 1,
    name: "Normal project",
    category: normal.category,
    folder_id: 1,
    visibility: "open",
    project_count: 3,
  },
  {
    id: 2,
    name: "Locked project",
    category: normal.category,
    folder_id: 1,
    visibility: "open",
    project_count: 3,
    locked: true,
    projects_hidden: true,
  },
]);

assert.deepEqual(projectListIndexResponse(lists, false), lists);
assert.strictEqual(projectListIndexResponse(lists, false), lists);

const cap = listV6Capabilities.find((candidate) => candidate.name === "project_list_index_v6")!;
const rest = cap.expose.rest as Exclude<typeof cap.expose.rest, false>;
assert.deepEqual(rest[0].parse({ query: {} } as any), { compact: false });
assert.deepEqual(rest[0].parse({ query: { compact: "true" } } as any), { compact: true });
