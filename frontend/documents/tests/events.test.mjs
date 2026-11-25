import test from "node:test";
import assert from "node:assert/strict";
import { observe } from "../../shared/events.ts";

test("changes during a pending request trigger one follow-up; teardown ignores late responses", async () => {
  let socket;
  globalThis.location = new URL("http://localhost:8080/documents/");
  globalThis.WebSocket = class {
    constructor() {
      socket = this;
    }
    close() {}
  };
  const pending = [];
  const received = [];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const stop = observe(
    () => new Promise((resolve) => pending.push(resolve)),
    (value) => received.push(value),
    assert.fail,
    (event) => event.type === "updated",
  );
  try {
    await settle();
    for (let i = 0; i < 3; i++)
      socket.onmessage({ data: JSON.stringify({ type: "updated", id: "a" }) });
    assert.equal(pending.length, 1);
    pending[0]("first");
    await settle();
    assert.equal(pending.length, 2);
    stop();
    pending[1]("late");
    await settle();
    assert.deepEqual(received, ["first"]);
  } finally {
    stop();
    delete globalThis.WebSocket;
    delete globalThis.location;
  }
});
