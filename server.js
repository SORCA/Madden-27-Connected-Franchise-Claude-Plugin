// Madden Franchise MCP server
// 1) Receives Madden Companion App exports at  https://<your-app>/<SECRET_KEY>
// 2) Serves the league data to Claude at        https://<your-app>/mcp/<SECRET_KEY>

import express from "express";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY;
const DATA_DIR = process.env.DATA_DIR || "./data";

if (!SECRET || SECRET.length < 12 || !/^[A-Za-z0-9_-]+$/.test(SECRET)) {
  console.error("SECRET_KEY must be set: 12+ characters, letters/numbers/dashes/underscores only.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEV = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };

// ---------------- storage ----------------

let players = new Map();
let teams = [];
let exportsLog = [];

function fileFor(exportPath) {
  const safe = exportPath.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return path.join(DATA_DIR, `${safe || "root"}.json`);
}

function loadAll() {
  const docs = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      docs.push({ file: f, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) });
    } catch {
      /* skip unreadable file */
    }
  }
  docs.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt))); // newest wins

  const nextPlayers = new Map();
  let nextTeams = [];
  for (const doc of docs) {
    const body = doc.body;
    if (!body || typeof body !== "object") continue;
    if (Array.isArray(body.rosterInfoList)) {
      const isFA = /freeagent/i.test(doc.path || "");
      for (const p of body.rosterInfoList) {
        const key = String(p.rosterId ?? `${p.firstName}-${p.lastName}-${p.teamId}`);
        nextPlayers.set(key, { ...p, _freeAgent: isFA });
      }
    }
    if (Array.isArray(body.leagueTeamInfoList)) nextTeams = body.leagueTeamInfoList;
  }
  players = nextPlayers;
  teams = nextTeams;
  exportsLog = docs
    .map((d) => ({ path: d.path, receivedAt: d.receivedAt }))
    .reverse();
}
loadAll();

// ---------------- helpers ----------------

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const fullName = (p) => `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
const ovr = (p) => p.playerBestOvr ?? p.overallRating ?? p.playerSchemeOvr ?? null;

function teamLabel(p) {
  if (p._freeAgent) return "Free Agent";
  const t = teams.find((t) => t.teamId === p.teamId);
  return t ? t.displayName || t.nickName || t.abbrName || String(p.teamId) : String(p.teamId ?? "?");
}

function summary(p) {
  return {
    name: fullName(p),
    pos: p.position,
    team: teamLabel(p),
    age: p.age,
    ovr: ovr(p),
    dev: DEV[p.devTrait] ?? p.devTrait,
    rosterId: p.rosterId,
  };
}

function ratings(p) {
  return Object.fromEntries(
    Object.entries(p)
      .filter(([k, v]) => /Rating$/.test(k) && typeof v === "number")
      .sort((a, b) => b[1] - a[1])
  );
}

function details(p) {
  const other = Object.fromEntries(
    Object.entries(p).filter(
      ([k, v]) => !/Rating$/.test(k) && !k.startsWith("_") && (v === null || typeof v !== "object")
    )
  );
  return { ...summary(p), ratings: ratings(p), otherFields: other };
}

function findPlayers(query) {
  const q = norm(query);
  const all = [...players.values()];
  const byId = all.filter((p) => String(p.rosterId) === String(query).trim());
  if (byId.length) return byId;
  const exact = all.filter((p) => norm(fullName(p)) === q);
  if (exact.length) return exact;
  return all.filter((p) => norm(fullName(p)).includes(q) || norm(p.lastName) === q);
}

function findTeam(query) {
  const q = norm(query);
  const strings = (t) => Object.values(t).filter((v) => typeof v === "string").map(norm);
  return (
    teams.find((t) => String(t.teamId) === String(query).trim()) ||
    teams.find((t) => strings(t).includes(q)) ||
    teams.find((t) => strings(t).some((s) => s.includes(q)))
  );
}

const out = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const noData = () =>
  out({ message: "No roster data yet. Export Rosters (and League Info) from the Madden Companion App." });

// ---------------- MCP tools ----------------

function buildServer() {
  const server = new McpServer({ name: "madden-franchise", version: "1.0.0" });

  server.tool(
    "search_players",
    "Search every player in the franchise (all teams and free agency) by full or partial name. Returns name, position, team, age, overall and dev trait.",
    { name: z.string().describe("Full or partial player name") },
    async ({ name }) => {
      if (!players.size) return noData();
      const hits = findPlayers(name);
      if (!hits.length) return out({ message: `No players match "${name}".` });
      return out(hits.slice(0, 25).map(summary));
    }
  );

  server.tool(
    "get_player",
    "Get the full, exact ratings and details (contract, age, dev trait, etc.) for a player in the franchise, by name or rosterId.",
    { name: z.string().describe("Player name or rosterId") },
    async ({ name }) => {
      if (!players.size) return noData();
      const hits = findPlayers(name);
      if (!hits.length) return out({ message: `No players match "${name}".` });
      if (hits.length > 3)
        return out({ message: "Several matches; be more specific or use a rosterId.", matches: hits.slice(0, 25).map(summary) });
      return out(hits.map(details));
    }
  );

  server.tool(
    "compare_players",
    "Compare 2-5 players side by side on every rating.",
    { names: z.array(z.string()).min(2).max(5).describe("Player names or rosterIds") },
    async ({ names }) => {
      if (!players.size) return noData();
      const picked = [];
      const missing = [];
      for (const n of names) {
        const p = findPlayers(n)[0];
        p ? picked.push(p) : missing.push(n);
      }
      const keys = [...new Set(picked.flatMap((p) => Object.keys(ratings(p))))].sort();
      const table = keys.map((k) => ({
        rating: k.replace(/Rating$/, ""),
        ...Object.fromEntries(picked.map((p) => [fullName(p), p[k] ?? null])),
      }));
      return out({ players: picked.map(summary), ratings: table, notFound: missing });
    }
  );

  server.tool(
    "get_team_roster",
    "List a team's roster (name, position, age, overall, dev trait), optionally filtered by position.",
    {
      team: z.string().describe("Team name, city, abbreviation or teamId, e.g. 'Packers' or 'GB'"),
      position: z.string().optional().describe("Optional position filter, e.g. 'WR', 'TE', 'HB'"),
    },
    async ({ team, position }) => {
      if (!players.size) return noData();
      const t = findTeam(team);
      if (!t) return out({ message: `No team matches "${team}". Export League Info so team names are known.` });
      let list = [...players.values()].filter((p) => !p._freeAgent && p.teamId === t.teamId);
      if (position) list = list.filter((p) => norm(p.position) === norm(position));
      list.sort((a, b) => String(a.position).localeCompare(String(b.position)) || (ovr(b) ?? 0) - (ovr(a) ?? 0));
      return out({ team: t.displayName || t.nickName || t.abbrName, count: list.length, players: list.map(summary) });
    }
  );

  server.tool(
    "get_free_agents",
    "List free agents, best first, optionally filtered by position and minimum overall.",
    {
      position: z.string().optional(),
      min_ovr: z.number().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ position, min_ovr, limit }) => {
      if (!players.size) return noData();
      let list = [...players.values()].filter((p) => p._freeAgent);
      if (position) list = list.filter((p) => norm(p.position) === norm(position));
      if (min_ovr != null) list = list.filter((p) => (ovr(p) ?? 0) >= min_ovr);
      list.sort((a, b) => (ovr(b) ?? 0) - (ovr(a) ?? 0));
      return out(list.slice(0, limit ?? 30).map(summary));
    }
  );

  server.tool(
    "data_status",
    "Show what league data has been received and when (use to check if rosters are up to date).",
    {},
    async () =>
      out({
        players: players.size,
        teams: teams.length,
        recentExports: exportsLog.slice(0, 40),
      })
  );

  return server;
}

// ---------------- HTTP routes ----------------

const app = express();

app.get("/health", (req, res) =>
  res.json({ ok: true, players: players.size, teams: teams.length, exportsReceived: exportsLog.length })
);

// Claude connector endpoint
app.post("/mcp/:key", express.json({ limit: "10mb" }), async (req, res) => {
  if (req.params.key !== SECRET) return res.status(404).end();
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.all("/mcp/:key", (req, res) =>
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null })
);

// Companion App export receiver: the app appends paths like /ps5/12345/team/7/roster
app.all("/:key", (req, res) => (req.params.key === SECRET ? res.json({ ok: true }) : res.status(404).end()));
app.post("/:key/*", express.raw({ type: () => true, limit: "200mb" }), (req, res) => {
  if (req.params.key !== SECRET) return res.status(404).end();
  const exportPath = req.params[0];
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  fs.writeFileSync(fileFor(exportPath), JSON.stringify({ path: exportPath, receivedAt: new Date().toISOString(), body }));
  const count = Array.isArray(body?.rosterInfoList) ? ` — ${body.rosterInfoList.length} players` : "";
  console.log(`Export received: ${exportPath} (${raw.length} bytes)${count}`);
  loadAll();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Listening on ${PORT}. Players loaded: ${players.size}`));
