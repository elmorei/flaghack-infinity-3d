param([Parameter(Mandatory=$true)][string]$Repository,[string]$Branch='', [switch]$HostGame)
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
if($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'){throw 'Use owner/repository, or a GitHub URL in the launcher.'}
$root=Join-Path $env:LOCALAPPDATA 'FlaghackLauncher'
New-Item -ItemType Directory -Force $root | Out-Null
$headers=@{'User-Agent'='Flaghack-Windows-Launcher';'Accept'='application/vnd.github+json'}
try {
 if(!$Branch){$Branch=(Invoke-RestMethod "https://api.github.com/repos/$Repository" -Headers $headers).default_branch}
 $ref=[Uri]::EscapeDataString($Branch)
 $sha=(Invoke-RestMethod "https://api.github.com/repos/$Repository/commits/$ref" -Headers $headers).sha
 if($sha -notmatch '^[0-9a-f]{40}$'){throw 'GitHub did not return a valid commit.'}
 $cache=Join-Path $root ($Repository.Replace('/','_')+'_'+$sha)
 $nodeVersion='v24.14.0'
 $arch=if($env:PROCESSOR_ARCHITECTURE -eq 'ARM64'){'arm64'}else{'x64'}
 $nodeDir=Join-Path $root "node-$nodeVersion-win-$arch"
 if(!(Test-Path (Join-Path $nodeDir 'node.exe'))){
   Write-Host 'Downloading portable Node.js from nodejs.org...'
   $filename="node-$nodeVersion-win-$arch.zip"
   $zip=Join-Path $root $filename
   Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/$filename" -OutFile $zip -UseBasicParsing
   $hashes=(Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
   $line=($hashes -split "`n" | Where-Object { $_.Trim().EndsWith('  '+$filename) })
   if(!$line -or (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne ($line.Trim() -split '\s+')[0]){throw 'Node.js checksum verification failed.'}
   Expand-Archive $zip $root -Force
   Remove-Item $zip
 }
 $env:PATH=$nodeDir+';'+$env:PATH
 if(!(Test-Path (Join-Path $cache '.ready'))){
   $stage=Join-Path $root ('download-'+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory $stage|Out-Null
   try{
     Write-Host "Downloading $Repository ($Branch at $sha)..."
     $zip=Join-Path $stage 'source.zip'
     Invoke-WebRequest "https://api.github.com/repos/$Repository/zipball/$sha" -Headers $headers -OutFile $zip -UseBasicParsing
     $extract=Join-Path $stage 'source';Expand-Archive $zip $extract
     $source=Get-ChildItem $extract -Directory | Select-Object -First 1
     if(!$source -or !(Test-Path (Join-Path $source.FullName 'web/package-lock.json'))){throw 'The selected repository does not have a supported Flaghack web project.'}
     Push-Location (Join-Path $source.FullName 'web')
     try {
       & (Join-Path $nodeDir 'npm.cmd') ci --no-audit --no-fund
       if($LASTEXITCODE -ne 0){throw 'Dependency installation failed.'}
       & (Join-Path $nodeDir 'npm.cmd') run build
       if($LASTEXITCODE -ne 0){throw 'Game build failed.'}
       & (Join-Path $nodeDir 'npm.cmd') run build:server
       if($LASTEXITCODE -ne 0){throw 'Server build failed.'}
     }finally{Pop-Location}
     if(Test-Path $cache){Remove-Item $cache -Recurse -Force}
     Move-Item $source.FullName $cache
     Set-Content (Join-Path $cache '.ready') $sha
   }finally{if(Test-Path $stage){Remove-Item $stage -Recurse -Force}}
 }
 Push-Location (Join-Path $cache 'web')
 try{
   $port=if($HostGame){8787}else{5173}
   $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$port)
   try{$listener.Start()}catch{throw "Port $port is in use. Close the other game/host first."}finally{$listener.Stop()}
   $serverArgs=if($HostGame){@('dist-server/main.js','--bind','127.0.0.1')}else{@('node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','5173','--strictPort')}
   Write-Host "Starting $Repository. Leave this window open; close it to stop the game."
   $process=Start-Process -FilePath (Join-Path $nodeDir 'node.exe') -ArgumentList $serverArgs -NoNewWindow -PassThru
   try{
     $ready=$false
     for($i=0;$i -lt 60;$i++){
       if($process.HasExited){throw 'The game server stopped before it was ready.'}
       try{$r=Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 1;if($r.StatusCode -eq 200){$ready=$true;break}}catch{}
       Start-Sleep -Milliseconds 250
     }
     if(!$ready){throw 'The game server did not become ready.'}
     Start-Process "http://127.0.0.1:$port/"
     $process.WaitForExit()
   }finally{if(!$process.HasExited){$process.Kill()}}
 }finally{Pop-Location}
}catch{Write-Host $_ -ForegroundColor Red;Read-Host 'Press Enter to close';exit 1}
