/**
 * Expands camelCase, PascalCase, and snake_case identifiers so BM25 can match
 * sub-words. The original token is preserved so exact-match queries still work.
 *
 * Examples:
 *   getUserById  → "getUserById get user by id"
 *   parse_json   → "parse_json parse json"
 *   HTTPSClient  → "HTTPSClient https client"
 */
export function expandIdentifiers(text: string): string {
  return text.replace(/[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9]/g, (token) => {
    const parts = token
      .split("_")
      .flatMap((part) =>
        part
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
          .split(" "),
      )
      .map((p) => p.toLowerCase())
      .filter(Boolean);
    const unique = [...new Set(parts)];
    if (unique.length <= 1) return token;
    return `${token} ${unique.join(" ")}`;
  });
}
