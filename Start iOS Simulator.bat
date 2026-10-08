@echo off
setlocal
cd /d "%~dp0"

where xcrun >nul 2>nul
if errorlevel 1 goto unavailable

echo Checking for an available iOS Simulator...
xcrun simctl list devices available
if errorlevel 1 goto unavailable

echo.
echo Simulator devices are available. Run this project on the Mac that has Xcode installed.
goto finished

:unavailable
echo Apple's iOS Simulator is not available on this Windows PC.
echo It requires macOS and Xcode; this BAT cannot install or run it on Windows.
echo For an iPhone preview, use Start Expo Preview.bat and scan its QR code with Expo Go.

:finished
echo.
pause
endlocal
