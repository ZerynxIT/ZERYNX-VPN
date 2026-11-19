import { connect } from "cloudflare:sockets";
import { active } from "./subscriptions.js";
import { parseHeader, charge } from "./wire.js";
export function transport(req, env) {
  if (
    req.method !== "GET" ||
    req.headers.get("Upgrade")?.toLowerCase() !== "websocket"
  )
    return new Response(null, { status: 426 });
  if (req.headers.has("Sec-WebSocket-Protocol"))
    return new Response("Early data is not supported", { status: 400 });
  const pair = new WebSocketPair(),
    [client, ws] = Object.values(pair);
  ws.accept();
  ws.binaryType = "arraybuffer";
  let socket,
    writer,
    id,
    closed = false,
    pending = Promise.resolve(),
    queued = 0,
    timer,
    accountTimer;
  function stop() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(accountTimer);
    try {
      ws.close(1000, "closed");
    } catch {}
    if (socket) socket.close().catch(() => {});
  }
  const timeout = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(stop, Math.min(2147483647, Math.max(1, ms)));
  };
  timeout(8000);
  async function downstream() {
    try {
      const reader = socket.readable.getReader();
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        await charge(env.DB, id, value.byteLength);
        if (closed) break;
        ws.send(value);
      }
    } finally {
      stop();
    }
  }
  let partial = new Uint8Array();
  async function consume(bytes) {
    if (closed) return;
    if (!writer) {
      if (partial.length) {
        const merged = new Uint8Array(partial.length + bytes.length);
        merged.set(partial);
        merged.set(bytes, partial.length);
        bytes = merged;
      }
      const head = parseHeader(bytes);
      if (!head) {
        partial = bytes;
        return;
      }
      partial = new Uint8Array();
      id = head.id;
      const get = () =>
        env.DB.prepare(
          "SELECT status,quota_bytes,used_bytes,expires_at FROM users WHERE id=?",
        )
          .bind(id)
          .first();
      const u = await get();
      if (!active(u) || closed) throw Error("inactive");
      timeout(Math.min(Date.parse(u.expires_at) - Date.now(), 3600000));
      accountTimer = setInterval(
        () =>
          get()
            .then((v) => {
              if (!active(v)) stop();
            })
            .catch(stop),
        30000,
      );
      socket = connect({ hostname: head.host, port: head.port });
      await socket.opened;
      if (closed) return;
      writer = socket.writable.getWriter();
      ws.send(new Uint8Array([0, 0]));
      downstream().catch(stop);
      bytes = bytes.subarray(head.offset);
    }
    if (bytes.length && !closed) {
      await charge(env.DB, id, bytes.length);
      if (!closed) await writer.write(bytes);
    }
  }
  ws.addEventListener("message", (e) => {
    if (closed) return;
    if (
      !(e.data instanceof ArrayBuffer) ||
      !e.data.byteLength ||
      e.data.byteLength > 1048576 ||
      queued + e.data.byteLength > 2097152
    ) {
      stop();
      return;
    }
    const bytes = new Uint8Array(e.data);
    queued += bytes.length;
    pending = pending
      .then(() => consume(bytes))
      .catch(stop)
      .finally(() => {
        queued -= bytes.length;
      });
  });
  ws.addEventListener("close", stop);
  ws.addEventListener("error", stop);
  return new Response(null, { status: 101, webSocket: client });
}
