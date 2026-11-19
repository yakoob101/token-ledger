// Reads the local OpenCode database and writes index.html, data.json and usage.csv.
// Run: node collect.mjs   (set OPENCODE_DB to read another database)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.OPENCODE_DB || join(homedir(), ".local/share/opencode/opencode.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const sessions = db.prepare(`
  select s.id, s.title, s.directory, s.model, s.time_created, s.time_updated,
         s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.cost,
         p.worktree, p.name as project_name
  from session_v2 s left join project p on p.id = s.project_id
  order by s.time_created
`).all();

const freshOf = (s) => s.tokens_input + s.tokens_output + s.tokens_reasoning;
const totalOf = (s) => freshOf(s) + s.tokens_cache_read;
const projectName = (s) => s.project_name || basename(s.worktree || s.directory || "unknown");

const grand = sessions.reduce((a, s) => a + totalOf(s), 0);
const sum = (key) => sessions.reduce((a, s) => a + s[key], 0);
const fresh = sum("tokens_input") + sum("tokens_output") + sum("tokens_reasoning");
const cache = sum("tokens_cache_read");
const cost = sessions.reduce((a, s) => a + (s.cost || 0), 0);
const ratio = grand / fresh;

const n = (v) => Math.round(v).toLocaleString("en-US");
const k = (v) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : `${Math.round(v)}`;
const pct = (v, of) => (v / of * 100).toFixed(1);
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const shortDate = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };

// projects, largest first
const byProject = new Map();
for (const s of sessions) {
  const key = s.project_name || s.worktree || s.directory;
  const p = byProject.get(key) || { name: projectName(s), sessions: 0, input: 0, output: 0, reasoning: 0, cache: 0, last: 0 };
  p.sessions++;
  p.input += s.tokens_input; p.output += s.tokens_output; p.reasoning += s.tokens_reasoning; p.cache += s.tokens_cache_read;
  p.last = Math.max(p.last, s.time_updated);
  byProject.set(key, p);
}
const projects = [...byProject.values()]
  .map((p) => ({ ...p, fresh: p.input + p.output + p.reasoning, total: p.input + p.output + p.reasoning + p.cache }))
  .sort((a, b) => b.total - a.total);

// one session row's tokens spread over the days its messages ran (assistant messages only)
const msgStmt = db.prepare("select time_created from session_message where session_id = ? and type = 'assistant' order by time_created");
const byDay = new Map();
for (const s of sessions) {
  const msgs = msgStmt.all(s.id);
  const buckets = new Map();
  for (const m of msgs) buckets.set(dayKey(m.time_created), (buckets.get(dayKey(m.time_created)) || 0) + 1);
  if (!buckets.size) buckets.set(dayKey(s.time_created), 1);
  const count = msgs.length || 1;
  for (const [key, hits] of buckets) {
    const d = byDay.get(key) || { fresh: 0, cache: 0, sessions: 0 };
    d.fresh += (freshOf(s) * hits) / count;
    d.cache += (s.tokens_cache_read * hits) / count;
    d.sessions++;
    byDay.set(key, d);
  }
}

const first = dayKey(sessions[0].time_created);
const last = dayKey(Math.max(...sessions.map((s) => s.time_updated)));
const days = [];
for (let t = new Date(`${first}T12:00:00`); dayKey(t.getTime()) <= last; t.setDate(t.getDate() + 1)) {
  const key = dayKey(t.getTime());
  const d = byDay.get(key) || { fresh: 0, cache: 0 };
  days.push({ date: key, fresh: Math.round(d.fresh), cache: Math.round(d.cache), total: Math.round(d.fresh + d.cache) });
}
const peak = days.reduce((a, d) => (d.total > a.total ? d : a), days[0]);
const dayMax = Math.max(1, ...days.map((d) => d.total));

const rangeLabel = (() => {
  const a = new Date(`${days[0].date}T12:00:00`);
  const b = new Date(`${days[days.length - 1].date}T12:00:00`);
  const month = (d) => MONTHS[d.getMonth()];
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}&ndash;${b.getDate()} ${month(b)} ${b.getFullYear()}`;
  return `${a.getDate()} ${month(a)} &ndash; ${b.getDate()} ${month(b)} ${b.getFullYear()}`;
})();

// ---- markup
const SPLIT_STEPS = [100, 68, 44, 26, 14];
const splitColor = (i) => `color-mix(in oklab, var(--ink) ${SPLIT_STEPS[i % SPLIT_STEPS.length]}%, var(--bg))`;

const heroRows = projects.slice(0, 3).map((p, i) => `                <div class="d-row"><span class="d-thumb" style="background:${["#dfe6d8", "#efe9c9", "#dbe4e6"][i % 3]}"></span><div><b>${esc(p.name)}</b><small>${p.sessions} session${p.sessions > 1 ? "s" : ""}</small></div><span class="num">${k(p.total)}</span><span class="d-chip">${pct(p.cache, p.total)}% cache</span></div>`).join("\n");

const projectSplit = projects.map((p, i) => `        <i style="width:${pct(p.total, grand)}%; background:${splitColor(i)}"></i>`).join("\n");

const projectRows = projects.map((p, i) => `        <li>
          <p class="tl-proj__total"><b>${n(p.total)}</b> tokens &middot; ${esc(p.name)}</p>
          <p class="tl-proj__meta">${pct(p.total, grand)}% of all &middot; ${p.sessions} session${p.sessions > 1 ? "s" : ""} &middot; ${k(p.cache)} cache read &middot; last used ${shortDate(p.last)}</p>
        </li>`).join("\n");

const projectSplitAlt = `Share of all ${n(grand)} tokens: ${projects.map((p) => `${p.name} ${pct(p.total, grand)}%`).join(", ")}`;

const dailyBars = days.map((d) => {
  const v = (d.total / dayMax) * 100;
  const cacheShare = d.total ? (d.cache / d.total) * 100 : 0;
  const label = String(new Date(`${d.date}T12:00:00`).getDate());
  const cls = ["tl-day", d.total === 0 ? "tl-day--zero" : "", d.date === peak.date ? "tl-day--peak" : ""].filter(Boolean).join(" ");
  return `        <div class="${cls}" style="--v:${v.toFixed(1)}"><div class="tl-day__fill"><i class="tl-day__cache" style="--f:${cacheShare.toFixed(1)}"></i><i class="tl-day__fresh" style="--f:${(100 - cacheShare).toFixed(1)}"></i></div><span class="tl-day__label">${label}</span></div>`;
}).join("\n");

const ratioNum = Math.max(2, Math.round(ratio));
const statementWords = [
  `<span class="tl-word" data-word>One</span> <span class="tl-word" data-word>fresh</span> <span class="tl-word" data-word>token</span> <span class="tl-word" data-word>in</span> <span class="tl-word" data-word>every</span> <span class="tl-word" data-word>${ratioNum}.</span>`,
  `<span class="tl-word tl-word--muted" data-word>The</span> <span class="tl-word tl-word--muted" data-word>other</span> <span class="tl-word tl-word--muted" data-word>${ratioNum - 1}</span> <span class="tl-word tl-word--muted" data-word>come</span> <span class="tl-word tl-word--muted" data-word>back</span> <span class="tl-word tl-word--muted" data-word>from</span> <span class="tl-word tl-word--muted" data-word>cache.</span>`,
].map((s) => `<span class="tl-say">${s}</span>`).join(" ");
const dots = Array.from({ length: ratioNum }, (_, i) => `<i${i === 0 ? ' class="is-fresh"' : ""}></i>`).join("");

const sorted = [...sessions].sort((a, b) => totalOf(b) - totalOf(a));
const barRows = sorted.slice(0, 6).map((s) => ({
  title: (s.title || "Untitled session").slice(0, 30),
  value: n(totalOf(s)),
  total: totalOf(s),
}));
const rest = sorted.slice(6);
if (rest.length) {
  barRows.push({
    title: `${rest.length} smaller session${rest.length > 1 ? "s" : ""}`,
    value: n(rest.reduce((a, s) => a + totalOf(s), 0)),
    total: rest.reduce((a, s) => a + totalOf(s), 0),
  });
}
// ranked bars, drawn as one svg: its text stays readable, and the whole block is the section's picture
const barMax = Math.max(...barRows.map((r) => r.total));
const rows = barRows.length, band = 100 / rows;
const sessionChart = `      <svg class="tl-sbar" width="100%" aria-labelledby="sessions-h">
${barRows.map((r, i) => `        <text class="tl-sbar__name" x="0" y="${((i + 0.36) * band).toFixed(2)}%">${esc(r.title)}</text>
        <text class="tl-sbar__value" x="100%" y="${((i + 0.36) * band).toFixed(2)}%" text-anchor="end">${r.value}</text>
        <rect class="tl-sbar__track" x="0" y="${((i + 0.52) * band).toFixed(2)}%" width="100%" height="${(band * 0.34).toFixed(2)}%" rx="6"/>
        <rect class="tl-sbar__fill" x="0" y="${((i + 0.52) * band).toFixed(2)}%" width="${((r.total / barMax) * 100).toFixed(1)}%" height="${(band * 0.34).toFixed(2)}%" rx="6"/>`).join("\n")}
      </svg>`;

// ---- files
const values = {
  TOTAL: n(grand), TOTAL_K: k(grand), FRESH: n(fresh), FRESH_K: k(fresh), CACHE: n(cache), CACHE_K: k(cache),
  CACHE_PCT: pct(cache, grand), FRESH_PCT: pct(fresh, grand),
  INPUT: n(sum("tokens_input")), INPUT_K: k(sum("tokens_input")), INPUT_PCT: pct(sum("tokens_input"), fresh),
  OUTPUT: n(sum("tokens_output")), OUTPUT_K: k(sum("tokens_output")), OUTPUT_PCT: pct(sum("tokens_output"), fresh),
  REASONING: n(sum("tokens_reasoning")), REASONING_K: k(sum("tokens_reasoning")), REASONING_PCT: pct(sum("tokens_reasoning"), fresh),
  RATIO: `1 in ${ratioNum} fresh`, RATIO_NUM: `${ratioNum}`, RATIO_MINUS_ONE: `${ratioNum - 1}`, DAYS: `${days.length}`,
  RANGE: rangeLabel, PEAK_DAY: shortDate(new Date(`${peak.date}T12:00:00`).getTime()), PEAK_K: k(peak.total),
  SESSION_COUNT: `${sessions.length}`, PROJECT_COUNT: `${projects.length}`,
  HERO_ROWS: heroRows, DAILY_BARS: dailyBars, STATEMENT: statementWords, DOTS: dots,
  PROJECT_SPLIT: projectSplit, PROJECT_SPLIT_ALT: projectSplitAlt, PROJECT_ROWS: projectRows,
  SESSION_CHART: sessionChart,
  UPDATED: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
};

const template = readFileSync(join(here, "index.template.html"), "utf8");
const html = template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
for (const left of html.matchAll(/\{\{(\w+)\}\}/g)) console.warn("unfilled placeholder", left[1]);
writeFileSync(join(here, "index.html"), html);

writeFileSync(join(here, "data.json"), JSON.stringify({
  generated: new Date().toISOString(),
  database: dbPath,
  totals: {
    total: grand, fresh, cache, cost,
    input: sum("tokens_input"), output: sum("tokens_output"), reasoning: sum("tokens_reasoning"),
    sessions: sessions.length, projects: projects.length,
  },
  projects,
  days,
  sessions: sorted.map((s) => ({
    id: s.id, title: s.title, project: s.project_name || projectName(s), model: s.model,
    created: new Date(s.time_created).toISOString(), updated: new Date(s.time_updated).toISOString(),
    input: s.tokens_input, output: s.tokens_output, reasoning: s.tokens_reasoning,
    cacheRead: s.tokens_cache_read, total: totalOf(s), cost: s.cost,
  })),
}, null, 2));

const csv = [
  ["project", "session", "session_id", "model", "created", "input", "output", "reasoning", "cache_read", "total", "cost_usd"],
  ...sorted.map((s) => [s.project_name || projectName(s), s.title || "Untitled session", s.id, s.model || "",
    new Date(s.time_created).toISOString(), s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, totalOf(s), s.cost || 0]),
  ["TOTAL", "", "", "", "", sum("tokens_input"), sum("tokens_output"), sum("tokens_reasoning"), cache, grand, cost],
].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
writeFileSync(join(here, "usage.csv"), csv + "\r\n");

console.log(`${n(grand)} tokens, ${sessions.length} sessions, ${projects.length} projects, ${pct(cache, grand)}% cache -> index.html, data.json, usage.csv`);
