export type WorkspaceEvent = {
  type: "sync" | "created" | "updated" | "deleted";
  id?: string;
  state?: string;
};
type Listener = (event: WorkspaceEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let delay = 500;

function connect() {
  if (!listeners.size || socket || reconnect !== undefined) return;
  const url = new URL("/api/events", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  socket = ws;
  ws.onmessage = ({ data }) => {
    if (socket !== ws) return;
    const event: WorkspaceEvent = JSON.parse(data);
    if (event.type === "sync") delay = 500;
    for (const listener of listeners) listener(event);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = undefined;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 10000);
  };
}
export function subscribeEvents(listener: Listener) {
  listeners.add(listener);
  queueMicrotask(connect);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearTimeout(reconnect);
    reconnect = undefined;
    const previous = socket;
    socket = undefined;
    previous?.close();
    delay = 500;
  };
}

// Coalesce invalidations during a fetch, then read the newest snapshot once.
export function observe<T>(
  load: (signal: AbortSignal) => Promise<T>,
  receive: (data: T) => void,
  fail: (error: unknown) => void,
  accepts: (event: WorkspaceEvent) => boolean,
) {
  const controller = new AbortController();
  let running = false,
    dirty = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  async function refresh() {
    if (controller.signal.aborted) return;
    clearTimeout(retry);
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      const result = await load(controller.signal);
      if (!controller.signal.aborted) {
        receive(result);
        retryDelay = 1000;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        fail(error);
        if (!(error instanceof MissingDocument)) {
          retry = setTimeout(refresh, retryDelay);
          retryDelay = Math.min(30000, retryDelay * 2);
        }
      }
    } finally {
      running = false;
      if (dirty) {
        dirty = false;
        queueMicrotask(refresh);
      }
    }
  }
  const off = subscribeEvents((event) => {
    if (accepts(event)) void refresh();
  });
  queueMicrotask(refresh);
  return () => {
    off();
    clearTimeout(retry);
    controller.abort();
  };
}
export class MissingDocument extends Error {}
