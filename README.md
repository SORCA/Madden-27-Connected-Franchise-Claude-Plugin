# Madden Franchise MCP

Receives Madden Companion App exports and lets Claude read your league's exact ratings.

## Deploy (Railway)
1. Upload `server.js`, `package.json`, `.gitignore` and this README to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo → pick the repo.
3. Service → Variables:
   - `SECRET_KEY` = a random 20+ character string (letters/numbers only). Treat it like a password.
   - `DATA_DIR` = `/data`
4. Service → right-click → Attach Volume → mount path `/data` (keeps data across restarts).
5. Settings → Networking → Generate Domain. You get `https://something.up.railway.app`.
6. Check `https://something.up.railway.app/health` → `{"ok":true,...}`.

## Export from Madden
Companion App → your franchise → export settings → URL:
`https://something.up.railway.app/YOUR_SECRET_KEY`
Export League Info first, then Rosters (and Free Agents). Re-export Rosters after signings, trades, position changes or progression.
`/health` shows the player count once it works. Railway's Deploy Logs show each export as it arrives.

## Connect Claude
Claude → Settings → Connectors → Add custom connector → URL:
`https://something.up.railway.app/mcp/YOUR_SECRET_KEY`

Tools: search_players, get_player, compare_players, get_team_roster, get_free_agents, data_status.
Built for one franchise; exports from a second league would mix in.
