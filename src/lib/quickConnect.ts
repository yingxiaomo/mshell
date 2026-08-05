/** Parse a `user@host:port` target string (user defaults to root, port to 22). */
export function parseTarget(
  s: string,
): { username: string; host: string; port: number } | null {
  const t = s.trim();
  if (!t) return null;
  let username = "root";
  let rest = t;
  const at = t.lastIndexOf("@");
  if (at >= 0) {
    username = t.slice(0, at);
    rest = t.slice(at + 1);
  }
  let host = rest;
  let port = 22;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0 && /^\d+$/.test(rest.slice(colon + 1))) {
    host = rest.slice(0, colon);
    port = parseInt(rest.slice(colon + 1), 10) || 22;
  }
  if (!host.trim()) return null;
  return { username: username.trim() || "root", host: host.trim(), port };
}
