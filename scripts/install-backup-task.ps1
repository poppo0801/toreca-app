# Windows タスクスケジューラに「毎日のローカルバックアップ」を登録する（ユーザー権限・管理者不要・パスワード保存なし）。
#   登録:   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
#   解除:   powershell -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -Remove
# - 毎日 03:30 と、ログオン時に実行。PCが止まっていて取り逃した場合は、起動後できるだけ早く実行（StartWhenAvailable）
# - local-backup.mjs 側で「直近20時間以内に成功済みなら重複取得しない」ため、ログオン時の再実行は安全
param([switch]$Remove)
$TaskName = 'TorecaAppDailyBackup'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "タスク $TaskName を削除しました"
  exit 0
}
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $repo '.env.local'))) { Write-Warning '.env.local が見つかりません（BACKUP_PASSPHRASE と Supabase の設定が必要です）' }
$action = New-ScheduledTaskAction -Execute $node -Argument 'scripts\local-backup.mjs' -WorkingDirectory $repo
$triggers = @((New-ScheduledTaskTrigger -Daily -At '03:30'), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
# ログオン中のユーザーとして実行（Interactive）。パスワードは保存せず、通知(トースト)も表示できる
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "登録しました: $TaskName（毎日03:30・ログオン時・取り逃し時は起動後に実行）"
Write-Host "今すぐ試す: npm run backup:local -- --force   状態: npm run backup:status"
