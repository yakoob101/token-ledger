import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const dbPath = process.env.OPENCODE_DB || join(homedir(), ".local/share/opencode/opencode.db");
const db = new DatabaseSync(dbPath, { readOnly: true });

const all = db.prepare(`
  select s.id, s.parent_id, s.title, s.project_id, s.directory, s.model, s.time_created, s.time_updated,
         s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read, s.cost,
         p.worktree, p.name as project_name
  from session_v2 s left join project p on p.id = s.project_id
  order by s.time_created
`).all();

const projectName = (s) => s.project_name || basename(s.worktree || s.directory || "unknown");
const fresh = (s) => s.tokens_input + s.tokens_output + s.tokens_reasoning;
const total = (s) => fresh(s) + s.tokens_cache_read;

const totals = all.reduce((a, s) => ({
  input: a.input + s.tokens_input, output: a.output + s.tokens_output,
  reasoning: a.reasoning + s.tokens_reasoning, cache: a.cache + s.tokens_cache_read,
  cost: a.cost + s.cost, sessions: a.sessions + 1,
}), { input: 0, output: 0, reasoning: 0, cache: 0, cost: 0, sessions: 0 });

const projects = new Map();
for (const s of all) {
  const k = s.project_id || s.directory;
  const p = projects.get(k) || { name: projectName(s), path: s.worktree || s.directory, sessions: 0, input: 0, output: 0, reasoning: 0, cache: 0 };
  p.sessions++; p.input += s.tokens_input; p.output += s.tokens_output; p.reasoning += s.tokens_reasoning; p.cache += s.tokens_cache_read;
  projects.set(k, p);
}
const projectList = [...projects.values()].map((p) => ({ ...p, fresh: p.input + p.output + p.reasoning, total: p.input + p.output + p.reasoning + p.cache })).sort((a, b) => b.total - a.total);

const msgStmt = db.prepare("select time_created from session_message where session_id = ? and type = 'assistant' order by time_created");
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const days = new Map();
for (const s of all) {
  const msgs = msgStmt.all(s.id);
  const buckets = new Map();
  for (const m of msgs) buckets.set(dayKey(m.time_created), (buckets.get(dayKey(m.time_created)) || 0) + 1);
  if (!buckets.size) buckets.set(dayKey(s.time_created), 1);
  const n = msgs.length || 1;
  for (const [k, c] of buckets) {
    const d = days.get(k) || { cache: 0, fresh: 0, sessions: 0 };
    d.cache += (s.tokens_cache_read * c) / n;
    d.fresh += (fresh(s) * c) / n;
    d.sessions += 1;
    days.set(k, d);
  }
}
const first = dayKey(all[0].time_created), last = dayKey(all[all.length - 1].time_updated);
const dayList = [];
for (let t = new Date(first + "T12:00:00"); dayKey(t.getTime()) <= last; t.setDate(t.getDate() + 1)) {
  const k = dayKey(t.getTime());
  const d = days.get(k) || { cache: 0, fresh: 0, sessions: 0 };
  dayList.push({ date: k, cache: Math.round(d.cache), fresh: Math.round(d.fresh), sessions: d.sessions });
}

console.log("totals", totals, "grand", totals.input + totals.output + totals.reasoning + totals.cache, "fresh", totals.input + totals.output + totals.reasoning);
console.log("ratio 1 in", ((totals.input + totals.output + totals.reasoning + totals.cache) / (totals.input + totals.output + totals.reasoning)).toFixed(1));
console.log("projects", projectList);
console.log("days", dayList);
console.log("range", first, last);
console.log("models", db.prepare("select model, count(*) n, sum(tokens_input+tokens_output+tokens_reasoning) fresh, sum(tokens_cache_read) cache from session_v2 group by model").all());
console.log("sessions", all.length, "roots", all.filter((s) => !s.parent_id).length);
const cacheShare = totals.cache / (totals.cache + totals.input + totals.output + totals.reasoning);
console.log("cacheShare", (cacheShare * 100).toFixed(2), "%");
