@echo off
setlocal
cd /d "%~dp0"
echo Starting the Minecraft clock preview for Expo Go...
echo Keep this window open while testing on your iPhone.
echo Your iPhone and PC must be on the same Wi-Fi network.
echo.
call npx expo start --go --lan --port 8081 --clear
echo.
echo Expo preview has stopped. Press any key to close this window.
pause >nul
endlocal
