/**
 * Standalone adaptation of the skill-management subsystem from
 * pi-hermes-memory v0.9.7 by Chandra Teja:
 * https://github.com/chandra447/pi-hermes-memory/tree/v0.9.7
 *
 * Original and adapted code are distributed under the MIT License. See
 * THIRD_PARTY_NOTICES.md in this package for attribution and license text.
 */

import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { keyHint, withFileMutationQueue, type ExtensionAPI, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

type SkillScope = "global" | "project";

interface SkillManagerOptions {
  globalSkillsDir: string;
  piGlobalSkillsDir: string;
  projectSkillsDir: string | null;
  projectName: string | null;
}

interface SkillResult {
  success: boolean;
  error?: string;
  message?: string;
  fileName?: string;
  skillId?: string;
  scope?: SkillScope;
  path?: string;
  conflictType?: "duplicate" | "similar" | "name-collision" | "scope-conflict";
  similarSkillIds?: string[];
  suggestedAction?: "patch" | "update" | "rename";
}

interface SkillDocument {
  skillId: string;
  scope: SkillScope;
  fileName: string;
  path: string;
  projectName?: string;
  name: string;
  displayName?: string;
  description: string;
  version: number;
  created: string;
  updated: string;
  body: string;
}

const TOOL_DESCRIPTION = `Manage reusable procedures and patterns as Pi-native skills that survive across sessions. Skills are procedural memory — they capture HOW to do something, not just what happened.

This tool is intentionally named 'skill_manage' because it manages saved procedural skills; it is not a generic skill-discovery tool.

Use create for a new skill, patch for a targeted section update, update for a full rewrite, view to inspect existing skills, and delete to remove obsolete ones. When creating a skill, scope is required: use global for portable workflows and project for procedures tied to this repo's paths, scripts, architecture, deploy steps, or conventions.`;

const TOOL_DESCRIPTION_SUFFIX = `

WHEN TO CREATE A SKILL:
- After completing a complex task that required trial and error or multiple tool calls
- When you discover a non-obvious approach that could be reused
- When the user teaches you a specific workflow or procedure

SCOPE:
- 'global': transferable procedures that can be reused across repositories. Written to ~/.pi/agent/pi-hermes-memory/skills/<slug>/SKILL.md, this extension's own directory, kept separate from skills the user installed themselves. Pi also loads its own ~/.pi/agent/skills/ first, so a name already used there is rejected rather than silently shadowed.
- 'project': procedures tied to this repo's paths, scripts, architecture, deploy flow, or conventions. Written to ~/.pi/agent/projects-memory/<project>/skills/<slug>/SKILL.md.

WHEN TO UPDATE A SKILL:
- Prefer 'patch' for one section when you can pass structured fields
- Prefer 'update' for multi-section rewrites or when patch formatting would be unstable
- Use patch when you discover a better approach, pitfall, or changed step in one section

SKILL FORMAT:
- name: short, descriptive (e.g., "debug-typescript-errors")
- description: one-line summary of when to use it
- body: structured with sections — ## When to Use, ## Procedure, ## Pitfalls, ## Verification
- Prefer structured fields over raw markdown when possible:
  - when_to_use: trigger conditions and boundaries
  - procedure_steps: ordered concrete steps
  - pitfalls: caveats or failure modes
  - verification_steps: checks that prove success
- For patch, pass section plus the matching structured field (section="Procedure" + procedure_steps, etc.). Do not pass JSON array/object strings as content.

ONE-SHOT EXAMPLE:
{
  "action": "create",
  "name": "debug-typescript-errors",
  "description": "Debug TypeScript build failures in this repo",
  "scope": "project",
  "when_to_use": "Use when TypeScript fails in this repo's workspace or CI.",
  "procedure_steps": [
    "Run pnpm tsc --noEmit to get the full error list.",
    "Fix dependency or config errors before leaf-module errors.",
    "Re-run the same command until it passes cleanly."
  ],
  "pitfalls": [
    "Do not trust editor-only diagnostics without the CLI output.",
    "Do not stop after the first error if downstream modules are still failing."
  ],
  "verification_steps": [
    "pnpm tsc --noEmit exits successfully.",
    "The failing CI TypeScript job passes."
  ]
}

ACTIONS: create (new skill), view (read full content or list), patch (update a section by skill_id), update (replace description + body by skill_id), delete (remove by skill_id).

Do not use this tool to discover already-loaded external skills by name alone; use Pi's loaded skill context or explicit SKILL.md paths for that.`;

const PARAMETERS = Type.Object({
  action: StringEnum(["create", "view", "patch", "update", "edit", "delete"] as const, { description: "The skill action to perform." }),
  name: Type.Optional(Type.String({ description: "Skill name for create. e.g., 'debug-typescript-errors'." })),
  skill_id: Type.Optional(Type.String({ description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field." })),
  description: Type.Optional(Type.String({ description: "One-line description of when to use this skill. Required for create; optional for update/edit." })),
  scope: Type.Optional(StringEnum(["global", "project"] as const, { description: "Required for create. Use 'global' for portable procedures and 'project' for repo-specific workflows." })),
  section: Type.Optional(Type.String({ description: "Required for patch. Section header to patch. e.g., 'Procedure', 'Pitfalls', 'Verification', 'When to Use'." })),
  content: Type.Optional(Type.String({ description: "Raw markdown body for create/update/edit, or Markdown section body for patch. Prefer structured fields over free-form content when possible. For patch, JSON arrays are auto-coerced for list sections; JSON objects are rejected." })),
  when_to_use: Type.Optional(Type.String({ description: "Structured create/update/edit field, or structured patch body when section is 'When to Use'." })),
  procedure_steps: Type.Optional(Type.Array(Type.String(), { description: "Structured create/update/edit field, or structured patch body when section is 'Procedure'. Ordered concrete steps." })),
  pitfalls: Type.Optional(Type.Array(Type.String(), { description: "Structured create/update/edit field, or structured patch body when section is 'Pitfalls'." })),
  verification_steps: Type.Optional(Type.Array(Type.String(), { description: "Structured create/update/edit field, or structured patch body when section is 'Verification'." })),
}, { additionalProperties: false });

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function formatOrderedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function formatBulletList(items: string[], fallback: string): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;
}

function buildStructuredSkillBody(whenToUse: string, procedure: string[], pitfalls: string[], verification: string[]): string {
  return [
    "## When to Use", whenToUse, "",
    "## Procedure", formatOrderedList(procedure), "",
    "## Pitfalls", formatBulletList(pitfalls, "No notable pitfalls recorded yet."), "",
    "## Verification", formatOrderedList(verification),
  ].join("\n");
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").replace(/--+/g, "-").slice(0, 64);
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function formatFrontmatter(doc: {
  name: string;
  displayName?: string;
  description: string;
  version: number;
  created: string;
  updated: string;
  body: string;
}): string {
  const lines = [
    "---",
    `name: ${JSON.stringify(doc.name)}`,
    `description: ${JSON.stringify(doc.description)}`,
    `version: ${doc.version}`,
    `created: ${JSON.stringify(doc.created)}`,
    `updated: ${JSON.stringify(doc.updated)}`,
  ];
  if (doc.displayName?.trim() && doc.displayName.trim() !== doc.name) lines.push(`display_name: ${JSON.stringify(doc.displayName.trim())}`);
  lines.push("---", doc.body);
  return lines.join("\n");
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    try {
      const parsed = JSON.parse(rawValue);
      meta[key] = typeof parsed === "string" ? parsed : rawValue;
    } catch {
      meta[key] = rawValue;
    }
  }
  return { meta, body: match[2].trim() };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, filePath);
}

function textResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
}

function validationError(error: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }], details: {} };
}

function record(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
}

function rendererData(result: unknown): Record<string, any> | null {
  const resultRecord = record(result);
  const details = record(resultRecord?.details);
  if (details && Object.keys(details).length) return details;
  const content = resultRecord?.content;
  const text = Array.isArray(content) && content.length === 1 ? record(content[0])?.text : undefined;
  if (typeof text !== "string" || !text.trimStart().startsWith("{")) return null;
  try { return record(JSON.parse(text)); } catch { return null; }
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function stripDisplayControls(text: string): string {
  return text
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\p{Cc}\p{Cs}\uFFF9-\uFFFB]/gu, (character) => character === "\n" || character === "\t" ? character : "");
}

function skillOutputView(result: unknown): { summary: string; expandedText: string; status: "success" | "failure" | "empty" } {
  const resultRecord = record(result);
  const details = record(resultRecord?.details);
  const expandedText = stripDisplayControls(Array.isArray(resultRecord?.content)
    ? resultRecord.content.flatMap((item: unknown) => {
      const block = record(item);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    }).join("\n")
    : "");
  const detailsReason = stripDisplayControls(firstText(details?.error, details?.message, details?.reason) ?? "");
  const failed = resultRecord?.isError === true || details?.success === false || details?.isError === true;
  const baseStatus = failed ? "failure" : expandedText.trim() ? "success" : "empty";
  const baseSummary = failed
    ? detailsReason || expandedText.split(/\r?\n/).find((line) => line.trim())?.trim() || "Error"
    : expandedText.split(/\r?\n/).find((line) => line.trim())?.trim() || detailsReason || "No output";
  const data = rendererData(result);
  if (!data) return { summary: baseSummary, expandedText, status: baseStatus };
  if (data.success === false) {
    const reason = firstText(data.error, data.message);
    return { summary: reason ? `Error · ${reason}` : "Error", expandedText, status: "failure" };
  }
  if (Array.isArray(data.skills)) return { summary: `Skills: ${data.skills.length} available`, expandedText, status: baseStatus };
  const name = firstText(data.displayName, data.name, data.skillId, data.skill_id);
  return { summary: name ? `Skill: ${name}` : firstText(data.message) ?? "Skill updated", expandedText, status: baseStatus };
}

function compactSummary(summary: string, width: number, preserveTail: boolean): string {
  if (visibleWidth(summary) <= width) return summary;
  if (!preserveTail || width < 13) return truncateToWidth(summary, width, "…");
  const tailWidth = Math.max(6, Math.floor(width / 2));
  const headWidth = Math.max(3, width - tailWidth - 1);
  const fullWidth = visibleWidth(summary);
  return `${sliceByColumn(summary, 0, headWidth, true)}…${sliceByColumn(summary, Math.max(0, fullWidth - tailWidth), tailWidth, true)}`;
}

function renderSkillResult(
  result: unknown,
  options: ToolRenderResultOptions,
  theme: { fg?: (color: any, text: string) => string; getBgAnsi?: (color: any) => string },
  context?: { isError?: boolean },
): Component {
  const view = skillOutputView(result);
  if (context?.isError) view.status = "failure";
  const background = options.isPartial ? "toolPendingBg" : context?.isError ? "toolErrorBg" : "toolSuccessBg";
  const restore = (text: string) => {
    if (typeof theme?.getBgAnsi !== "function") return text;
    const ansi = theme.getBgAnsi(background);
    return text.replace(/\x1b\[[0-?]*[ -/]*m/g, `$&${ansi}`);
  };
  if (options.expanded) return new Text(view.expandedText || view.summary, 0, 0, restore);
  return {
    render(width: number): string[] {
      const available = Math.max(1, width);
      const prefix = options.isPartial && !/progress|partial|in progress|处理中/i.test(view.summary) ? "In progress: " : "";
      const full = `${prefix}${view.summary}`;
      const hidden = view.expandedText.trim() !== view.summary.trim();
      const hint = hidden ? ` (${keyHint("app.tools.expand", "to expand")})` : "";
      const visibleHint = visibleWidth(hint) < available ? hint : "";
      const summary = compactSummary(full, Math.max(1, available - visibleWidth(visibleHint)), view.status === "failure" || /warning/i.test(full));
      const color = options.isPartial ? "warning" : view.status === "failure" ? "error" : view.status === "empty" ? "muted" : "toolOutput";
      return [restore(typeof theme?.fg === "function" ? theme.fg(color, `${summary}${visibleHint}`) : `${summary}${visibleHint}`)];
    },
    invalidate() {},
  };
}

function buildBody(params: Record<string, unknown>): { body?: string; error?: string } {
  const content = typeof params.content === "string" ? params.content.trim() : "";
  if (content) return { body: content };
  const whenToUse = typeof params.when_to_use === "string" ? params.when_to_use.trim() : "";
  const procedure = normalizeTextList(params.procedure_steps);
  const pitfalls = normalizeTextList(params.pitfalls);
  const verification = normalizeTextList(params.verification_steps);
  if (!whenToUse && !procedure.length && !pitfalls.length && !verification.length) {
    return { error: "Either content or structured fields are required. Prefer when_to_use, procedure_steps, pitfalls, and verification_steps for create/update." };
  }
  if (!whenToUse) return { error: "when_to_use is required when content is omitted." };
  if (!procedure.length) return { error: "procedure_steps is required when content is omitted." };
  if (!verification.length) return { error: "verification_steps is required when content is omitted." };
  return { body: buildStructuredSkillBody(whenToUse, procedure, pitfalls, verification) };
}

function normalizeSectionName(section: string): string {
  return section.replace(/^#+\s*/, "").trim();
}

function normalizePatchContent(section: string, raw: string): { content?: string; error?: string } {
  const sectionName = normalizeSectionName(section);
  if (!sectionName) return { error: "section is required for patch." };
  let content = raw.trim();
  if (!content) return { error: "New content is required for patch. Prefer structured fields (procedure_steps, pitfalls, verification_steps, when_to_use) over free-form content." };
  if (content.startsWith("{") && content.endsWith("}")) {
    return { error: "Patch content looks like a JSON object. Provide Markdown section body or a string array via structured fields." };
  }
  if (content.startsWith("[") && content.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!Array.isArray(parsed)) return { error: "Patch content looks like JSON but is not a string array." };
      const items = parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
      if (!items.length) return { error: "Patch content JSON array must contain non-empty strings." };
      const key = sectionName.toLowerCase();
      if (key === "when to use") content = items.join("\n\n");
      else if (key === "pitfalls") content = items.map((item) => `- ${item.replace(/^[-*]\s+/, "")}`).join("\n");
      else if (key === "procedure" || key === "verification") {
        content = items.map((item, index) => `${index + 1}. ${item.replace(/^\d+\.\s+/, "").replace(/^[-*]\s+/, "")}`).join("\n");
      } else content = items.map((item) => `- ${item}`).join("\n");
    } catch {
      return { error: "Patch content looks like a JSON array but could not be parsed. Use Markdown or structured string[] fields." };
    }
  }
  if (/^#{1,6}\s+\S/m.test(content)) {
    return { error: "Patch content must not include Markdown section headers (## ...). Patch only the body of the target section." };
  }
  return { content: content.trim() };
}

const THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/you\s+are\s+now\s+/i, "role_hijack"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don'?t\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets"],
  [/authorized_keys/i, "ssh_backdoor"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access"],
];

const SECRET_PATTERNS: Array<[RegExp, string, "high" | "medium"]> = [
  [/\bsk-ant-api\S{10,}\b/, "anthropic_api_key", "high"],
  [/\bsk-or-v1-\S{10,}\b/, "openrouter_api_key", "high"],
  [/\bsk-\S{20,}\b/, "openai_api_key", "high"],
  [/\bAKIA[0-9A-Z]{16}\b/, "aws_access_key", "high"],
  [/\bghp_\S{10,}\b/, "github_personal_token", "high"],
  [/\bghu_\S{10,}\b/, "github_user_token", "high"],
  [/\bxoxb-\S{10,}\b/, "slack_bot_token", "high"],
  [/\bxapp-\S{10,}\b/, "slack_app_token", "high"],
  [/\bntn_\S{10,}\b/, "notion_token", "high"],
  [/\bBearer\s+\S{20,}\b/, "bearer_auth_token", "high"],
  [/-----BEGIN\s+(?:RSA\s+)?PRIVATE\sKEY-----/, "private_key_block", "high"],
  [/\bANTHROPIC_API_KEY\b/, "env_anthropic_key", "medium"],
  [/\bOPENAI_API_KEY\b/, "env_openai_key", "medium"],
  [/\bOPENROUTER_API_KEY\b/, "env_openrouter_key", "medium"],
  [/\bGITHUB_TOKEN\b/, "env_github_token", "medium"],
  [/\bAWS_SECRET_ACCESS_KEY\b/, "env_aws_secret", "medium"],
  [/\bDATABASE_URL\b/, "env_database_url", "medium"],
  [/\bpassword\s*[=:]\s*\S{6,}\b/i, "password_assignment", "medium"],
  [/\bsecret\s*[=:]\s*\S{6,}\b/i, "secret_assignment", "medium"],
  [/\btoken\s*[=:]\s*\S{10,}\b/i, "token_assignment", "medium"],
];

const INVISIBLE_CHARS = new Set(["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e"]);

function scanContent(content: string): string | null {
  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return `Blocked: content contains invisible unicode character U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} (possible injection).`;
    }
  }
  for (const [pattern, id] of THREAT_PATTERNS) {
    if (pattern.test(content)) return `Blocked: content matches threat pattern '${id}'. Memory entries may be surfaced through search or legacy prompt injection and must not contain injection or exfiltration payloads.`;
  }
  for (const [pattern, id, severity] of SECRET_PATTERNS) {
    if (pattern.test(content)) return `Blocked: content looks like a ${severity}-severity credential or secret ('${id}'). Never persist API keys, tokens, or passwords to memory. Use an .env file or secrets manager instead.`;
  }
  return null;
}

const SIMILARITY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "use", "using", "with", "workflow", "procedure", "step",
  "steps", "guide", "skill", "skills", "repo", "project",
]);

function tokens(input: string): string[] {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .map((token) => token.trim()).filter((token) => token.length > 1 && !SIMILARITY_STOP_WORDS.has(token));
}

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  return intersection / new Set([...left, ...right]).size;
}

class SkillManager {
  constructor(private options: SkillManagerOptions) {}

  private async locations(scope?: SkillScope): Promise<Array<{ skillId: string; scope: SkillScope; slug: string; fileName: string; path: string; projectName?: string }>> {
    const found: Array<{ skillId: string; scope: SkillScope; slug: string; fileName: string; path: string; projectName?: string }> = [];
    const scan = async (root: string, itemScope: SkillScope) => {
      if (!await exists(root)) return;
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith(".")) continue;
          const child = path.join(dir, entry.name);
          const skillFile = path.join(child, "SKILL.md");
          if (await exists(skillFile)) {
            const skillId = itemScope === "global"
              ? `global:${entry.name}`
              : `project:${this.options.projectName ?? ""}:${entry.name}`;
            found.push({ skillId, scope: itemScope, slug: entry.name, fileName: "SKILL.md", path: skillFile, projectName: this.options.projectName ?? undefined });
          }
          await walk(child);
        }
      };
      await walk(root);
      if (itemScope === "global") {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries.filter((item) => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.name.endsWith(".md") || entry.name === "SKILL.md") continue;
          const slug = slugify(path.basename(entry.name, ".md"));
          if (slug) found.push({
            skillId: `global:${slug}`,
            scope: "global",
            slug,
            fileName: entry.name,
            path: path.join(root, entry.name),
            projectName: this.options.projectName ?? undefined,
          });
        }
      }
    };
    if (!scope || scope === "global") await scan(this.options.globalSkillsDir, "global");
    if ((!scope || scope === "project") && this.options.projectSkillsDir && this.options.projectName) {
      await scan(this.options.projectSkillsDir, "project");
    }
    const seen = new Set<string>();
    return found.filter((location) => {
      if (seen.has(location.skillId)) return false;
      seen.add(location.skillId);
      return true;
    });
  }

  private async read(location: Awaited<ReturnType<SkillManager["locations"]>>[number]): Promise<SkillDocument | null> {
    try {
      const { meta, body } = parseFrontmatter(await fs.readFile(location.path, "utf8"));
      return {
        skillId: location.skillId,
        scope: location.scope,
        fileName: location.fileName,
        path: location.path,
        projectName: location.projectName,
        name: meta.name?.trim() || location.slug,
        displayName: meta.display_name?.trim() || undefined,
        description: meta.description?.trim() || "",
        version: Number.parseInt(meta.version || "1", 10) || 1,
        created: meta.created || today(),
        updated: meta.updated || today(),
        body,
      };
    } catch {
      return null;
    }
  }

  async loadSkill(skillId: string): Promise<SkillDocument | null> {
    const location = (await this.locations()).find((item) => item.skillId === skillId);
    return location ? this.read(location) : null;
  }

  async loadIndex(scope?: SkillScope): Promise<Array<Omit<SkillDocument, "body" | "version">>> {
    const docs = (await Promise.all((await this.locations(scope)).map((location) => this.read(location))))
      .filter((doc): doc is SkillDocument => Boolean(doc));
    return docs.map(({ body: _body, version: _version, ...index }) => index).sort((a, b) => {
      if (a.updated !== b.updated) return b.updated.localeCompare(a.updated);
      if (a.created !== b.created) return b.created.localeCompare(a.created);
      if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
      return (a.displayName || a.name).localeCompare(b.displayName || b.name);
    });
  }

  async create(name: string, description: string, body: string, scope: SkillScope): Promise<SkillResult> {
    name = name.trim();
    description = description.trim();
    body = body.trim();
    if (!name) return { success: false, error: "Skill name is required." };
    if (!description) return { success: false, error: "Skill description is required." };
    if (!body) return { success: false, error: "Skill body is required." };
    const scanError = scanContent(`${name} ${description} ${body}`);
    if (scanError) return { success: false, error: scanError };
    const slug = slugify(name);
    if (!slug) return { success: false, error: "Skill name produces empty slug." };
    const root = scope === "global" ? this.options.globalSkillsDir : this.options.projectSkillsDir;
    if (!root) return { success: false, error: "Project skills require an active project." };
    const skillId = scope === "global" ? `global:${slug}` : `project:${this.options.projectName ?? ""}:${slug}`;
    const filePath = path.join(root, slug, "SKILL.md");
    return withFileMutationQueue(filePath, async () => {
    if ((await this.locations(scope)).some((location) => location.skillId === skillId)) {
      return {
        success: false,
        error: `Skill '${slug}' already exists (${skillId}). Use 'patch' or 'update' to update it.`,
        conflictType: "duplicate",
        similarSkillIds: [skillId],
        suggestedAction: "patch",
      };
    }
    if (scope === "global") {
      const candidateName = tokens(slug.replace(/-/g, " "));
      const candidateDescription = tokens(description);
      const scored = (await this.loadIndex("global")).map((skill) => ({
        skillId: skill.skillId,
        nameSimilarity: jaccard(candidateName, tokens((skill.displayName || skill.name).replace(/-/g, " "))),
        descriptionSimilarity: jaccard(candidateDescription, tokens(skill.description)),
      })).sort((a, b) => b.nameSimilarity - a.nameSimilarity || b.descriptionSimilarity - a.descriptionSimilarity);
      const similar = scored.filter((item) => item.nameSimilarity > 0.7 && item.descriptionSimilarity > 0.75).map((item) => item.skillId);
      if (similar.length) {
        return {
          success: false,
          error: `A similar global skill already exists (${similar[0]}). Enhance the existing skill with new learnings/failures using 'patch' or 'update' instead of creating a duplicate.`,
          conflictType: "similar",
          similarSkillIds: similar,
          suggestedAction: "patch",
        };
      }
      const nameCollision = scored.filter((item) => item.nameSimilarity > 0.7 && item.descriptionSimilarity <= 0.75).map((item) => item.skillId);
      if (nameCollision.length) {
        return {
          success: false,
          error: `A near-name global skill already exists (${nameCollision[0]}) but with different intent. Use a clearer differentiated name for the new skill, or patch/update the existing skill if the intent is actually the same.`,
          conflictType: "name-collision",
          similarSkillIds: nameCollision,
          suggestedAction: "rename",
        };
      }
      const shadowingPath = path.join(this.options.piGlobalSkillsDir, slug, "SKILL.md");
      if (path.resolve(this.options.piGlobalSkillsDir) !== path.resolve(this.options.globalSkillsDir) && await exists(shadowingPath)) {
        return {
          success: false,
          error: `Pi already loads a global skill named '${slug}' from ${shadowingPath}. Pi keys skills by name and loads its own root first, so a skill written to ${filePath} would never be the copy in effect. Choose a different name, or edit ${shadowingPath} directly.`,
          conflictType: "name-collision",
          suggestedAction: "rename",
        };
      }
    }
    const stamp = today();
    await atomicWrite(filePath, formatFrontmatter({
      name: slug,
      displayName: name,
      description,
      version: 1,
      created: stamp,
      updated: stamp,
      body,
    }));
    return {
      success: true,
      message: `Skill '${name}' created as a ${scope} skill.`,
      fileName: "SKILL.md",
      skillId,
      scope,
      path: filePath,
    };
    });
  }

  async edit(skillId: string, description: string, body: string): Promise<SkillResult> {
    description = description.trim();
    body = body.trim();
    if (!description && !body) return { success: false, error: "At least one of description or body is required." };
    const initial = await this.loadSkill(skillId);
    if (!initial) return { success: false, error: `Skill '${skillId}' not found.` };
    return withFileMutationQueue(initial.path, async () => {
      const doc = await this.loadSkill(skillId);
      if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };
      const scanError = scanContent(`${description || doc.description} ${body || doc.body}`);
      if (scanError) return { success: false, error: scanError };
      await atomicWrite(doc.path, formatFrontmatter({
        name: doc.name,
        displayName: doc.displayName,
        description: description || doc.description,
        version: doc.version + 1,
        created: doc.created,
        updated: today(),
        body: body || doc.body,
      }));
      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' updated.`,
        fileName: doc.fileName,
        skillId: doc.skillId,
        scope: doc.scope,
        path: doc.path,
      };
    });
  }

  async patch(skillId: string, section: string, rawContent: string): Promise<SkillResult> {
    const sectionName = normalizeSectionName(section);
    if (!sectionName) return { success: false, error: "section is required for patch." };
    const normalized = normalizePatchContent(sectionName, rawContent);
    if (!normalized.content) return { success: false, error: normalized.error };
    const normalizedContent = normalized.content;
    const scanError = scanContent(normalizedContent);
    if (scanError) return { success: false, error: scanError };
    const initial = await this.loadSkill(skillId);
    if (!initial) return { success: false, error: `Skill '${skillId}' not found.` };
    return withFileMutationQueue(initial.path, async () => {
      const doc = await this.loadSkill(skillId);
      if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };
      const lines = doc.body.split("\n");
      const result: string[] = [];
      let found = false;
      for (let index = 0; index < lines.length; index++) {
        const heading = lines[index].trim().match(/^##\s+(.+?)\s*$/);
        if (heading?.[1].trim().toLowerCase() === sectionName.toLowerCase()) {
          result.push(`## ${sectionName}`, ...normalizedContent.split("\n"));
          found = true;
          index++;
          while (index < lines.length && !lines[index].trim().startsWith("## ")) index++;
          if (index < lines.length) result.push(lines[index]);
        } else result.push(lines[index]);
      }
      if (!found) {
        if (result.length && result.at(-1) !== "") result.push("");
        result.push(`## ${sectionName}`, ...normalizedContent.split("\n"));
      }
      await atomicWrite(doc.path, formatFrontmatter({
        name: doc.name,
        displayName: doc.displayName,
        description: doc.description,
        version: doc.version + 1,
        created: doc.created,
        updated: today(),
        body: result.join("\n").trim(),
      }));
      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' section '${sectionName}' updated.`,
        fileName: doc.fileName,
        skillId: doc.skillId,
        scope: doc.scope,
        path: doc.path,
      };
    });
  }

  async delete(skillId: string): Promise<SkillResult> {
    const initial = await this.loadSkill(skillId);
    if (!initial) return { success: false, error: `Skill '${skillId}' not found.` };
    return withFileMutationQueue(initial.path, async () => {
      const doc = await this.loadSkill(skillId);
      if (!doc) return { success: false, error: `Skill '${skillId}' not found.` };
      await fs.unlink(doc.path);
      if (doc.fileName === "SKILL.md") {
        const stopDir = doc.scope === "global" ? this.options.globalSkillsDir : this.options.projectSkillsDir;
        let dir = path.dirname(doc.path);
        while (stopDir && dir.startsWith(stopDir) && dir !== stopDir) {
          try {
            if ((await fs.readdir(dir)).length) break;
            await fs.rmdir(dir);
            dir = path.dirname(dir);
          } catch {
            break;
          }
        }
      }
      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' deleted.`,
        fileName: doc.fileName,
        skillId: doc.skillId,
        scope: doc.scope,
        path: doc.path,
      };
    });
  }
}

function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    const dotGit = path.join(current, ".git");
    try {
      const stat = syncFs.statSync(dotGit);
      if (stat.isDirectory()) return current;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(syncFs.readFileSync(dotGit, "utf8"));
        if (!match) return current;
        const gitDir = path.resolve(current, match[1].trim());
        try {
          const commonDir = syncFs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
          if (commonDir) {
            const resolved = path.resolve(gitDir, commonDir);
            return path.basename(resolved) === ".git" ? path.dirname(resolved) : resolved;
          }
        } catch {
          const parent = path.dirname(gitDir);
          if (path.basename(parent) === "worktrees") return path.dirname(path.dirname(parent));
        }
        return current;
      }
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectNameFor(cwd: string, projectsRoot: string): string | null {
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  if (!resolved || resolved === "/" || resolved === home) return null;
  const cwdName = path.basename(resolved);
  if (!cwdName || cwdName === "." || cwdName === "..") return null;
  const repoRoot = findGitRepoRoot(resolved);
  if (!repoRoot || repoRoot === resolved || repoRoot === home) return cwdName;
  const repoName = path.basename(repoRoot);
  if (!repoName || repoName === cwdName) return cwdName;
  if (!syncFs.existsSync(path.join(projectsRoot, repoName)) && syncFs.existsSync(path.join(projectsRoot, cwdName))) return cwdName;
  return repoName;
}

function defaultOptions(cwd = process.cwd()): SkillManagerOptions {
  const configuredRoot = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentRoot = configuredRoot ? path.resolve(configuredRoot.replace(/^~(?=\/)/, os.homedir())) : path.join(os.homedir(), ".pi", "agent");
  let memoryRoot = path.join(agentRoot, "pi-hermes-memory");
  let projectsDirectory = "projects-memory";
  try {
    const config = JSON.parse(syncFs.readFileSync(path.join(agentRoot, "hermes-memory-config.json"), "utf8"));
    if (typeof config.memoryDir === "string" && config.memoryDir.trim()) {
      const value = config.memoryDir.trim().replace(/^~(?=\/)/, os.homedir());
      memoryRoot = path.isAbsolute(value) ? path.normalize(value) : path.resolve(agentRoot, value);
    }
    if (typeof config.projectsMemoryDir === "string" && /^[^/\\.][^/\\]*$/.test(config.projectsMemoryDir.trim())) {
      projectsDirectory = config.projectsMemoryDir.trim();
    }
  } catch {}
  const projectsRoot = path.join(agentRoot, projectsDirectory);
  const projectName = projectNameFor(cwd, projectsRoot);
  return {
    globalSkillsDir: path.join(memoryRoot, "skills"),
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: projectName ? path.join(projectsRoot, projectName, "skills") : null,
    projectName,
  };
}

export function createSkillManagerExtension(options?: Partial<SkillManagerOptions>) {
  return function skillManagerExtension(pi: ExtensionAPI): void {
    let manager = new SkillManager({ ...defaultOptions(), ...options });
    pi.on?.("resources_discover", async (event: { cwd: string }) => {
      const resolved = { ...defaultOptions(event.cwd), ...options };
      manager = new SkillManager(resolved);
      return { skillPaths: [resolved.globalSkillsDir, ...(resolved.projectSkillsDir ? [resolved.projectSkillsDir] : [])] };
    });
    pi.registerTool({
      name: "skill_manage",
      label: "Skill Manager",
      description: TOOL_DESCRIPTION + TOOL_DESCRIPTION_SUFFIX,
      promptSnippet: "Create, inspect, and update reusable procedures and patterns",
      promptGuidelines: [
        "Use the skill_manage tool after completing complex tasks that required trial and error or multiple tool calls.",
        "Use 'create' to save a new reusable procedure, 'patch' to update a section of an existing skill by skill_id, and 'update' for a full rewrite.",
        "Scope is required on create: choose scope='global' for transferable procedures and scope='project' when the workflow depends on this repo's paths, scripts, conventions, or deploy steps.",
        "Prefer structured fields for create/update/patch: when_to_use, procedure_steps, pitfalls, and verification_steps. The tool renders valid SKILL.md sections for you.",
        "For patch, pass section plus the matching structured field (e.g. section='Procedure' with procedure_steps). Avoid free-form content that is a JSON array/object string.",
        "Prefer 'update' for multi-section rewrites when patch content would be large or format-unstable.",
        "Use 'view' before patching or updating when you need to inspect an existing skill.",
        "Do NOT use skills for temporary task state — only for durable, reusable procedures.",
      ],
      renderResult: renderSkillResult,
      parameters: PARAMETERS,
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>;
        if (input.action === "create") {
          if (!input.name) return validationError("name is required for 'create' action.");
          if (!input.description) return validationError("description is required for 'create' action.");
          const body = buildBody(input);
          if (!body.body) return validationError(body.error!);
          if (!input.scope) return validationError("scope is required for 'create' action. Use 'global' or 'project'.");
          return textResult(await manager.create(String(input.name), String(input.description), body.body, input.scope as SkillScope));
        }
        if (input.action === "view") {
          if (!input.skill_id) {
            const skills = await manager.loadIndex();
            return { content: [{ type: "text", text: JSON.stringify({ success: true, skills }) }], details: { skills } };
          }
          const doc = await manager.loadSkill(String(input.skill_id));
          return doc
            ? textResult({ success: true, ...doc })
            : validationError(`Skill '${String(input.skill_id)}' not found.`);
        }
        if (input.action === "update" || input.action === "edit") {
          const action = String(input.action);
          if (!input.skill_id) return validationError(`skill_id is required for '${action}' action.`);
          const description = typeof input.description === "string" ? input.description.trim() : "";
          const content = typeof input.content === "string" ? input.content.trim() : "";
          const hasStructured = Boolean(
            (typeof input.when_to_use === "string" && input.when_to_use.trim())
            || normalizeTextList(input.procedure_steps).length
            || normalizeTextList(input.pitfalls).length
            || normalizeTextList(input.verification_steps).length,
          );
          const built = content ? { body: content } : buildBody(input);
          if (!description && !content && !hasStructured) {
            return validationError(`Provide description, content, or structured fields for '${action}'.`);
          }
          if (hasStructured && !built.body) return validationError(built.error!);
          return textResult(await manager.edit(String(input.skill_id), description, built.body ?? content));
        }
        if (input.action === "patch") {
          if (!input.skill_id) return validationError("skill_id is required for 'patch' action.");
          if (!input.section) return validationError("section is required for 'patch' action.");
          const section = String(input.section);
          const key = normalizeSectionName(section).toLowerCase();
          const whenToUse = typeof input.when_to_use === "string" ? input.when_to_use.trim() : "";
          const procedure = normalizeTextList(input.procedure_steps);
          const pitfalls = normalizeTextList(input.pitfalls);
          const verification = normalizeTextList(input.verification_steps);
          let content = typeof input.content === "string" ? input.content.trim() : "";
          if (key === "procedure" && procedure.length) content = formatOrderedList(procedure);
          else if (key === "pitfalls" && pitfalls.length) content = formatBulletList(pitfalls, "No notable pitfalls recorded yet.");
          else if (key === "verification" && verification.length) content = formatOrderedList(verification);
          else if ((key === "when to use" || key === "when_to_use") && whenToUse) content = whenToUse;
          else if (!content) {
            const supplied = [whenToUse ? "when" : "", procedure.length ? "procedure" : "", pitfalls.length ? "pitfalls" : "", verification.length ? "verification" : ""].filter(Boolean);
            if (supplied.length !== 1) {
              return validationError(supplied.length
                ? "For patch, provide content or exactly one structured field matching the target section (procedure_steps, pitfalls, verification_steps, or when_to_use). Use update for multi-section rewrites."
                : "content or a matching structured field is required for 'patch' action. Prefer procedure_steps/pitfalls/verification_steps/when_to_use.");
            }
            if (procedure.length) content = formatOrderedList(procedure);
            else if (pitfalls.length) content = formatBulletList(pitfalls, "No notable pitfalls recorded yet.");
            else if (verification.length) content = formatOrderedList(verification);
            else content = whenToUse;
          }
          return textResult(await manager.patch(String(input.skill_id), section, content));
        }
        if (input.action === "delete") {
          if (!input.skill_id) return validationError("skill_id is required for 'delete' action.");
          return textResult(await manager.delete(String(input.skill_id)));
        }
        return textResult({ success: false, error: `Unknown action '${String(input.action)}'. Use: create, view, patch, update, delete` });
      },
    });
  };
}

export default createSkillManagerExtension();
