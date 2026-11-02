#!/bin/sh
# Gives Materialious a new WARP exit when YouTube bot-flags the one it has.
#
# The app writes egress-flag.json beside its database whenever YouTube
# answers "Sign in to confirm you're not a bot" (src/lib/server/botCheck.ts).
# This runs beside it, with the Docker socket, the app's data directory at
# /data and WARP's at /warp, and re-registers WARP when that file changes,
# which is what has got a working address back every time so far.

FLAG=/data/egress-flag.json
STATE=/warp/last-rotation
WARP=${WARP_CONTAINER:-ix-materialious-warp-1}
APP=${APP_CONTAINER:-ix-materialious-materialious-1}

# A new exit is kept at least this long, so an exit that is flagged on
# arrival, or a WARP pool that is flagged throughout, is not churned.
COOLDOWN=${COOLDOWN_SECONDS:-1800}

# Flags written about the old exit by requests still in flight.
GRACE=120

# Old registrations kept, for going back to one by hand.
KEEP_OLD=10

log() { echo "$(date -u +%FT%TZ) $*"; }

modified() { stat -c %Y "$1" 2>/dev/null || echo 0; }

exit_address() {
	docker exec "$APP" node -e \
		'fetch("https://cloudflare.com/cdn-cgi/trace").then(r=>r.text()).then(t=>console.log(t.match(/ip=(.*)/)[1]))' \
		2>/dev/null || echo unknown
}

health() { docker inspect -f '{{.State.Health.Status}}' "$WARP" 2>/dev/null; }

rotate() {
	log "YouTube bot-checked $(exit_address); re-registering WARP"

	docker stop "$WARP" >/dev/null
	old="/warp/old-reg-$(date +%s)"
	mkdir -p "$old"
	mv /warp/reg.json /warp/conf.json "$old"/ 2>/dev/null
	docker start "$WARP" >/dev/null
	date +%s >"$STATE"

	for _ in $(seq 1 60); do
		[ "$(health)" = healthy ] && break
		sleep 3
	done

	log "WARP is $(health), going out at $(exit_address)"

	ls -1dt /warp/old-reg-* 2>/dev/null | tail -n +$((KEEP_OLD + 1)) | xargs -r rm -rf
}

# A flag from before the watchdog first ran is history, not news.
[ -s "$STATE" ] || date +%s >"$STATE"

log "watching $FLAG for $WARP"

while true; do
	last=$(cat "$STATE")
	now=$(date +%s)

	if [ "$(modified "$FLAG")" -gt $((last + GRACE)) ] && [ $((now - last)) -ge "$COOLDOWN" ]; then
		rotate
	fi

	sleep 30
done
