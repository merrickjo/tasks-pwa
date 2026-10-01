#!/bin/zsh
# notch-cal — push the next 7 days of Outlook meetings (titles + times) to
# the Notch Worker. Run by launchd every 30 min; quietly does nothing when
# Outlook isn't open, so it never launches Outlook on its own.
set -euo pipefail
DIR="$HOME/Library/Application Support/Notch"
LOG="$DIR/notch-cal.log"
source "$DIR/config"   # WORKER_URL=… APP_KEY=…  (chmod 600)

log() { print -r -- "$(date '+%F %T') $*" >> "$LOG"; }
# keep the log small
[[ -f "$LOG" && $(wc -l < "$LOG") -gt 500 ]] && tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"

if ! pgrep -xq "Microsoft Outlook"; then
  log "skip: Outlook not running"; exit 0
fi
if [[ "$(defaults read com.microsoft.Outlook IsRunningNewOutlook 2>/dev/null || echo 0)" == "1" ]]; then
  log "skip: New Outlook is on — notch-cal needs Legacy Outlook"; exit 0
fi

BODY="$DIR/last-push.json"
osascript "$DIR/notch-cal.applescript" 7 "$(date +%z)" > "$BODY"

code=$(curl -sS -o "$DIR/last-response.json" -w '%{http_code}' --max-time 30 \
  -X PUT "${WORKER_URL%/}/api/events" \
  -H "content-type: application/json" -H "x-app-key: $APP_KEY" \
  --data-binary @"$BODY")
log "push $code $(cat "$DIR/last-response.json")"
[[ "$code" == "200" ]]
