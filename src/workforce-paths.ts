/** Shared worker policy. Reading project instructions does not authorize editing
 * the instructions, client configuration, credentials or runtime state. */
export function workForcePrivatePath(path: string): boolean {
  return path.toLowerCase().split('/').some(part =>
    ['.git', '.workforce', '.workforce-private', '.neomind', '.verythinker', '.taskforces', '.codex', '.claude', '.vscode', '.agents', '.cursor', 'node_modules'].includes(part) ||
    /^(?:\.env(?:\..*)?|auth\.json|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|pfx|p12))$/.test(part));
}

/** Authorization is still supplied by the frozen controller role/scope. This
 * only distinguishes ordinary product paths from protected host instructions. */
export function workForceEditablePath(path: string): boolean {
  const lower = path.toLowerCase(), parts = lower.split('/');
  if (workForcePrivatePath(path) || parts.includes('.gemini') ||
      parts.some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part)) ||
      /(?:^|\/)(?:agents(?:\.override)?\.md|claude\.md|gemini\.md|skill\.md|copilot-instructions\.md|\.cursorrules|[^/]+\.(?:agent|instructions)\.md)$/.test(lower)) return false;
  // GitHub workflow definitions are project products. Generated agents, skills,
  // hooks and other GitHub client configuration remain outside this seam.
  return !parts.includes('.github') || lower === '.github/workflows' || lower.startsWith('.github/workflows/');
}
