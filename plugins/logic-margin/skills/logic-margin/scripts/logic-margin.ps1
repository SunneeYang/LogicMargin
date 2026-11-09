$ErrorActionPreference = 'Stop'

function Assert-NativeVersion([string] $Path, [string] $Version) {
    $actual = (& $Path --version) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Cannot read native executable version: $Path" }
    if ($actual -ne $Version) { throw "Native executable version $actual does not match plugin ${Version}: $Path" }
}

try {
    # Keep UTF-8 review JSON intact through Windows PowerShell 5.1 redirected output.
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $scriptPath = $PSCommandPath
    for ($links = 0; ; $links++) {
        $item = Get-Item -LiteralPath $scriptPath
        if ($item.LinkType -ne 'SymbolicLink') { break }
        if ($links -ge 40) { throw 'Too many launcher symlinks.' }
        $target = @($item.Target)[0]
        if ([IO.Path]::IsPathRooted($target)) { $scriptPath = $target }
        else { $scriptPath = Join-Path (Split-Path -Parent $item.FullName) $target }
    }
    $directory = Split-Path -Parent $item.FullName
    $manifest = Join-Path $directory '../../../plugin.json'
    $version = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version
    if ($version -notmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z') { throw 'Plugin manifest must pin a version X.Y.Z.' }
    $binary = Join-Path $directory 'logic-margin.exe'
    if (-not [IO.File]::Exists($binary)) {
        $machine = $env:PROCESSOR_ARCHITEW6432
        if (-not $machine) { $machine = $env:PROCESSOR_ARCHITECTURE }
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $machine -ne 'AMD64') {
            throw "Unsupported platform: $([Environment]::OSVersion.Platform)/$machine (requires Windows x64)."
        }
        if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA must be set.' }
        $cache = Join-Path $env:LOCALAPPDATA "logic-margin/native/$version/win32-x64"
        $binary = Join-Path $cache 'logic-margin.exe'
        if (-not [IO.File]::Exists($binary)) {
            [IO.Directory]::CreateDirectory($cache) | Out-Null
            $temporary = Join-Path $cache ('.download.' + [Guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($temporary) | Out-Null
            $previousTls = [Net.ServicePointManager]::SecurityProtocol
            try {
                $package = "logic-margin-agent-$version-win32-x64"
                $asset = "$package.zip"
                $url = "https://github.com/SunneeYang/LogicMargin/releases/download/v$version/$asset"
                $zip = Join-Path $temporary $asset
                $checksum = Join-Path $temporary 'checksum'
                [Console]::Error.WriteLine("LogicMargin: Downloading $asset")
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 120 -MaximumRedirection 5
                Invoke-WebRequest -Uri "$url.sha256" -OutFile $checksum -UseBasicParsing -TimeoutSec 120 -MaximumRedirection 5
                $record = Get-Content -LiteralPath $checksum -Raw
                if ($record -notmatch ('\A([a-fA-F0-9]{64})[ \t]+' + [regex]::Escape($asset) + '\r?\n?\z')) {
                    throw 'Invalid release SHA-256 file.'
                }
                $expected = $Matches[1]
                $hasher = [Security.Cryptography.SHA256]::Create()
                try {
                    $archiveStream = [IO.File]::OpenRead($zip)
                    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($archiveStream)).Replace('-', '') }
                    finally { $archiveStream.Dispose() }
                } finally { $hasher.Dispose() }
                if ($actual -ne $expected) { throw "SHA-256 mismatch for $asset" }
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                $archive = [IO.Compression.ZipFile]::OpenRead($zip)
                $candidate = Join-Path $temporary 'logic-margin.exe'
                try {
                    $entry = $archive.GetEntry("$package/plugins/logic-margin/skills/logic-margin/scripts/logic-margin.exe")
                    if ($null -eq $entry) { throw "Missing executable in $asset" }
                    $source = $entry.Open()
                    try {
                        $output = [IO.File]::Open($candidate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                        try { $source.CopyTo($output) } finally { $output.Dispose() }
                    } finally { $source.Dispose() }
                } finally { $archive.Dispose() }
                Assert-NativeVersion $candidate $version
                try { [IO.File]::Move($candidate, $binary) }
                catch { if (-not [IO.File]::Exists($binary)) { throw } }
            } finally {
                [Net.ServicePointManager]::SecurityProtocol = $previousTls
                [IO.Directory]::Delete($temporary, $true)
            }
        }
    }
    Assert-NativeVersion $binary $version
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $binary
    $start.UseShellExecute = $false
    $start.WorkingDirectory = (Get-Location).ProviderPath
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    # Windows PowerShell 5.1 drops empty/quoted arguments with direct native splatting.
    $start.Arguments = (($args | ForEach-Object { '"' + ([string]$_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"' }) -join ' ')
    $process = [Diagnostics.Process]::Start($start)
    $stderr = $process.StandardError.ReadToEndAsync()
    while ($null -ne ($line = $process.StandardOutput.ReadLine())) { Write-Output $line }
    $process.WaitForExit()
    [Console]::Error.Write($stderr.GetAwaiter().GetResult())
    $code = $process.ExitCode
    $process.Dispose()
    exit $code
} catch {
    [Console]::Error.WriteLine('LogicMargin: ' + $_.Exception.Message)
    exit 1
}
