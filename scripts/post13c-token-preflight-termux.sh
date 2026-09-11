#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
set +x
umask 077

if [ "$#" -ne 0 ]; then
  printf '%s\n' 'CHECK_NAME=ARGUMENTS PASS=FAIL COUNT=1 HASH=- VERSION=POST13C_TERMUX_V1'
  exit 64
fi

env_file="$HOME/.content-factory-leads.env"
if [ ! -f "$env_file" ] || [ "$(stat -c '%a' "$env_file")" != "600" ] ||
   [ "$(stat -c '%U' "$env_file")" != "$(id -un)" ]; then
  printf '%s\n' 'CHECK_NAME=ENV_FILE PASS=FAIL COUNT=1 HASH=- VERSION=POST13C_TERMUX_V1'
  exit 65
fi

unexpected_count="$(grep -Evc '^[[:space:]]*(#|$|(CONTENT_FACTORY_LEADS_BOT_TOKEN|TELEGRAM_BOT_TOKEN|BOT_TOKEN)=)' "$env_file" || true)"
if [ "$unexpected_count" -ne 0 ]; then
  printf '%s\n' "CHECK_NAME=ENV_ALLOWLIST PASS=FAIL COUNT=$unexpected_count HASH=- VERSION=POST13C_TERMUX_V1"
  exit 66
fi

token=""
for key in CONTENT_FACTORY_LEADS_BOT_TOKEN TELEGRAM_BOT_TOKEN BOT_TOKEN; do
  line="$(grep -Em1 "^${key}=" "$env_file" || true)"
  if [ -n "$line" ]; then
    [ -z "$token" ] || { printf '%s\n' 'CHECK_NAME=TOKEN_KEYS PASS=FAIL COUNT=2 HASH=- VERSION=POST13C_TERMUX_V1'; exit 67; }
    token="${line#*=}"
    token="${token#\"}"; token="${token%\"}"
    token="${token#\'}"; token="${token%\'}"
  fi
done
if ! printf '%s' "$token" | grep -Eq '^[0-9]{6,12}:[A-Za-z0-9_-]{30,80}$'; then
  printf '%s\n' 'CHECK_NAME=TOKEN_SHAPE PASS=FAIL COUNT=1 HASH=- VERSION=POST13C_TERMUX_V1'
  exit 68
fi

response="$({
  printf '%s\n' 'silent' 'show-error' 'fail-with-body' 'request = "POST"'
  printf '%s\n' 'connect-timeout = 5' 'max-time = 15' 'max-filesize = 65536'
  printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token"
} | curl --config -)"
if ! printf '%s' "$response" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' ||
   ! printf '%s' "$response" | grep -Eq '"username"[[:space:]]*:[[:space:]]*"ContentFactoryLeads_bot"'; then
  token=""; response=""
  printf '%s\n' 'CHECK_NAME=BOT_IDENTITY PASS=FAIL COUNT=1 HASH=- VERSION=POST13C_TERMUX_V1'
  exit 69
fi

token_digest="$(printf '%s' "$token" | sha256sum | awk '{print $1}')"
token=""; response=""
printf '%s\n' 'BOT_USERNAME=@ContentFactoryLeads_bot'
printf '%s\n' 'TOKEN_VALID=YES'
printf '%s\n' "TOKEN_SHA256=$token_digest"
printf '%s\n' 'VERSION=POST13C_TERMUX_V1'
token_digest=""
