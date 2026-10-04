# Windows launcher

Download `Flaghack-Launcher.exe` from the repository root and run it on Windows 10/11.
The launcher uses the Windows .NET Framework and PowerShell; it needs no Git or Node installation.

1. Set **GitHub repository** to `owner/repository` or its GitHub URL.
2. Set **Branch** to `iteration` for this fork, or leave it blank to use the selected repository's default branch.
3. Click **Check for updates & Launch**. The console shows download/build progress and opens the game in your default browser when ready. Keep the console open while playing.

The first launch needs Internet access and downloads portable Node.js 24.14.0 from nodejs.org, verifies its SHA-256 against the official checksum list, downloads the chosen public repository at a resolved commit, runs its locked dependency installation, and builds it. Subsequent launches check the selected branch for updates and reuse successfully built revisions. Failed builds are not marked ready. Private repositories are not supported.

Downloads, builds and remembered repository/branch settings are under `%LOCALAPPDATA%\FlaghackLauncher`, separately from your source checkout. Nothing writes into a Git checkout. Old revision caches remain available on disk and can be removed while no game is running.

Default launch is local solo/AI play at `http://127.0.0.1:5173`. The optional local multiplayer host uses `http://127.0.0.1:8787` and prints its generated password. This checkbox binds to this PC only. Use the repository's documented host command with a LAN bind when hosting for other computers. A port already in use produces an error instead of stopping another process.

## Rebuild

From Windows PowerShell:

```powershell
.\launcher\build.ps1
```

`Launcher.cs` embeds `launch.ps1` into the EXE. The checked-in executable is a Windows GUI .NET assembly built from those files. Its compilation and embedded resource were verified in Linux; Windows execution still needs a Windows smoke test. The executable is unsigned.
