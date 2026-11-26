param(
    [string]$ComsolBin = 'F:/Comsol/COMSOL64/Multiphysics/bin/win64'
)

$ErrorActionPreference = 'Stop'
$compileExe = Join-Path $ComsolBin 'comsolcompile.exe'
$batchExe = Join-Path $ComsolBin 'comsolbatch.exe'
foreach ($executable in @($compileExe, $batchExe)) {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "找不到 COMSOL 程序 $executable"
    }
}

$job = Join-Path ([IO.Path]::GetTempPath()) ('hood-acoustics-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $job | Out-Null
$java = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'HoodAcoustics.java') -Raw
$java.Replace('__COMSOL_JOB_DIRECTORY__', $job.Replace('\', '/').Replace('"', '\"')) |
    Set-Content -LiteralPath (Join-Path $job 'HoodAcoustics.java') -Encoding Ascii
Write-Output "COMSOL 任务目录 $job"

$compile = Start-Process -FilePath $compileExe -WorkingDirectory $job -ArgumentList 'HoodAcoustics.java' `
    -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $job 'compile.txt') `
    -RedirectStandardError (Join-Path $job 'compile-errors.txt')
if ($compile.ExitCode -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $job 'HoodAcoustics.class'))) {
    Get-Content -LiteralPath (Join-Path $job 'compile.txt'), (Join-Path $job 'compile-errors.txt')
    throw 'COMSOL Java 编译失败。'
}

$batch = Start-Process -FilePath $batchExe -WorkingDirectory $job `
    -ArgumentList '-np 2 -inputfile HoodAcoustics.class -outputfile batch-output.mph -batchlog batch.log' `
    -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $job 'output.txt') `
    -RedirectStandardError (Join-Path $job 'batch-errors.txt')
$required = 'reference.mph', 'reference.csv', 'side-branch.mph', 'side-branch.csv'
if ($batch.ExitCode -ne 0 -or ($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $job $_) -PathType Leaf) })) {
    Get-Content -LiteralPath (Join-Path $job 'batch.log') -Tail 35 -ErrorAction SilentlyContinue
    throw 'COMSOL 批处理未生成完整的模型和曲线。'
}
Get-ChildItem -LiteralPath ($required | ForEach-Object { Join-Path $job $_ }) | Select-Object FullName,Length
