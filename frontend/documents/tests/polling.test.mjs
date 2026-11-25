import assert from "node:assert/strict";
import test from "node:test";
import { poll, latestDocument } from "../src/polling.ts";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("slow requests never overlap and are scheduled only after completion", async () => {
  const first = deferred();
  let requests = 0,
    next;
  const seen = [];
  const stop = poll(
    () => {
      requests++;
      return first.promise;
    },
    (value) => seen.push(value),
    assert.fail,
    2000,
    (callback) => {
      next = callback;
      return () => {
        next = undefined;
      };
    },
  );
  assert.equal(requests, 1);
  assert.equal(next, undefined);
  first.resolve("ready");
  await settle();
  assert.deepEqual(seen, ["ready"]);
  assert.equal(requests, 1);
  next();
  assert.equal(requests, 2);
  stop();
  await settle();
  assert.deepEqual(seen, ["ready"]);
});

for (const rejected of [false, true]) {
  test(`cancelled selection suppresses a late ${rejected ? "error" : "response"}`, async () => {
    const request = deferred();
    let signal;
    const stop = poll(
      (s) => {
        signal = s;
        return request.promise;
      },
      assert.fail,
      assert.fail,
      1,
      assert.fail,
    );
    stop();
    assert.equal(signal.aborted, true);
    if (rejected) request.reject(new Error("late"));
    else request.resolve("old document");
    await settle();
  });
}

test("failed requests report an error and schedule a retry", async () => {
  let next, failure;
  const stop = poll(
    async () => {
      throw new Error("offline");
    },
    assert.fail,
    (error) => {
      failure = error;
    },
    1,
    (callback) => {
      next = callback;
      return () => {};
    },
  );
  await settle();
  assert.equal(failure.message, "offline");
  assert.equal(typeof next, "function");
  stop();
});

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
