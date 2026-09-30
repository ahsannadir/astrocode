/**
 * Skills for AstroCode — progressive-disclosure packages (the Open Tool Bus,
 * part 2). A skill is a folder under `.astrocode/skills/` or `~/.astrocode/skills/`:
 *
 *   my-skill/
 *     SKILL.md   ← frontmatter: name, description; body: when/how to use it
 *     scripts/   ← optional executable helpers the skill body can reference
 *
 * Only name+description load at startup (progressive disclosure); the full
 * body enters context on first use of the skill — keeping the attention
 * budget small (Anthropic's "just in time" context pattern). Bodies are
 * injected via a `use_skill` tool the agent calls when a task matches.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolSchema } from './types.js';

export interface Skill {
  /** Skill name (frontmatter `name`, else folder name). */
  name: string;
  /** One-line description — the ONLY thing loaded into context at startup. */
  description: string;
  /** Full instructions (the SKILL.md body), loaded on first use. */
  body: string;
  /** Absolute path of the SKILL.md. */
  filePath: string;
  /** Where it came from: project or user config dir. */
  source: 'project' | 'user';
  /** Relative paths of files in scripts/ (executable helpers). */
  scripts: string[];
}

// ── discovery ───────────────────────────────────────────────────────────────

function skillsDirs(cwd: string): Array<{ dir: string; source: 'project' | 'user' }> {
  return [
    { dir: path.join(cwd, '.astrocode', 'skills'), source: 'project' as const },
    { dir: path.join(os.homedir(), '.astrocode', 'skills'), source: 'user' as const },
  ];
}

/** Minimal YAML-ish frontmatter parser: `key: value` lines between --- fences. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && val) meta[key] = val;
    }
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

async function loadSkillDir(dir: string, source: 'project' | 'user'): Promise<Skill | null> {
  const file = path.join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // no SKILL.md — not a skill
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = (meta.name || path.basename(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!body) return null;
  const scripts: string[] = [];
  try {
    const entries = await fs.readdir(path.join(dir, 'scripts'), { withFileTypes: true });
    for (const e of entries) if (e.isFile()) scripts.push(path.join('scripts', e.name));
  } catch {
    /* no scripts dir */
  }
  return {
    name,
    description: meta.description || body.split('\n')[0].slice(0, 120),
    body,
    filePath: file,
    source,
    scripts,
  };
}

/** Discover all skills (project + user). Invalid dirs are skipped silently. */
export async function discoverSkills(cwd: string): Promise<Skill[]> {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const { dir, source } of skillsDirs(cwd)) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skill = await loadSkillDir(path.join(dir, e.name), source);
      if (skill && !seen.has(skill.name)) {
        seen.add(skill.name);
        out.push(skill);
      }
    }
  }
  return out;
}

// ── registry + progressive disclosure ───────────────────────────────────────

let loaded: Skill[] = [];
const used = new Set<string>();

/** Load skills for this session and return the one-line catalog summary. */
export async function loadSkills(cwd: string): Promise<string> {
  loaded = await discoverSkills(cwd);
  used.clear();
  if (loaded.length === 0) return '';
  const rows = loaded
    .map((s) => `  ${s.name} — ${s.description} (${s.source})`)
    .join('\n');
  return (
    `## Skills available (via the use_skill tool)\n` +
    `When a task matches a skill below, call use_skill BEFORE improvising:\n${rows}`
  );
}

export function getSkills(): Skill[] {
  return loaded;
}

export function skillIsUsed(name: string): boolean {
  return used.has(name);
}

/**
 * Mark + return a skill body (first use loads it into context once).
 * Returns an error string when unknown.
 */
export function useSkill(name: string): { ok: boolean; text: string } {
  const skill = loaded.find((s) => s.name === name.toLowerCase().trim());
  if (!skill) {
    const names = loaded.map((s) => s.name).join(', ') || '(none)';
    return { ok: false, text: `Unknown skill "${name}". Available: ${names}` };
  }
  used.add(skill.name);
  const scriptsNote =
    skill.scripts.length > 0
      ? `\n\nRunnable helper files (relative to ${path.dirname(skill.filePath)}): ${skill.scripts.join(', ')}`
      : '';
  return {
    ok: true,
    text:
      `Skill "${skill.name}" loaded (${skill.source}):\n\n${skill.body}${scriptsNote}\n\n` +
      `(Follow these instructions for the current task. Scripts run with run_command if needed.)`,
  };
}

/** Catalog injected into the system prompt (empty string when no skills). */
export function skillsPromptBlock(): string {
  if (loaded.length === 0) return '';
  const rows = loaded.map((s) => `  ${s.name} — ${s.description}`).join('\n');
  return (
    `\n\n## Skills available (via the use_skill tool)\n` +
    `When a task matches a skill below, call use_skill BEFORE improvising:\n${rows}`
  );
}

// ── use_skill tool schema (registered when skills exist) ────────────────────

export function useSkillToolSchema(): ToolSchema {
  return {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Load a skill package by name. Skills are curated, versioned instruction sets ' +
        '(under .astrocode/skills/) — call this when the task matches one instead of ' +
        'improvising. The body is loaded once into context.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill name (see the skills list in your context)' },
        },
        required: ['name'],
      },
    },
  };
}

/** Scaffold an example skill under <cwd>/.astrocode/skills/<name>/SKILL.md. */
export async function scaffoldSkill(cwd: string, name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'my-skill';
  const dir = path.join(cwd, '.astrocode', 'skills', slug);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  try {
    await fs.access(file);
    return `Skill "${slug}" already exists: ${file}`;
  } catch {
    /* doesn't exist — create it */
  }
  const content =
    `---\nname: ${slug}\ndescription: One line describing WHEN the agent should use this skill.\n---\n\n` +
    `# ${slug}\n\n## When to use\n- (trigger conditions for this skill)\n\n## Steps\n1. (deterministic procedure)\n\n## Rules\n- (conventions, gotchas, forbidden moves)\n\n## Verify\n- (how to prove the skill was applied correctly)\n`;
  await fs.writeFile(file, content, 'utf8');
  return `Scaffolded skill "${slug}" at ${file}\nEdit SKILL.md, then /skills reload.`;
}
