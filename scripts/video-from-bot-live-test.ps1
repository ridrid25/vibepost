param(
  [Parameter(Mandatory = $true)]
  [string]$IncomingVideoId
)

$ErrorActionPreference = "Stop"

function Read-DotEnvValue([string]$Name) {
  $line = Get-Content -LiteralPath .env |
    Where-Object { $_ -match ("^" + [regex]::Escape($Name) + "=") } |
    Select-Object -First 1
  if (-not $line) {
    throw "$Name missing from .env"
  }
  return $line.Substring($line.IndexOf("=") + 1).Trim().Trim('"').Trim("'")
}

$supabaseUrl = Read-DotEnvValue "SUPABASE_URL"
$serviceKey = Read-DotEnvValue "SUPABASE_SERVICE_ROLE_KEY"
$ownerTelegramId = Read-DotEnvValue "ERROR_NOTIFY_TG_ID"
$headers = @{
  apikey        = $serviceKey
  Authorization = "Bearer $serviceKey"
}
$writeHeaders = @{
  apikey        = $serviceKey
  Authorization = "Bearer $serviceKey"
  Prefer        = "return=representation"
}

$profile = @(Invoke-RestMethod `
    -Uri "$supabaseUrl/rest/v1/profiles?select=id,error_notify_bot_id,active_video_idea_id&error_notify_tg_id=eq.$ownerTelegramId" `
    -Headers $headers)[0]
if (-not $profile) {
  throw "Owner profile missing"
}

$row = @(Invoke-RestMethod `
    -Uri "$supabaseUrl/rest/v1/incoming_videos?select=id,idea_id,video_url,status&user_id=eq.$($profile.id)&id=eq.$IncomingVideoId" `
    -Headers $headers)[0]
if (-not $row -or $row.status -notin @("new", "rework")) {
  throw "Exact live-test row is unavailable"
}

$idea = @(Invoke-RestMethod `
    -Uri "$supabaseUrl/rest/v1/video_ideas?select=id,causal_pattern&id=eq.$($row.idea_id)" `
    -Headers $headers)[0]
if (-not $idea.causal_pattern) {
  throw "The selected row has no causal pattern"
}

$bot = @(Invoke-RestMethod `
    -Uri "$supabaseUrl/rest/v1/bots?select=token_secret_id&id=eq.$($profile.error_notify_bot_id)" `
    -Headers $headers)[0]
if (-not $bot) {
  throw "Bot mapping missing"
}

$tokenRequest = @{ p_secret_id = $bot.token_secret_id } | ConvertTo-Json -Compress
$botToken = Invoke-RestMethod `
  -Uri "$supabaseUrl/rest/v1/rpc/get_bot_token" `
  -Headers $headers `
  -Method Post `
  -ContentType "application/json" `
  -Body $tokenRequest
if (-not $botToken) {
  throw "Bot token unavailable"
}

$originalActiveIdeaId = [string]$profile.active_video_idea_id
$testIdeaId = [string]$row.idea_id
$activateBody = @{ active_video_idea_id = $testIdeaId } | ConvertTo-Json -Compress
$activated = @(Invoke-RestMethod `
    -Uri "$supabaseUrl/rest/v1/profiles?id=eq.$($profile.id)&active_video_idea_id=eq.$originalActiveIdeaId" `
    -Headers $writeHeaders `
    -Method Patch `
    -ContentType "application/json" `
    -Body $activateBody)
if ($activated.Count -ne 1) {
  throw "Active idea compare-and-set failed"
}

$testResult = $null
$restored = $false
try {
  $sendVideoBody = @{
    chat_id = [long]$ownerTelegramId
    video   = [string]$row.video_url
    caption = "VFR v22 live acceptance - existing approved video"
  } | ConvertTo-Json -Compress
  $sent = Invoke-RestMethod `
    -Uri "https://api.telegram.org/bot$botToken/sendVideo" `
    -Method Post `
    -ContentType "application/json" `
    -Body $sendVideoBody
  if (-not $sent.ok -or -not $sent.result.video.file_id) {
    throw "Telegram test video upload failed"
  }
  if ([long]$sent.result.video.file_size -gt 20MB) {
    throw "Telegram test video exceeds the function limit"
  }

  $acceptedAt = [DateTime]::UtcNow
  $incomingUpdate = [ordered]@{
    message_id = [int]$sent.result.message_id + 1000000
    date       = [int][DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    from       = @{
      id         = [long]$ownerTelegramId
      is_bot     = $false
      first_name = "Owner"
    }
    chat       = @{
      id   = [long]$ownerTelegramId
      type = "private"
    }
    video      = @{
      file_id        = [string]$sent.result.video.file_id
      file_unique_id = [string]$sent.result.video.file_unique_id
      file_size      = [long]$sent.result.video.file_size
      width          = [int]$sent.result.video.width
      height         = [int]$sent.result.video.height
      duration       = [int]$sent.result.video.duration
      file_name      = "vfr-v22-live.mp4"
      mime_type      = "video/mp4"
    }
  }
  $functionBody = $incomingUpdate | ConvertTo-Json -Compress -Depth 8
  $functionResponse = Invoke-WebRequest `
    -Uri "$supabaseUrl/functions/v1/video-from-bot" `
    -Method Post `
    -ContentType "application/json" `
    -Body $functionBody `
    -SkipHttpErrorCheck
  $returnedAt = [DateTime]::UtcNow

  $testResult = [ordered]@{
    video_accepted_utc       = $acceptedAt.ToString("o")
    function_returned_utc    = $returnedAt.ToString("o")
    request_roundtrip_ms     = [math]::Round(($returnedAt - $acceptedAt).TotalMilliseconds)
    function_status          = [int]$functionResponse.StatusCode
    function_body            = $functionResponse.Content
    telegram_input_message_id = [int]$sent.result.message_id
    test_incoming_id         = [string]$row.id
    test_idea_id             = $testIdeaId
  }
} finally {
  $restoreBody = @{ active_video_idea_id = $originalActiveIdeaId } | ConvertTo-Json -Compress
  $restoredRows = @(Invoke-RestMethod `
      -Uri "$supabaseUrl/rest/v1/profiles?id=eq.$($profile.id)&active_video_idea_id=eq.$testIdeaId" `
      -Headers $writeHeaders `
      -Method Patch `
      -ContentType "application/json" `
      -Body $restoreBody)
  $restored = $restoredRows.Count -eq 1
}

if (-not $restored) {
  throw "Active idea was changed concurrently and was not overwritten"
}
$testResult["active_idea_restored"] = $true
$testResult | ConvertTo-Json -Depth 5
