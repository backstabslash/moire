const AGENTS: [RegExp, string][] = [
  [/<noreply@anthropic\.com>|\bclaude(-code)?\[bot\]|^claude code\b/i, "Claude"],
  [/\bcodex\b/i, "Codex"],
  [/\bcursoragent\b|\bcursor\[bot\]/i, "Cursor"],
  [/\bcopilot\b/i, "Copilot"],
  [/\bdevin-ai-integration\b|\bdevin\[bot\]|^devin ai\b/i, "Devin"],
  [/\(aider\)|@aider\.chat>/i, "Aider"],
  [/\bgemini-(code-assist|cli)\b|\bgemini\[bot\]|^gemini\s*</i, "Gemini"],
];

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const picked = words.length > 1 ? [words[0], words.at(-1)!] : words;
  return picked.map((w) => [...w][0].toUpperCase()).join("") || "?";
}

export function hueOf(key: string): number {
  let h = 0;
  for (const ch of key.toLowerCase()) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}

export function agentOf(people: readonly string[]): string | null {
  for (const person of people) {
    const found = AGENTS.find(([pattern]) => pattern.test(person));
    if (found) return found[1];
  }
  return null;
}
