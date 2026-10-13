#!/usr/bin/env bash
# End-to-end API smoke test against a running server (default http://localhost:3001).
set -euo pipefail
BASE="${BASE:-http://localhost:3001}"
URL="${1:-https://illuminatihotties.bandcamp.com/album/let-me-do-one-more}"
step() { printf '\n== %s\n' "$*"; }
need() { python3 -I -c "import sys,json; d=json.load(sys.stdin); v=d$1; assert $2, v; print(v)"; }

step "health"; curl -sf "$BASE/api/health" | need "['ok']" "v is True"
step "import $URL"
JOB=$(curl -sf -X POST "$BASE/api/import" -H 'Content-Type: application/json' -d "{\"url\":\"$URL\"}" | need "['job']['id']" "v > 0")
for i in $(seq 1 60); do
  S=$(curl -sf "$BASE/api/jobs/$JOB" | need "['job']['status']" "True")
  [ "$S" = done ] && break; [ "$S" = failed ] && { curl -s "$BASE/api/jobs/$JOB"; exit 1; }; sleep 1
done
[ "$S" = done ] || { echo "job not done: $S"; exit 1; }
step "albums"; AID=$(curl -sf "$BASE/api/albums" | need "['albums'][0]['id']" "v > 0")
TID=$(curl -sf "$BASE/api/albums/$AID" | need "['album']['tracks'][0]['id']" "v > 0")
step "audio redirect"; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$BASE/api/tracks/$TID/audio" | grep -E '^302 https://t4\.bcbits\.com/' 
step "re-import does not duplicate"
curl -sf -X POST "$BASE/api/import" -H 'Content-Type: application/json' -d "{\"url\":\"$URL\"}" >/dev/null; sleep 3
curl -sf "$BASE/api/albums" | need "['albums']" "len(v) == len({a['id'] for a in v})" >/dev/null && echo ok
step "playlist"
PID=$(curl -sf -X POST "$BASE/api/playlists" -H 'Content-Type: application/json' -d '{"name":"smoke"}' | need "['playlist']['id']" "v > 0")
curl -sf -X POST "$BASE/api/playlists/$PID/tracks" -H 'Content-Type: application/json' -d "{\"track_ids\":[$TID,$TID]}" | need "['playlist']['track_count']" "v == 2"
PT=$(curl -sf "$BASE/api/playlists/$PID" | python3 -I -c "import sys,json; t=json.load(sys.stdin)['playlist']['tracks']; print(t[1]['playlist_track_id'], t[0]['playlist_track_id'])")
curl -sf -X PUT "$BASE/api/playlists/$PID/order" -H 'Content-Type: application/json' -d "{\"playlist_track_ids\":[${PT// /,}]}" | need "['playlist']['tracks'][0]['playlist_track_id']" "v == ${PT%% *}"
curl -sf -X DELETE "$BASE/api/playlists/$PID" | need "['deleted']" "v is True"
step "play-state round trip"
curl -sf -X PUT "$BASE/api/play-state" -H 'Content-Type: application/json' -d "{\"current_track_id\":$TID,\"position_sec\":12.5,\"queue\":[{\"id\":$TID,\"track_id\":1,\"album_id\":$AID,\"title\":\"smoke\",\"track_num\":1,\"duration\":1,\"track_artist\":null,\"streamable\":true,\"lyrics\":null,\"album_title\":\"a\",\"artist_name\":\"b\",\"art_id\":null}],\"queue_index\":0,\"shuffle\":false,\"repeat\":\"all\",\"volume\":0.8}" >/dev/null
curl -sf "$BASE/api/play-state" | need "['state']['position_sec']" "v == 12.5"
step "search"; curl -sf "$BASE/api/search?q=illuminati%20hotties" | need "['results'][0]['in_library']" "v is True"
printf '\nSMOKE OK\n'
