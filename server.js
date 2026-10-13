// Madden Franchise MCP server
//  1) Receives Madden Companion App exports at  https://<your-app>/<SECRET_KEY>
//  2) Serves the league data to Claude at        https://<your-app>/mcp/<SECRET_KEY>

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const VERSION = "2.1.0";
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY;
const DATA_DIR = process.env.DATA_DIR || "./data";

if (!SECRET || SECRET.length < 12 || !/^[A-Za-z0-9_-]+$/.test(SECRET)) {
  console.error("SECRET_KEY must be set: 12+ characters, letters/numbers/dashes/underscores only.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const secretBuf = Buffer.from(SECRET);
const keyOk = (key) => {
  const b = Buffer.from(String(key ?? ""));
  return b.length === secretBuf.length && crypto.timingSafeEqual(b, secretBuf);
};

const DEV = { 0: "Normal", 1: "Star", 2: "Superstar", 3: "X-Factor" };
const POSITION_GROUPS = {
  OL: ["LT", "LG", "C", "RG", "RT"],
  OT: ["LT", "RT"],
  OG: ["LG", "RG"],
  IOL: ["LG", "C", "RG"],
  EDGE: ["LEDG", "REDG", "LE", "RE"],
  DE: ["LEDG", "REDG", "LE", "RE"],
  DL: ["DT", "LEDG", "REDG", "LE", "RE"],
  LB: ["MIKE", "WILL", "SAM", "MLB", "LOLB", "ROLB"],
  OLB: ["WILL", "SAM", "LOLB", "ROLB"],
  MLB: ["MIKE", "MLB"],
  S: ["FS", "SS"],
  DB: ["CB", "FS", "SS"],
  RB: ["HB", "FB"],
  ST: ["K", "P", "LS"],
};

// ---------------- storage ----------------
// Every export is saved as one JSON file per export path (a re-export of the
// same path replaces the old file). Everything is also kept in memory and the
// indexes below are rebuilt from memory whenever an export arrives.

const docs = new Map(); // exportPath -> { path, receivedAt, body }

let players = new Map(); // rosterId -> player
let teams = [];
let standings = [];
let games = [];
let playerStats = []; // { rosterId, category, stage, seasonIndex, weekIndex, row }
let listKeysSeen = new Set();

function fileFor(exportPath) {
  const safe = exportPath.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return path.join(DATA_DIR, `${safe || "root"}.json`);
}

function loadFromDisk() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
      if (doc && doc.path) docs.set(doc.path, doc);
    } catch (err) {
      console.warn(`Skipping unreadable file ${f}: ${err.message}`);
    }
  }
}

function saveDoc(doc) {
  const file = fileFor(doc.path);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file); // atomic, so a crash can't leave a half-written file
  docs.set(doc.path, doc);
}

const statCategory = (listKey) =>
  listKey.replace(/^player/, "").replace(/StatInfoList$/, "").toLowerCase() || listKey;
const stageFromPath = (p) => (/\/pre\//i.test(p) ? "preseason" : "regular");

function rebuild() {
  const ordered = [...docs.values()].sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  const nextPlayers = new Map();
  const nextGames = new Map();
  const nextStats = [];
  const keys = new Set();
  let nextTeams = [];
  let nextStandings = [];

  for (const doc of ordered) {
    const body = doc.body;
    if (!body || typeof body !== "object") continue;
    for (const [k, v] of Object.entries(body)) if (Array.isArray(v)) keys.add(k);

    if (Array.isArray(body.rosterInfoList)) {
      const fromFaExport = /freeagent/i.test(doc.path);
      for (const p of body.rosterInfoList) {
        const id = String(p.rosterId ?? `${p.firstName}-${p.lastName}-${p.teamId}`);
        // newest export wins, so a player who was signed/traded/released ends up where the latest export says
        nextPlayers.set(id, { ...p, _freeAgent: fromFaExport || p.isFreeAgent === true });
      }
    }
    if (Array.isArray(body.leagueTeamInfoList)) nextTeams = body.leagueTeamInfoList;
    if (Array.isArray(body.teamStandingInfoList)) nextStandings = body.teamStandingInfoList;
    if (Array.isArray(body.gameScheduleInfoList)) {
      for (const g of body.gameScheduleInfoList) {
        const id = g.scheduleId ?? `${g.seasonIndex}-${g.weekIndex}-${g.homeTeamId}-${g.awayTeamId}`;
        nextGames.set(String(id), { ...g, _stage: stageFromPath(doc.path) });
      }
    }
    for (const [k, v] of Object.entries(body)) {
      if (!/^player.*StatInfoList$/.test(k) || !Array.isArray(v)) continue;
      for (const row of v) {
        if (row?.rosterId == null) continue;
        nextStats.push({
          rosterId: String(row.rosterId),
          category: statCategory(k),
          stage: stageFromPath(doc.path),
          seasonIndex: row.seasonIndex ?? null,
          weekIndex: row.weekIndex ?? null,
          row,
        });
      }
    }
  }

  // A weekly stat export replaces the same week's file, but guard against duplicates anyway
  const dedup = new Map();
  for (const s of nextStats) dedup.set(`${s.rosterId}|${s.category}|${s.stage}|${s.seasonIndex}|${s.weekIndex}`, s);

  players = nextPlayers;
  teams = nextTeams;
  standings = nextStandings;
  games = [...nextGames.values()];
  playerStats = [...dedup.values()];
  listKeysSeen = keys;
}

loadFromDisk();
rebuild();

// ---------------- helpers ----------------

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const fullName = (p) => `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
const ovr = (p) => p.playerBestOvr ?? p.overallRating ?? p.playerSchemeOvr ?? null;
const teamById = (id) => teams.find((t) => t.teamId === id);
const teamName = (t) => (t ? t.displayName || t.nickName || t.abbrName || String(t.teamId) : null);
const teamNameById = (id) => teamName(teamById(id)) ?? String(id ?? "?");

function rosterStatus(p) {
  if (p._freeAgent) return "Free Agent";
  if (p.isOnIR) return "IR";
  if (p.isOnPracticeSquad) return "Practice Squad";
  return "Active";
}

function summary(p) {
  return {
    name: fullName(p),
    pos: p.position,
    team: p._freeAgent ? "Free Agent" : teamNameById(p.teamId),
    status: rosterStatus(p),
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
      .map(([k, v]) => [k.replace(/Rating$/, ""), v])
      .sort((a, b) => b[1] - a[1])
  );
}

const pick = (p, keys) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
const CONTRACT_KEYS = [
  "contractLength", "contractYearsLeft", "contractSalary", "contractBonus", "capHit",
  "capReleasePenalty", "capReleaseNetSavings", "desiredSalary", "desiredBonus", "desiredLength", "reSignStatus",
];
const BIO_KEYS = [
  "jerseyNum", "height", "weight", "college", "homeTown", "homeState", "birthYear", "birthMonth", "birthDay",
  "rookieYear", "yearsPro", "draftRound", "draftPick", "legacyScore",
];
const STATUS_KEYS = ["isOnPracticeSquad", "isOnIR", "injuryType", "injuryLength", "isFreeAgent", "isActive"];
const GRADE_KEYS = ["playerSchemeOvr", "teamSchemeOvr", "physicalGrade", "sizeGrade", "intangibleGrade", "productionGrade", "durabilityGrade", "experiencePoints", "skillPoints"];
const HIDDEN_KEYS = new Set(["presentationId", "portraitId", "firstName", "lastName", "position", "age", "rosterId", "teamId", "devTrait", "playerBestOvr"]);

function details(p) {
  const used = new Set([...CONTRACT_KEYS, ...BIO_KEYS, ...STATUS_KEYS, ...GRADE_KEYS, ...HIDDEN_KEYS]);
  const traits = {};
  const other = {};
  for (const [k, v] of Object.entries(p)) {
    if (used.has(k) || k.startsWith("_") || /Rating$/.test(k) || (v !== null && typeof v === "object")) continue;
    if (/Trait$/.test(k)) {
      if (v) traits[k.replace(/Trait$/, "")] = v; // only non-default traits
    } else other[k] = v;
  }
  return {
    ...summary(p),
    ratings: ratings(p),
    contract: pick(p, CONTRACT_KEYS),
    injury: p.injuryLength ? pick(p, ["injuryType", "injuryLength", "isOnIR"]) : null,
    bio: pick(p, BIO_KEYS),
    grades: pick(p, GRADE_KEYS),
    traits,
    other,
  };
}

function findPlayers(query) {
  const raw = String(query).trim();
  const q = norm(raw);
  const all = [...players.values()];
  const byId = all.filter((p) => String(p.rosterId) === raw);
  if (byId.length) return byId;
  const exact = all.filter((p) => norm(fullName(p)) === q);
  if (exact.length) return exact;
  const last = all.filter((p) => norm(p.lastName) === q);
  const partial = all.filter((p) => norm(fullName(p)).includes(q));
  return [...new Set([...last, ...partial])].sort((a, b) => (ovr(b) ?? 0) - (ovr(a) ?? 0));
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

function positionMatcher(position) {
  if (!position) return () => true;
  const wanted = String(position)
    .split(/[,/ ]+/)
    .filter(Boolean)
    .flatMap((x) => POSITION_GROUPS[x.toUpperCase()] ?? [x])
    .map(norm);
  return (p) => wanted.includes(norm(p.position));
}

function ratingKey(sortBy) {
  const q = norm(sortBy).replace(/rating$/, "");
  if (!q || ["ovr", "overall"].includes(q)) return null;
  for (const p of players.values())
    for (const k of Object.keys(p)) if (/Rating$/.test(k) && norm(k.replace(/Rating$/, "")) === q) return k;
  return undefined;
}

const out = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const noData = () =>
  out({ message: "No roster data yet. Export League Info and Rosters from the Madden Companion App." });
const needTeams = (team) =>
  out({ message: `No team matches "${team}". If this keeps happening, export League Info so team names are known.` });

// Sum a player's weekly stat rows into season totals.
// Rates/percentages can't be summed, so they're left out of totals; "longest" fields take the max.
function aggregateStats(rows) {
  const totals = {};
  for (const { row } of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v !== "number" || /(Index|Id)$|^rosterId$|^statId$/i.test(k)) continue;
      if (/Pct|Per|Avg|Rating/i.test(k)) continue;
      if (/Long/i.test(k)) totals[k] = Math.max(totals[k] ?? -Infinity, v);
      else totals[k] = (totals[k] ?? 0) + v;
    }
  }
  return totals;
}

// ---------------- contracts ----------------
// Companion App money fields: capHit / capReleasePenalty / capReleaseNetSavings are in $10,000 units
// (capHit 1000 = $10.0M per year); contractSalary / contractBonus are full-contract dollar totals.
const capM = (v) => (typeof v === "number" ? Math.round(v) / 100 : null); // -> $ millions
const dollarsM = (v) => (typeof v === "number" ? Math.round(v / 10000) / 100 : null);

function contractRow(p) {
  return {
    ...summary(p),
    capHitM: capM(p.capHit),
    yearsLeft: p.contractYearsLeft ?? null,
    length: p.contractLength ?? null,
    totalSalaryM: dollarsM(p.contractSalary),
    totalBonusM: dollarsM(p.contractBonus),
    remainingCapM: p.capHit != null && p.contractYearsLeft != null ? capM(p.capHit * p.contractYearsLeft) : null,
    deadCapIfCutM: capM(p.capReleasePenalty),
    savingsIfCutM: dollarsM(p.capReleaseNetSavings),
  };
}

// "Market" cap hit for an OVR = median cap hit of rostered (non-FA) players at that OVR.
// Overpay = player's cap hit minus that median. Buckets with few players borrow from neighbours.
function marketByOvr(pool) {
  const by = new Map();
  for (const p of pool) {
    const o = ovr(p);
    if (o == null || typeof p.capHit !== "number") continue;
    if (!by.has(o)) by.set(o, []);
    by.get(o).push(p.capHit);
  }
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const cache = new Map();
  return (o) => {
    if (cache.has(o)) return cache.get(o);
    let vals = [];
    for (let w = 0; w <= 5 && vals.length < 8; w++) {
      vals = [];
      for (let k = o - w; k <= o + w; k++) vals.push(...(by.get(k) ?? []));
    }
    const v = vals.length ? median(vals) : null;
    cache.set(o, v);
    return v;
  };
}

const latestSeason = () =>
  Math.max(-1, ...playerStats.map((s) => s.seasonIndex ?? -1), ...games.map((g) => g.seasonIndex ?? -1));

// ---------------- MCP tools ----------------

const RO = { readOnlyHint: true, openWorldHint: false };

function buildServer() {
  const server = new McpServer({ name: "madden-franchise", version: VERSION });

  server.registerTool(
    "search_players",
    {
      description:
        "Search every player in the franchise (all teams and free agency) by full or partial name. Returns name, position, team, roster status (Active / Practice Squad / IR / Free Agent), age, overall and dev trait.",
      inputSchema: { name: z.string().describe("Full or partial player name") },
      annotations: RO,
    },
    async ({ name }) => {
      if (!players.size) return noData();
      const hits = findPlayers(name);
      if (!hits.length) return out({ message: `No players match "${name}".` });
      return out(hits.slice(0, 25).map(summary));
    }
  );

  server.registerTool(
    "get_player",
    {
      description:
        "Get one player's full details: every rating, contract, roster status (practice squad / IR), injury, bio, grades and non-default traits. Look up by name or rosterId.",
      inputSchema: { name: z.string().describe("Player name or rosterId") },
      annotations: RO,
    },
    async ({ name }) => {
      if (!players.size) return noData();
      const hits = findPlayers(name);
      if (!hits.length) return out({ message: `No players match "${name}".` });
      if (hits.length > 3)
        return out({ message: "Several matches; be more specific or use a rosterId.", matches: hits.slice(0, 25).map(summary) });
      return out(hits.map(details));
    }
  );

  server.registerTool(
    "compare_players",
    {
      description: "Compare 2-5 players side by side on every rating. Use rosterIds if names are ambiguous.",
      inputSchema: { names: z.array(z.string()).min(2).max(5).describe("Player names or rosterIds") },
      annotations: RO,
    },
    async ({ names }) => {
      if (!players.size) return noData();
      const picked = [];
      const notFound = [];
      const ambiguous = [];
      for (const n of names) {
        const hits = findPlayers(n);
        if (!hits.length) notFound.push(n);
        else {
          if (hits.length > 1) ambiguous.push({ query: n, using: fullName(hits[0]), others: hits.slice(1, 6).map(summary) });
          picked.push(hits[0]);
        }
      }
      const label = (p) => `${fullName(p)} (${p.position})`;
      const keys = [...new Set(picked.flatMap((p) => Object.keys(ratings(p))))].sort();
      const table = keys.map((k) => ({
        rating: k,
        ...Object.fromEntries(picked.map((p) => [label(p), p[`${k}Rating`] ?? null])),
      }));
      return out({ players: picked.map(summary), ratings: table, notFound, ambiguous });
    }
  );

  server.registerTool(
    "get_team_roster",
    {
      description:
        "List a team's roster with each player's position, age, overall, dev trait and roster status. Shows active-roster, practice-squad and IR counts. Filter by position or position group (OL, DL, EDGE, LB, DB, S, RB, ST) and by status.",
      inputSchema: {
        team: z.string().describe("Team name, city, abbreviation or teamId, e.g. 'Packers' or 'GB'"),
        position: z.string().optional().describe("Position or group, e.g. 'WR', 'OL', 'CB,S'"),
        status: z
          .enum(["all", "active", "practice_squad", "ir"])
          .optional()
          .describe("Which players to list (default all)"),
      },
      annotations: RO,
    },
    async ({ team, position, status = "all" }) => {
      if (!players.size) return noData();
      const t = findTeam(team);
      if (!t) return needTeams(team);
      const whole = [...players.values()].filter((p) => !p._freeAgent && p.teamId === t.teamId);
      const counts = {
        total: whole.length,
        active: whole.filter((p) => rosterStatus(p) === "Active").length,
        practiceSquad: whole.filter((p) => p.isOnPracticeSquad).length,
        injuredReserve: whole.filter((p) => p.isOnIR).length,
      };
      const wantStatus = { all: null, active: "Active", practice_squad: "Practice Squad", ir: "IR" }[status];
      const matchPos = positionMatcher(position);
      const list = whole
        .filter((p) => matchPos(p) && (!wantStatus || rosterStatus(p) === wantStatus))
        .sort((a, b) => String(a.position).localeCompare(String(b.position)) || (ovr(b) ?? 0) - (ovr(a) ?? 0));
      const players_ = list.map(({ ...p }) => {
        const s = summary(p);
        delete s.team;
        return s;
      });
      return out({ team: teamName(t), counts, shown: list.length, players: players_ });
    }
  );

  server.registerTool(
    "find_players",
    {
      description:
        "Search the whole league with filters: position/group, team, age range, minimum overall, dev trait, roster status. Sort by overall, age, or any rating (e.g. 'speed', 'awareness', 'zoneCover'). Good for trade targets, e.g. 'young Star+ HBs 80+'.",
      inputSchema: {
        position: z.string().optional().describe("Position or group, e.g. 'HB', 'OL', 'EDGE', 'CB,S'"),
        team: z.string().optional().describe("Limit to one team, or 'free agents'"),
        min_ovr: z.number().optional(),
        min_age: z.number().optional(),
        max_age: z.number().optional(),
        dev: z.array(z.enum(["Normal", "Star", "Superstar", "X-Factor"])).optional().describe("Dev traits to include"),
        status: z.enum(["any", "active", "practice_squad", "ir", "free_agent"]).optional(),
        sort_by: z.string().optional().describe("'ovr' (default), 'age', or a rating name like 'speed'"),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: RO,
    },
    async ({ position, team, min_ovr, min_age, max_age, dev, status = "any", sort_by = "ovr", limit = 25 }) => {
      if (!players.size) return noData();
      let list = [...players.values()].filter(positionMatcher(position));
      if (team) {
        if (/free\s*agent|^fa$/i.test(team)) list = list.filter((p) => p._freeAgent);
        else {
          const t = findTeam(team);
          if (!t) return needTeams(team);
          list = list.filter((p) => !p._freeAgent && p.teamId === t.teamId);
        }
      }
      if (min_ovr != null) list = list.filter((p) => (ovr(p) ?? 0) >= min_ovr);
      if (min_age != null) list = list.filter((p) => (p.age ?? 0) >= min_age);
      if (max_age != null) list = list.filter((p) => (p.age ?? 99) <= max_age);
      if (dev?.length) list = list.filter((p) => dev.includes(DEV[p.devTrait]));
      const wantStatus = { any: null, active: "Active", practice_squad: "Practice Squad", ir: "IR", free_agent: "Free Agent" }[status];
      if (wantStatus) list = list.filter((p) => rosterStatus(p) === wantStatus);

      let sortVal = (p) => ovr(p) ?? 0;
      let sortLabel = "ovr";
      if (norm(sort_by) === "age") {
        sortVal = (p) => -(p.age ?? 99);
        sortLabel = "age (youngest first)";
      } else {
        const key = ratingKey(sort_by);
        if (key === undefined) return out({ message: `Unknown rating "${sort_by}". Try e.g. speed, awareness, catch, zoneCover.` });
        if (key) {
          sortVal = (p) => p[key] ?? 0;
          sortLabel = key.replace(/Rating$/, "");
        }
      }
      list.sort((a, b) => sortVal(b) - sortVal(a) || (ovr(b) ?? 0) - (ovr(a) ?? 0));
      const key = ratingKey(sort_by);
      return out({
        matches: list.length,
        sortedBy: sortLabel,
        players: list.slice(0, limit).map((p) => ({ ...summary(p), ...(key ? { [sortLabel]: p[key] } : {}) })),
      });
    }
  );

  server.registerTool(
    "get_free_agents",
    {
      description: "List free agents, best first, optionally filtered by position/group, minimum overall and maximum age.",
      inputSchema: {
        position: z.string().optional().describe("Position or group, e.g. 'K', 'OL'"),
        min_ovr: z.number().optional(),
        max_age: z.number().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: RO,
    },
    async ({ position, min_ovr, max_age, limit = 30 }) => {
      if (!players.size) return noData();
      const matchPos = positionMatcher(position);
      const list = [...players.values()]
        .filter((p) => p._freeAgent && matchPos(p))
        .filter((p) => min_ovr == null || (ovr(p) ?? 0) >= min_ovr)
        .filter((p) => max_age == null || (p.age ?? 99) <= max_age)
        .sort((a, b) => (ovr(b) ?? 0) - (ovr(a) ?? 0));
      return out({
        matches: list.length,
        players: list.slice(0, limit).map((p) => ({
          ...summary(p),
          askingSalary: p.desiredSalary,
          askingBonus: p.desiredBonus,
          askingYears: p.desiredLength,
        })),
      });
    }
  );

  server.registerTool(
    "get_contracts",
    {
      description:
        "League-wide contract list for rostered players, with cap hit, years left, full-contract totals, dead cap if cut and savings if cut (all in $ millions). " +
        "sort_by: 'overpay' (default; cap hit above the median cap hit of players at the same OVR, i.e. worst-value deals first), " +
        "'cap_hit', 'remaining' (cap hit x years left), 'dead_cap', 'total_value', or 'value' (cheapest for their OVR first). " +
        "Filter by team, position/group, age, OVR and minimum years left.",
      inputSchema: {
        sort_by: z.enum(["overpay", "cap_hit", "remaining", "dead_cap", "total_value", "value"]).optional(),
        team: z.string().optional().describe("Limit to one team"),
        position: z.string().optional().describe("Position or group, e.g. 'QB', 'OL', 'EDGE'"),
        min_ovr: z.number().optional(),
        min_age: z.number().optional(),
        max_age: z.number().optional(),
        min_years_left: z.number().int().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: RO,
    },
    async ({ sort_by = "overpay", team, position, min_ovr, min_age, max_age, min_years_left, limit = 25 }) => {
      if (!players.size) return noData();
      const rostered = [...players.values()].filter((p) => !p._freeAgent && typeof p.capHit === "number");
      if (!rostered.length) return out({ message: "No contract data in the roster export." });
      const market = marketByOvr(rostered);
      let list = rostered.filter(positionMatcher(position));
      if (team) {
        const t = findTeam(team);
        if (!t) return needTeams(team);
        list = list.filter((p) => p.teamId === t.teamId);
      }
      if (min_ovr != null) list = list.filter((p) => (ovr(p) ?? 0) >= min_ovr);
      if (min_age != null) list = list.filter((p) => (p.age ?? 0) >= min_age);
      if (max_age != null) list = list.filter((p) => (p.age ?? 99) <= max_age);
      if (min_years_left != null) list = list.filter((p) => (p.contractYearsLeft ?? 0) >= min_years_left);

      const overpay = (p) => p.capHit - (market(ovr(p)) ?? p.capHit);
      const sorters = {
        overpay: (p) => overpay(p),
        cap_hit: (p) => p.capHit,
        remaining: (p) => p.capHit * (p.contractYearsLeft ?? 0),
        dead_cap: (p) => p.capReleasePenalty ?? 0,
        total_value: (p) => (p.contractSalary ?? 0) + (p.contractBonus ?? 0),
        value: (p) => -overpay(p),
      };
      list.sort((a, b) => sorters[sort_by](b) - sorters[sort_by](a) || (ovr(b) ?? 0) - (ovr(a) ?? 0));
      return out({
        matches: list.length,
        sortedBy: sort_by,
        note: "capHit/deadCap/savings come from capHit units of $10k; totals are full-contract dollars. Overpay = cap hit minus the league median cap hit at the same OVR.",
        players: list.slice(0, limit).map((p) => ({
          ...contractRow(p),
          marketCapHitM: capM(market(ovr(p))),
          overpayM: capM(overpay(p)),
        })),
      });
    }
  );

  server.registerTool(
    "get_player_stats",
    {
      description:
        "A player's season stat totals (passing, rushing, receiving, defense, kicking, punting) from weekly stat exports, plus a week-by-week log if asked. Needs weekly stats exported from the Companion App.",
      inputSchema: {
        name: z.string().describe("Player name or rosterId"),
        season: z.number().int().optional().describe("seasonIndex; defaults to the latest season in the data"),
        include_weeks: z.boolean().optional().describe("Also return each week's line"),
      },
      annotations: RO,
    },
    async ({ name, season, include_weeks = false }) => {
      if (!playerStats.length) return out({ message: "No stats yet. Export weekly stats from the Companion App." });
      const hits = findPlayers(name);
      if (!hits.length) return out({ message: `No players match "${name}".` });
      if (hits.length > 3) return out({ message: "Several matches; be more specific or use a rosterId.", matches: hits.slice(0, 25).map(summary) });
      const p = hits[0];
      const s = season ?? latestSeason();
      const rows = playerStats.filter(
        (r) => r.rosterId === String(p.rosterId) && r.stage === "regular" && (r.seasonIndex == null || r.seasonIndex === s)
      );
      const byCat = {};
      for (const r of rows) (byCat[r.category] ??= []).push(r);
      const result = {};
      for (const [cat, rs] of Object.entries(byCat)) {
        result[cat] = { games: rs.length, totals: aggregateStats(rs) };
        if (include_weeks)
          result[cat].weeks = rs
            .sort((a, b) => (a.weekIndex ?? 0) - (b.weekIndex ?? 0))
            .map((r) => ({ week: (r.weekIndex ?? 0) + 1, ...r.row }));
      }
      return out({
        player: summary(p),
        seasonIndex: s,
        stats: Object.keys(result).length ? result : "No regular-season stats found for this player in that season.",
        note: "Only weeks that were exported are counted. Rates like passer rating are left out of totals.",
      });
    }
  );

  server.registerTool(
    "get_standings",
    {
      description: "League standings from the League Info export, best record first. Optionally filter by team, division or conference name.",
      inputSchema: { filter: z.string().optional().describe("Team, division or conference, e.g. 'NFC North'") },
      annotations: RO,
    },
    async ({ filter }) => {
      if (!standings.length) return out({ message: "No standings yet. Export League Info from the Companion App." });
      const f = norm(filter);
      const rows = standings
        .map((s) => {
          const row = Object.fromEntries(Object.entries(s).filter(([, v]) => v === null || typeof v !== "object"));
          return s.teamName ? row : { teamName: teamNameById(s.teamId), ...row };
        })
        .filter((r) => !f || Object.values(r).some((v) => typeof v === "string" && norm(v).includes(f)))
        .sort((a, b) => {
          const pct = (r) => ((r.totalWins ?? 0) + 0.5 * (r.totalTies ?? 0)) / Math.max(1, (r.totalWins ?? 0) + (r.totalLosses ?? 0) + (r.totalTies ?? 0));
          return pct(b) - pct(a);
        });
      return out({ teams: rows.length, standings: rows });
    }
  );

  server.registerTool(
    "get_schedule",
    {
      description: "A team's schedule and results for a season, from the weekly schedule exports.",
      inputSchema: {
        team: z.string().describe("Team name, city, abbreviation or teamId"),
        season: z.number().int().optional().describe("seasonIndex; defaults to the latest season in the data"),
      },
      annotations: RO,
    },
    async ({ team, season }) => {
      if (!games.length) return out({ message: "No schedule data yet. Export weekly schedules from the Companion App." });
      const t = findTeam(team);
      if (!t) return needTeams(team);
      const s = season ?? latestSeason();
      const list = games
        .filter((g) => (g.homeTeamId === t.teamId || g.awayTeamId === t.teamId) && (g.seasonIndex == null || g.seasonIndex === s))
        .sort((a, b) => (a._stage === b._stage ? 0 : a._stage === "preseason" ? -1 : 1) || (a.weekIndex ?? 0) - (b.weekIndex ?? 0))
        .map((g) => {
          const home = g.homeTeamId === t.teamId;
          const us = home ? g.homeScore : g.awayScore;
          const them = home ? g.awayScore : g.homeScore;
          const played = (g.homeScore ?? 0) + (g.awayScore ?? 0) > 0;
          return {
            stage: g._stage,
            week: (g.weekIndex ?? 0) + 1,
            opponent: teamNameById(home ? g.awayTeamId : g.homeTeamId),
            homeAway: home ? "home" : "away",
            result: played ? `${us > them ? "W" : us < them ? "L" : "T"} ${us}-${them}` : "not played",
            status: g.status,
          };
        });
      return out({ team: teamName(t), seasonIndex: s, games: list });
    }
  );

  server.registerTool(
    "data_status",
    {
      description:
        "Check what league data the server has and how fresh it is: player/team counts, last roster/stats/league-info export times, and the server version. Use this first if data looks stale or missing.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      const all = [...docs.values()];
      const newest = (re) =>
        all.filter((d) => re.test(d.path)).map((d) => d.receivedAt).sort().pop() ?? null;
      const ps = [...players.values()].filter((p) => p.isOnPracticeSquad).length;
      return out({
        serverVersion: VERSION,
        players: players.size,
        freeAgents: [...players.values()].filter((p) => p._freeAgent).length,
        practiceSquadPlayers: ps,
        teams: teams.length,
        standings: standings.length,
        games: games.length,
        playerStatLines: playerStats.length,
        lastExport: {
          rosters: newest(/team\/.*\/roster/),
          freeAgents: newest(/freeagent/i),
          leagueInfo: newest(/leagueteams|standings/i),
          weeklyStats: newest(/\/week\//),
        },
        exportFiles: all.length,
        dataListsSeen: [...listKeysSeen].sort(),
      });
    }
  );

  return server;
}

// ---------------- HTTP routes ----------------

const app = express();

app.get("/health", (req, res) =>
  res.json({ ok: true, version: VERSION, players: players.size, teams: teams.length, exportFiles: docs.size })
);

// Claude connector endpoint (stateless: a fresh MCP server per request)
app.post("/mcp/:key", express.json({ limit: "10mb" }), async (req, res) => {
  if (!keyOk(req.params.key)) return res.status(404).end();
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
app.all("/mcp/:key", (req, res) => {
  if (!keyOk(req.params.key)) return res.status(404).end();
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

// Companion App export receiver: the app appends paths like /pc/12345/team/7/roster
app.all("/:key", (req, res) => (keyOk(req.params.key) ? res.json({ ok: true }) : res.status(404).end()));
app.post("/:key/*", express.raw({ type: () => true, limit: "200mb" }), (req, res) => {
  if (!keyOk(req.params.key)) return res.status(404).end();
  const exportPath = req.params[0];
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  try {
    saveDoc({ path: exportPath, receivedAt: new Date().toISOString(), body });
    rebuild();
  } catch (err) {
    console.error(`Failed to store export ${exportPath}:`, err);
    return res.status(500).json({ ok: false });
  }
  const lists = body && typeof body === "object"
    ? Object.entries(body).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}:${v.length}`).join(" ")
    : "not JSON";
  console.log(`Export received: ${exportPath} (${raw.length} bytes) ${lists}`);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Madden MCP v${VERSION} listening on ${PORT}. Players loaded: ${players.size}`));
