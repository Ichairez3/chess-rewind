@echo off
rem Starts a small local web server for Chess Rewind and opens it in your browser.
rem Needs Node.js (https://nodejs.org). Close this window to stop the server.
cd /d "%~dp0"
npx -y http-server -p 8080 -c-1 -o
