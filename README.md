# Madden Franchise MCP

Receives Madden Companion App exports and lets Claude read your league: exact ratings, rosters (with practice squad and IR), free agents, stats, standings and schedules.

## Deploy (Railway)
1. Put `server.js`, `package.json`, `.gitignore` and this README in a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo → pick the repo.
3. Service → Variables:
   - `SECRET_KEY` = a random 20+ character string (letters/numbers only). Treat it like a password.
   - `DATA_DIR` = `/data`
4. Attach a Volume at mount path `/data` so data survives restarts.
5. Settings → Networking → Generate Domain.
6. Open `https://something.up.railway.app/health`. It should show `"ok":true` and the `version`.

## Updating the code
After you commit a new `server.js` to GitHub, check that `/health` shows the new `version`.
If it still shows the old one, Railway rebuilt an old commit. Go to Deployments and deploy the latest commit.

## Export from Madden
Companion App → your franchise → export settings → URL:
`https://something.up.railway.app/YOUR_SECRET_KEY`

Export **League Info** (teams + standings), **Rosters** (all teams + free agents), and **Weekly Stats** (stats + schedules).
Re-export after signings, trades, releases, progression, or a played week. Each export replaces the previous copy of the same data.

## Connect Claude
Claude → Settings → Connectors → Add custom connector → URL:
`https://something.up.railway.app/mcp/YOUR_SECRET_KEY`

## More than one league
Every league can export to the **same** URL. The Companion App puts the league ID in each export,
so the server keeps each league's data separate (rosters, teams, stats are never mixed).

- `https://something.up.railway.app/mcp/YOUR_SECRET_KEY` reads the **default** league.
- `https://something.up.railway.app/mcp/YOUR_SECRET_KEY/LEAGUE` reads a specific league, where `LEAGUE` is its league ID
  (shown at `/health` after the league's first export) or a name you set below.

Every tool also takes an optional `league` argument (a league ID or a name from `LEAGUES`), so **one
connector can read any league** that has exported here — ask Claude for "the hybrid league's free agents"
and it reads that league without changing anything. Omit it and the tool reads the league the URL is
bound to. `data_status` lists every league on the server.

A connector per league still works, and is handy if you want each one named separately in Claude
(e.g. "Madden – Main", "Madden – League 2").

Optional variables:
- `LEAGUES` = friendly names, e.g. `main=1234567,second=7654321`, so URLs can end in `/main` or `/second`.
- `DEFAULT_LEAGUE` = the league ID (or name) the plain `/mcp/YOUR_SECRET_KEY` URL should read.
  If unset: the only league, or with several, the league that has been on the server the longest.

## Season history
Weekly stats, schedules, team stats and standings are stored per season, so starting a new season never
overwrites the last one. Ask about any past season by year (e.g. 2026) or seasonIndex (0 = first season).
Only weeks that were exported are counted, so export every week (Snallabot Auto Update does this).
Playoff weeks are those after the regular season (`REG_SEASON_WEEKS`, default 18).
Recorded accolades are kept in `DATA_DIR/accolades/`.

## Tools
- `search_players`: find anyone by name
- `get_player`: full ratings, contract, status, injury, bio, traits
- `compare_players`: 2-5 players side by side
- `get_team_roster`: roster with Active / Practice Squad / IR status and counts; filter by position group or status
- `find_players`: league-wide filters (position group, age, OVR, dev, status) sorted by OVR, age or any rating
- `get_free_agents`: best available, with asking contract
- `get_contracts`: league-wide contracts (cap hit, years left, dead cap, savings if cut); sort by worst value (overpay vs. players at the same OVR), cap hit, remaining money, dead cap, total value, or best value
- `get_player_stats`: season totals from weekly stat exports
- `get_standings`, `get_schedule`: current or any past season
- `list_seasons`: which seasons are saved, with calendar years
- `get_season_leaders`: league leaders for any season/stat (regular season, playoffs or both), optionally by team or position
- `get_team_season`: a team's record, ranks, every result, team stats and stat leaders for any season
- `get_accolades`: recorded awards plus automatic statistical titles for a season
- `record_accolade` / `remove_accolade`: save awards the league hands out (MVP, OPOY, Super Bowl champ, All-Pro, records, milestones)
- `data_status`: which league the connector reads, every league on the server, server version, and when each kind of data was last exported

Position groups: OL, OT, OG, IOL, EDGE/DE, DL, LB, OLB, MLB, S, DB, RB, ST.

Supports any number of franchises on one deployment (see "More than one league").
