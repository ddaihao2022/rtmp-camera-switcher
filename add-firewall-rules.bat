@echo off
REM Run as Administrator to allow LAN access to the RTMP director system
netsh advfirewall firewall add rule name="RTMP Director API 3001" dir=in action=allow protocol=TCP localport=3001
netsh advfirewall firewall add rule name="RTMP Director RTMP 1935" dir=in action=allow protocol=TCP localport=1935
netsh advfirewall firewall add rule name="RTMP Director HTTP-FLV 8000" dir=in action=allow protocol=TCP localport=8000
echo.
echo Done. Ports 3001 / 1935 / 8000 are now open for inbound TCP.
pause
