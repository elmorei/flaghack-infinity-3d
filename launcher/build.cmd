@echo off
setlocal
rem Run in an x64 Native Tools Command Prompt for Visual Studio / Build Tools.
pushd "%~dp0"
rc /nologo /fo native.res native.rc
if errorlevel 1 goto failed
cl /nologo /std:c11 /utf-8 /W4 /O2 /DUNICODE /D_UNICODE /Fe:..\Vexillamania-Launcher.exe native.c native.res /link /SUBSYSTEM:WINDOWS winhttp.lib shell32.lib bcrypt.lib ws2_32.lib user32.lib gdi32.lib
if errorlevel 1 goto failed
echo Built ..\Vexillamania-Launcher.exe from native.c
popd
exit /b 0
:failed
popd
exit /b 1
