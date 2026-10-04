# Vexillamania native Windows launcher (version 2.1)

Download **Vexillamania-Launcher.exe** from the repository root and run it on Windows 10/11 x64 (or ARM64 with x64 compatibility).

1. Choose a public GitHub repository as `owner/repository` or its GitHub URL.
2. Use branch `iteration` for this fork, or leave Branch blank for the selected repository's default.
3. Click **Check for updates and launch**. The launcher displays download and build output and opens your browser when ready.
4. Keep the launcher open while playing. **Stop game** or closing the launcher stops its game and build processes.

This replacement is native C/Win32. It has no .NET dependency, embedded PowerShell, encoded command, execution-policy override, installer or administrator requirement. The previous .NET/PowerShell EXE and scripts have been removed from the current branch. No antivirus exclusions or security-setting changes are used.

The first run downloads portable Node.js 24.14.0 from nodejs.org, checks its SHA-256 against the official checksum list, downloads the selected repository at a resolved commit, installs locked npm dependencies, and builds the client and server. Downloads use Windows WinINet with the desktop user’s configured Internet/proxy settings and normal HTTPS certificate verification. Network failures show the server name and the actual Windows error code/message; HTTP response errors are reported separately. ZIP files are extracted with Windows' built-in `tar.exe`. Builds run using Node's npm CLI; they execute the selected repository's build scripts as expected for development.

Later runs check the branch for updates and reuse completed builds. Downloads and remembered settings are in `%LOCALAPPDATA%\VexillamaniaLauncher`. Old revision caches remain on disk. An interrupted download/build never creates a ready cache. Private repositories and offline update checks are unsupported. GitHub rate limits or failed downloads/builds appear in the output.

Default play uses `http://127.0.0.1:5173`. The local multiplayer checkbox uses `http://127.0.0.1:8787` and prints the generated password. Both bind to this computer only. LAN hosting remains available through the repository's documented host command. The launcher refuses an occupied port without stopping another program.

## Build from source on Windows

Run `launcher\build.cmd` in an **x64 Native Tools Command Prompt for Visual Studio / Build Tools**. It compiles `native.c` and the version/manifest resources into the root EXE using Microsoft's C compiler and Windows SDK. No downloadable launcher code or embedded scripts are used.

The checked-in binary is cross-compiled with MinGW-w64 GCC, with an ordinary Win32 GUI header, version metadata and an `asInvoker` manifest. It is unpacked and unsigned. Native helper tests, compiler warnings and executable imports are checked in the development environment. Windows execution and Microsoft Defender's verdict cannot be verified in the Linux build environment; a new build is not a guarantee that an antivirus product will accept it.
