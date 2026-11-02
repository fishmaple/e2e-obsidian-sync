export function excludedPath(path: string, patterns: string[]): boolean {
  const norm = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const base = norm.split("/").pop() ?? norm;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith("#")) continue;
    const folder = pattern.endsWith("/");
    const body = pattern.replace(/\/+$/, "");
    if (!body) continue;
    if (folder) {
      if (norm === body || norm.startsWith(`${body}/`)) return true;
      continue;
    }
    if (globMatch(norm, body) || globMatch(base, body)) return true;
    if (!body.includes("/") && norm.split("/").some((part) => globMatch(part, body))) return true;
  }
  return false;
}

function globMatch(value: string, pattern: string): boolean {
  return new RegExp(`^${globSource(pattern)}$`, "i").test(value);
}

function globSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i += 1;
      if (pattern[i + 1] === "/") i += 1;
      continue;
    }
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}
