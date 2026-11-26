param(
    [string]$ComsolBin = 'F:/Comsol/COMSOL64/Multiphysics/bin/win64',
    [string]$JobDirectory
)

$ErrorActionPreference = 'Stop'
$compileExe = Join-Path $ComsolBin 'comsolcompile.exe'
$batchExe = Join-Path $ComsolBin 'comsolbatch.exe'
foreach ($executable in @($compileExe, $batchExe)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "COMSOL executable not found: $executable"
    }
}

$job = $JobDirectory
if (-not $job) {
    $job = Join-Path ([IO.Path]::GetTempPath()) ('hood-acoustics-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $job | Out-Null
}
$job = (Resolve-Path -LiteralPath $job).Path
$java = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'HoodAcoustics.java') -Raw
$settingsPath = Join-Path $job 'job.properties'
$settings = if (Test-Path -LiteralPath $settingsPath) {
    foreach ($line in Get-Content -LiteralPath $settingsPath) {
        if ($line -notmatch '^(mode|hole|plate|depth|ratio|thickness|resistivity|length|duct|neck|neckLength|cavityLength|cavityHeight|start|stop|step)=(\d+(\.\d+)?([eE][+-]?\d+)?)$') {
            throw 'COMSOL job.properties contains an unsupported setting.'
        }
        'settings.setProperty("{0}", "{1}");' -f $Matches[1], $Matches[2]
    }
}
$java.Replace('__COMSOL_JOB_DIRECTORY__', $job.Replace('\', '/').Replace('"', '\"')).Replace('// __COMSOL_JOB_SETTINGS__', ($settings -join "`r`n        ")) |
    Set-Content -LiteralPath (Join-Path $job 'HoodAcoustics.java') -Encoding Ascii
Write-Output "COMSOL job directory: $job"

$compile = Start-Process -FilePath $compileExe -WorkingDirectory $job -ArgumentList 'HoodAcoustics.java' `
    -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $job 'compile.txt') `
    -RedirectStandardError (Join-Path $job 'compile-errors.txt')
if ($compile.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $job 'HoodAcoustics.class'))) {
    Get-Content -LiteralPath (Join-Path $job 'compile.txt'), (Join-Path $job 'compile-errors.txt')
    throw 'COMSOL Java compilation failed.'
}

$batch = Start-Process -FilePath $batchExe -WorkingDirectory $job `
    -ArgumentList '-np 2 -inputfile HoodAcoustics.class -outputfile batch-output.mph -batchlog batch.log' `
    -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $job 'output.txt') `
    -RedirectStandardError (Join-Path $job 'batch-errors.txt')
$required = if ($settings -match 'setProperty\("mode"') { 'absorber.mph', 'absorber.csv' } else { 'reference.mph', 'reference.csv', 'side-branch.mph', 'side-branch.csv' }
if ($batch.ExitCode -ne 0 -or ($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $job $_) -PathType Leaf) })) {
    Get-Content -LiteralPath (Join-Path $job 'batch.log') -Tail 35 -ErrorAction SilentlyContinue
    throw 'COMSOL did not produce the expected model and sweep.'
}
Get-ChildItem -LiteralPath ($required | ForEach-Object { Join-Path $job $_ }) | Select-Object FullName,Length
