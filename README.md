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

## Tools
- `search_players`: find anyone by name
- `get_player`: full ratings, contract, status, injury, bio, traits
- `compare_players`: 2-5 players side by side
- `get_team_roster`: roster with Active / Practice Squad / IR status and counts; filter by position group or status
- `find_players`: league-wide filters (position group, age, OVR, dev, status) sorted by OVR, age or any rating
- `get_free_agents`: best available, with asking contract
- `get_player_stats`: season totals from weekly stat exports
- `get_standings`, `get_schedule`
- `data_status`: server version and when each kind of data was last exported

Position groups: OL, OT, OG, IOL, EDGE/DE, DL, LB, OLB, MLB, S, DB, RB, ST.

Built for one franchise. Exports from a second league would mix in.
