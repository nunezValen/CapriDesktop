param(
    [ValidateSet('status', 'play')]
    [string]$Action = 'status',
    [string]$ExpectedTitle = ''
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$ErrorActionPreference = 'Stop'

function Await-MediaOperation($operation, $resultType) {
    $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(800)) { throw 'Media session query timed out' }
    return $task.Result
}

function Test-YoutubeMusicSession($source, $title, $windows) {
    if (-not $title) { return $false }
    if ($source -match '(?i)youtube[ _.-]*music|music\.youtube\.com') { return $true }
    $browser = [regex]::Match($source, '(?i)chrome|msedge|firefox|brave|opera').Value
    if (-not $browser) { return $false }
    foreach ($window in $windows) {
        if ($window.ProcessName -notmatch $browser) { continue }
        $match = [regex]::Match($window.MainWindowTitle, '^(.*?)\s+[-\u2013\u2014]\s+YouTube Music(?:\s+[-\u2013\u2014].*)?$', 'IgnoreCase')
        $windowTitle = $match.Groups[1].Value -replace '^\(\d+\)\s*', '' -replace '^[\u25b6\u25ba\s]+', ''
        if ($match.Success -and $windowTitle.Trim() -eq $title.Trim()) { return $true }
    }
    return $false
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
    $manager = Await-MediaOperation ($managerType::RequestAsync()) $managerType
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $windows = @(Get-Process | Where-Object { $_.MainWindowTitle -match 'YouTube Music' })
        $found = @()
        foreach ($session in $manager.GetSessions()) {
            $properties = Await-MediaOperation ($session.TryGetMediaPropertiesAsync()) $propertiesType
            $source = $session.SourceAppUserModelId
            $title = $properties.Title
            if (-not (Test-YoutubeMusicSession $source $title $windows)) { continue }
            $status = [string]$session.GetPlaybackInfo().PlaybackStatus
            $found += @{ title = $title; artist = $properties.Artist; source = $source; status = $status }
            if ($Action -eq 'play' -and $ExpectedTitle -and $title -eq $ExpectedTitle) {
                if ($status -eq 'Playing') { @{ status = 'Playing' } | ConvertTo-Json -Compress; return }
                if ($status -eq 'Paused') {
                    $played = Await-MediaOperation ($session.TryPlayAsync()) ([bool])
                    @{ requested = $played; title = $title } | ConvertTo-Json -Compress
                    return
                }
            }
        }
        if ($Action -eq 'status') { ConvertTo-Json -InputObject @($found) -Compress -Depth 4; return }
        Start-Sleep -Milliseconds 350
    } while ([DateTime]::UtcNow -lt $deadline)
    @{ requested = $false } | ConvertTo-Json -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
}
