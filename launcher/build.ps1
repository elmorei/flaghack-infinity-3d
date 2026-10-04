$ErrorActionPreference='Stop'
$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if(!(Test-Path $csc)){$csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'}
Push-Location $PSScriptRoot
try{& $csc /nologo /target:winexe /out:../Flaghack-Launcher.exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /resource:launch.ps1,launch.ps1 Launcher.cs;if($LASTEXITCODE -ne 0){throw 'Launcher build failed.'}}finally{Pop-Location}
