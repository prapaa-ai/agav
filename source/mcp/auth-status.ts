/** One startup warning, regardless of how many servers require sign-in. */
export function formatMCPAuthenticationWarning(names: string[]): string | null {
  if (!names.length) return null;
  return `Warning: ${names.length} MCP server${names.length === 1 ? " requires" : "s require"} authentication. Run /mcp to view them, then /mcp auth <name> to sign in.`;
}
