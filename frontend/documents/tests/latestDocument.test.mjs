import assert from "node:assert/strict";
import test from "node:test";
import { latestDocument } from "../src/latestDocument.ts";

test("late response for a different summary version cannot undo a newer revision", () => {
  const current = { id: "doc", summary_revision: 4, summary_version_id: "g2" };
  assert.equal(
    latestDocument(current, {
      ...current,
      summary_revision: 2,
      summary_version_id: "g1",
    }),
    current,
  );
});

test("explicit history selection at the current revision remains possible", () => {
  const current = { id: "doc", summary_revision: 4, summary_version_id: "g2" };
  const history = { ...current, summary_version_id: "g0" };
  assert.equal(latestDocument(current, history), history);
  assert.equal(
    latestDocument(current, { id: "other", summary_revision: 0 }).id,
    "other",
  );
});
