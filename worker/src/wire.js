// Minimal VLESS v0: TCP over TLS/WebSocket; no UDP, mux or early data.
export function parseHeader(b) {
  const bad = () => {
    throw Error("Invalid or unsupported header");
  };
  if (b.length < 18) return null;
  if (b[0] !== 0 || b[17] !== 0) bad();
  if (b.length < 22) return null;
  const port = b[19] * 256 + b[20];
  if (b[18] !== 1 || ![80, 443].includes(port)) bad();
  let host, offset;
  if (b[21] === 2) {
    if (b.length < 23) return null;
    const n = b[22];
    if (!n) bad();
    offset = 23 + n;
    if (b.length < offset) return null;
    host = new TextDecoder().decode(b.slice(23, offset));
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
        host,
      ) ||
      /\.(?:localhost|internal|local|lan)$/i.test(host)
    )
      bad();
  } else if (b[21] === 1) {
    if (b.length < 26) return null;
    const [a, c] = b.slice(22, 24);
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && c === 254) ||
      (a === 172 && c >= 16 && c <= 31) ||
      (a === 192 && c === 168) ||
      (a === 100 && c >= 64 && c <= 127)
    )
      bad();
    host = [...b.slice(22, 26)].join(".");
    offset = 26;
  } else bad();
  const hex = [...b.slice(1, 17)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const id = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
  return { id, host, port, offset };
}
// Debit before forwarding. One conditional write on D1 prevents overspending across concurrent sockets.
export async function charge(db, id, n) {
  if (!Number.isSafeInteger(n) || n < 1) throw Error("Invalid length");
  const r = await db
    .prepare(
      "UPDATE users SET used_bytes=used_bytes+? WHERE id=? AND status='active' AND expires_at>? AND used_bytes+?<=quota_bytes",
    )
    .bind(n, id, new Date().toISOString(), n)
    .run();
  if (r.meta.changes !== 1) throw Error("Quota or validity ended");
}
