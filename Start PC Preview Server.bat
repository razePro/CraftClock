@echo off
setlocal
cd /d "%~dp0"
echo Starting the Minecraft clock development preview server...
echo Keep this window open. Your iPhone and PC must be on the same Wi-Fi.
echo In the app's PC Preview tab, enter the IP address shown in the Expo URL.
echo If Windows Firewall asks, allow access on Private networks.
echo.
call npx expo start --dev-client --lan --port 8081 --clear
echo.
echo The preview server has stopped. Press any key to close this window.
pause >nul
endlocal
