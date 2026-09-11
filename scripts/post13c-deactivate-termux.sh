#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
set +x
umask 077

[ "$#" -eq 0 ] || exit 64
env_file="$HOME/.content-factory-leads.env"
[ -f "$env_file" ] && [ "$(stat -c '%a' "$env_file")" = "600" ] &&
  [ "$(stat -c '%U' "$env_file")" = "$(id -un)" ] || exit 65
[ "$(grep -Evc '^[[:space:]]*(#|$|(CONTENT_FACTORY_LEADS_BOT_TOKEN|TELEGRAM_BOT_TOKEN|BOT_TOKEN)=)' "$env_file" || true)" -eq 0 ] || exit 66

token=""
for key in CONTENT_FACTORY_LEADS_BOT_TOKEN TELEGRAM_BOT_TOKEN BOT_TOKEN; do
  line="$(grep -Em1 "^${key}=" "$env_file" || true)"
  if [ -n "$line" ]; then
    [ -z "$token" ] || exit 67
    token="${line#*=}"; token="${token#\"}"; token="${token%\"}"; token="${token#\'}"; token="${token%\'}"
  fi
done
printf '%s' "$token" | grep -Eq '^[0-9]{6,12}:[A-Za-z0-9_-]{30,80}$' || exit 68

delete_response="$({
  printf '%s\n' 'silent' 'show-error' 'fail-with-body' 'request = "POST"' 'data = "drop_pending_updates=true"'
  printf '%s\n' 'connect-timeout = 5' 'max-time = 15' 'max-filesize = 65536'
  printf 'url = "https://api.telegram.org/bot%s/deleteWebhook"\n' "$token"
} | curl --config -)"
printf '%s' "$delete_response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' || { token=""; delete_response=""; exit 69; }

info_response="$({
  printf '%s\n' 'silent' 'show-error' 'fail-with-body' 'request = "POST"'
  printf '%s\n' 'connect-timeout = 5' 'max-time = 15' 'max-filesize = 65536'
  printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\n' "$token"
} | curl --config -)"
printf '%s' "$info_response" | grep -Eq '"url"[[:space:]]*:[[:space:]]*""' || { token=""; delete_response=""; info_response=""; exit 70; }

endpoint='https://rjtyjybwygfkdekdzqbm.supabase.co/functions/v1/content-factory-leads-canary/confirm-deactivation'
confirm_response="$(printf '{"bot_token":"%s"}' "$token" | curl --silent --show-error --fail-with-body \
  --connect-timeout 5 --max-time 15 --max-filesize 65536 \
  --request POST --header 'content-type: application/json' --data-binary @- "$endpoint")"
token=""; delete_response=""; info_response=""
printf '%s' "$confirm_response" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ROLLED_BACK"' || { confirm_response=""; exit 71; }
confirm_response=""
printf '%s\n' 'WEBHOOK_EMPTY=YES'
printf '%s\n' 'DEACTIVATION=PASS'
printf '%s\n' 'VERSION=POST13C_TERMUX_V1'
