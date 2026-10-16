export type Group = "Navigate" | "Review" | "Copy" | "View";

export interface CommandDef {
  keys: readonly string[];
  label: string;
  group: Group;
  // Mod keys still work while a text field has focus.
  anywhere?: boolean;
  noRepo?: boolean;
  // Held keys auto-repeat, which would restart these.
  hold?: boolean;
  // Auto-repeat would act again on whatever gets focused next.
  once?: boolean;
  // Main catches these keys before the page sees them, so they can't be remapped.
  fixed?: boolean;
}

export const COMMANDS = {
  nextHunk: { keys: ["j"], label: "Next hunk", group: "Navigate" },
  prevHunk: { keys: ["k"], label: "Previous hunk", group: "Navigate" },
  firstHunk: { keys: ["g g"], label: "First hunk", group: "Navigate" },
  lastHunk: { keys: ["G"], label: "Last hunk", group: "Navigate" },
  nextFile: { keys: ["]"], label: "Next file", group: "Navigate" },
  prevFile: { keys: ["["], label: "Previous file", group: "Navigate" },
  search: { keys: ["/", "Mod+f"], label: "Search", group: "Navigate", anywhere: true },
  nextHit: { keys: ["n"], label: "Next result", group: "Navigate" },
  prevHit: { keys: ["N"], label: "Previous result", group: "Navigate" },
  filterFiles: { keys: ["p", "Mod+p"], label: "Filter files", group: "Navigate", anywhere: true },
  allFiles: { keys: ["a"], label: "Changed or all files", group: "Navigate" },
  nextNote: { keys: ["."], label: "Next agent note", group: "Navigate" },
  prevNote: { keys: [","], label: "Previous agent note", group: "Navigate" },
  recentRepos: { keys: ["o"], label: "Recent repositories", group: "Navigate", noRepo: true },
  openRepo: { keys: ["Mod+o"], label: "Open repository…", group: "Navigate", noRepo: true, anywhere: true },

  stage: { keys: ["s"], label: "Stage or unstage", group: "Review", once: true },
  discard: { keys: ["x"], label: "Discard", group: "Review", once: true },
  stageAll: { keys: ["S"], label: "Stage or unstage all files", group: "Review", once: true },
  discardFile: { keys: [], label: "Discard file", group: "Review", once: true },
  undo: { keys: ["u", "Mod+z"], label: "Undo", group: "Review", once: true },
  extendDown: { keys: ["J"], label: "Extend selection down", group: "Review" },
  extendUp: { keys: ["K"], label: "Extend selection up", group: "Review" },
  blinkHold: { keys: ["b"], label: "Hold to see plate A", group: "Review", hold: true },
  blink: { keys: ["B"], label: "Blink between A and B", group: "Review", hold: true },
  openEditor: { keys: ["e"], label: "Open in editor", group: "Review" },
  refresh: { keys: ["r"], label: "Refresh", group: "Review" },
  cancel: { keys: ["Escape"], label: "Stop blink, clear selection", group: "Review" },

  copyMarkdown: { keys: ["c"], label: "Copy as Markdown", group: "Copy" },
  copyCode: { keys: ["Mod+c"], label: "Copy lines", group: "Copy" },
  selectAll: { keys: ["Mod+a"], label: "Select all lines", group: "Copy" },
  pasteFiles: { keys: ["Mod+v"], label: "Paste files into the folder", group: "Copy", once: true },

  compare: { keys: [], label: "Choose what to compare", group: "View" },
  unstaged: { keys: ["1"], label: "Unstaged", group: "View" },
  staged: { keys: ["2"], label: "Staged", group: "View" },
  all: { keys: ["3"], label: "All since last commit", group: "View" },
  commit: { keys: ["4"], label: "Commit…", group: "View" },
  branches: { keys: ["5"], label: "Branch vs branch…", group: "View" },
  layout: { keys: ["v"], label: "Split or unified", group: "View" },
  grouping: { keys: ["l"], label: "Paired or by folder", group: "View" },
  fullFile: { keys: ["f"], label: "Full file", group: "View" },
  notes: { keys: ["I"], label: "Agent notes", group: "View" },
  preview: { keys: ["m"], label: "Preview or diff", group: "View" },
  theme: { keys: ["t"], label: "Light or dark theme", group: "View" },
  zoomIn: { keys: ["Mod+="], label: "Zoom in", group: "View", noRepo: true, fixed: true },
  zoomOut: { keys: ["Mod+-"], label: "Zoom out", group: "View", noRepo: true, fixed: true },
  zoomReset: { keys: ["Mod+0"], label: "Actual size", group: "View", noRepo: true, fixed: true },
  help: { keys: ["?"], label: "Keyboard shortcuts", group: "View", noRepo: true },
  editKeys: { keys: [], label: "Edit keyboard shortcuts…", group: "View", noRepo: true },
} satisfies Record<string, CommandDef>;

export type CommandId = keyof typeof COMMANDS;
export const GROUPS: Group[] = ["Navigate", "Review", "Copy", "View"];
export const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];
export const command = (id: CommandId): CommandDef => COMMANDS[id];
export const isCommand = (id: string): id is CommandId => Object.hasOwn(COMMANDS, id);

export type Keys = Record<CommandId, string[]>;

export interface Keymap {
  keys: Keys;
  byStroke: ReadonlyMap<string, CommandId>;
  prefixes: ReadonlySet<string>;
}

const NAMED: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  space: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};
export const NAMED_KEYS: ReadonlySet<string> = new Set(Object.values(NAMED));
const MOD = new Set(["mod", "ctrl", "control", "cmd", "command", "meta", "cmdorctrl"]);
const printable = (c: string) => c.length === 1 && c >= "!" && c <= "~";
const letter = (c: string) => /^[a-z]$/i.test(c);

// Canonical strokes: a printable character as typed ("j", "J", "?"), a named key ("Escape"),
// with "Mod+" (Ctrl, or Cmd on macOS) and "Shift+" prefixes where the character can't carry them.
export function parseStroke(text: string): string | null {
  const m = /^((?:[a-z]+\+)*)(.+)$/i.exec(text.trim());
  if (!m) return null;
  let mod = false;
  let shift = false;
  for (const name of m[1].toLowerCase().split("+").filter(Boolean)) {
    if (MOD.has(name)) mod = true;
    else if (name === "shift") shift = true;
    else return null;
  }
  const key = m[2];
  const named = NAMED[key.toLowerCase()];
  if (named) return `${mod ? "Mod+" : ""}${shift ? "Shift+" : ""}${named}`;
  if (!printable(key)) return null;
  if (mod) {
    if (shift && !letter(key)) return null;
    return `Mod+${shift ? "Shift+" : ""}${key.toLowerCase()}`;
  }
  if (!letter(key)) return shift ? null : key;
  return shift || key !== key.toLowerCase() ? key.toUpperCase() : key;
}

export function parseKey(text: string): string | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length > 2 || !parts[0]) return null;
  const strokes = parts.map(parseStroke);
  return strokes.every(Boolean) ? strokes.join(" ") : null;
}

export const DEFAULT_KEYS = Object.fromEntries(COMMAND_IDS.map((id) => [id, [...COMMANDS[id].keys]])) as Keys;

export function buildKeymap(keys: Keys): Keymap {
  const byStroke = new Map<string, CommandId>();
  const prefixes = new Set<string>();
  for (const id of COMMAND_IDS) {
    for (const key of keys[id]) {
      if (!byStroke.has(key)) byStroke.set(key, id);
      if (key.includes(" ")) prefixes.add(key.split(" ")[0]);
    }
  }
  return { keys, byStroke, prefixes };
}

export const DEFAULT_KEYMAP = buildKeymap(DEFAULT_KEYS);

export function lookup(keymap: Keymap, pending: string | null, stroke: string): CommandId | "prefix" | null {
  const seq = pending && keymap.byStroke.get(`${pending} ${stroke}`);
  if (seq) return seq;
  if (keymap.prefixes.has(stroke)) return "prefix";
  return keymap.byStroke.get(stroke) ?? null;
}

const first = (key: string) => key.split(" ")[0];

// Two bindings clash when they're equal or one is the first key of the other.
function clashes(keys: Keys): { ids: [CommandId, CommandId]; key: string }[] {
  const all = COMMAND_IDS.flatMap((id) => keys[id].map((key) => ({ id, key })));
  return all.flatMap((x, i) =>
    all.slice(i + 1).flatMap((y) => {
      if (x.id === y.id) return [];
      const [one, seq] = x.key.includes(" ") ? [y.key, x.key] : [x.key, y.key];
      return one === seq || (!one.includes(" ") && first(seq) === one) ? [{ ids: [x.id, y.id] as [CommandId, CommandId], key: one }] : [];
    }),
  );
}

export interface ResolvedKeys {
  keys: Keys;
  problems: string[];
}

export function resolveKeys(text: string | null): ResolvedKeys {
  const keys = { ...DEFAULT_KEYS };
  if (text === null) return { keys, problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { keys, problems: [`It isn't valid JSON, so every key has its default (${(e as Error).message}).`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { keys, problems: ['It should hold one object, like {"stage": "S"}, so every key has its default.'] };

  const problems: string[] = [];
  const unknown: string[] = [];
  const changed = new Set<CommandId>();
  for (const [id, value] of Object.entries(raw)) {
    if (id.startsWith("//") || id.startsWith("$")) continue;
    if (!isCommand(id)) {
      unknown.push(`"${id}"`);
      continue;
    }
    const list = value === null || value === "" ? [] : typeof value === "string" ? [value] : value;
    if (!Array.isArray(list) || !list.every((v): v is string => typeof v === "string")) {
      problems.push(`${id} should be a key or a list of keys, so it keeps its default.`);
      continue;
    }
    const parsed = list.map((v) => [v, parseKey(v)] as const);
    const bad = parsed.find(([, p]) => !p);
    if (bad) {
      problems.push(`"${bad[0]}" isn't a key moire can read, so ${id} keeps its default.`);
      continue;
    }
    const next = [...new Set(parsed.map(([, p]) => p!))];
    if (next.join("\n") === DEFAULT_KEYS[id].join("\n")) continue;
    if (command(id).fixed) {
      problems.push(`${id} can't be changed.`);
      continue;
    }
    keys[id] = next;
    changed.add(id);
  }
  if (unknown.length) problems.unshift(`No command is called ${unknown.join(", ")}.`);

  for (let found = clashes(keys); ; found = clashes(keys)) {
    const clash = found.find(({ ids }) => ids.some((id) => changed.has(id)));
    if (!clash) break;
    const reverted = clash.ids.filter((id) => changed.delete(id));
    for (const id of reverted) keys[id] = [...DEFAULT_KEYS[id]];
    problems.push(
      `${clash.ids.join(" and ")} both use ${clash.key}, so ${reverted.join(" and ")} ${reverted.length > 1 ? "keep their defaults" : "keeps its default"}.`,
    );
  }
  return { keys, problems };
}

export function defaultKeysFile(): string {
  const help =
    "Change a key by editing its value, then save. A capital letter means Shift. Mod is Ctrl, or Cmd on macOS, as in Mod+z. " +
    'Two keys in a row are written "g g". Use a list for several keys, or "" for none. Ids not listed keep their default.';
  const lines = COMMAND_IDS.filter((id) => !command(id).fixed).map((id) => {
    const keys = DEFAULT_KEYS[id];
    return `  ${JSON.stringify(id)}: ${JSON.stringify(keys.length === 1 ? keys[0] : keys)}`;
  });
  return `{\n  "//": ${JSON.stringify(help)},\n${lines.join(",\n")}\n}\n`;
}

const KBD_NAMES: Record<string, [string, string]> = {
  Escape: ["esc", "Esc"],
  Enter: ["↵", "Enter"],
  Space: ["space", "Space"],
  ArrowUp: ["↑", "Up"],
  ArrowDown: ["↓", "Down"],
  ArrowLeft: ["←", "Left"],
  ArrowRight: ["→", "Right"],
  Backspace: ["⌫", "Backspace"],
  Delete: ["del", "Delete"],
  PageUp: ["pgup", "Page Up"],
  PageDown: ["pgdn", "Page Down"],
};

function partLabel(part: string, mac: boolean, form: "kbd" | "text"): string {
  const kbd = form === "kbd";
  const mods: string[] = [];
  let rest = part;
  if (rest.startsWith("Mod+")) {
    mods.push(mac ? (kbd ? "⌘" : "Cmd") : kbd ? "ctrl" : "Ctrl");
    rest = rest.slice(4);
    if (rest === "=") rest = "+";
  }
  if (rest.startsWith("Shift+") && rest.length > 6) {
    mods.push(kbd ? "shift" : "Shift");
    rest = rest.slice(6);
  } else if (letter(rest) && rest !== rest.toLowerCase()) {
    mods.push(kbd ? "shift" : "Shift");
    rest = rest.toLowerCase();
  }
  const key = KBD_NAMES[rest]?.[kbd ? 0 : 1] ?? rest;
  if (!kbd) return [...mods, mods.length ? key.toUpperCase() : key].join("+");
  return mods[0] === "⌘" ? `⌘${[...mods.slice(1), key].join(" ")}` : [...mods, key].join(" ");
}

// "kbd" is the compact form for key caps ("shift b", "⌘z"); "text" reads in a sentence ("Shift+B", "Ctrl+Z").
export function strokeLabel(key: string, mac: boolean, form: "kbd" | "text" = "kbd"): string {
  return key
    .split(" ")
    .map((part) => partLabel(part, mac, form))
    .join(" ");
}

export function keyLabel(keymap: Keymap, id: CommandId, mac: boolean, form: "kbd" | "text" = "kbd"): string {
  const key = keymap.keys[id][0];
  return key ? strokeLabel(key, mac, form) : "";
}

const ACCEL_NAMES: Record<string, string> = { Escape: "Esc", Enter: "Enter", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

export function accelerator(key: string): string | null {
  if (!key || key.includes(" ")) return null;
  const mod = key.startsWith("Mod+");
  let rest = mod ? key.slice(4) : key;
  const shift = rest.startsWith("Shift+") && rest.length > 6;
  if (shift) rest = rest.slice(6);
  let name = ACCEL_NAMES[rest] ?? rest;
  if (name === "+" || (mod && name === "=")) name = "Plus";
  const upper = letter(name) && name === name.toUpperCase();
  return [mod && "CmdOrCtrl", (shift || upper) && "Shift", name.length === 1 ? name.toUpperCase() : name].filter(Boolean).join("+");
}
