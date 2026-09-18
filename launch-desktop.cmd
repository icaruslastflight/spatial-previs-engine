@echo off
setlocal
title Spatial Previs Desktop Launcher
cd /d "%~dp0"

if "%~1"=="--showcase" goto launch_showcase
if "%~1"=="-s" goto launch_showcase
if "%~1"=="--r0" goto launch_r0
if "%~1"=="--viewport" goto launch_viewport
if "%~1"=="--dashboard" goto launch_dashboard
if "%~1"=="-d" goto launch_dashboard
if "%~1"=="--ue5" goto launch_ue5

echo =======================================================
echo          Spatial Previs Engine - Desktop Launcher
echo =======================================================
echo  [1] Launch Production Workspace with Concert Stage Showcase
echo  [2] Launch Production Workspace (Blank Project)
echo  [3] Launch Main Viewport (Point State Park Sample)
echo  [4] Launch Development Dashboard (Roadmap, PRs, CI, Agent Activity)
echo  [5] Launch Unreal Engine 5.8 Editor
echo  [6] Exit
echo =======================================================
set /p choice="Select an option [1-6] (default 1): "
if "%choice%"=="" set choice=1
if "%choice%"=="1" goto launch_showcase
if "%choice%"=="2" goto launch_r0
if "%choice%"=="3" goto launch_viewport
if "%choice%"=="4" goto launch_dashboard
if "%choice%"=="5" goto launch_ue5
if "%choice%"=="6" exit /b 0
goto launch_showcase

:launch_showcase
echo Launching Production Workspace with Concert Stage Showcase...
start "" "http://localhost:5173/r0.html?showcase=true"
exit /b 0

:launch_r0
echo Launching Production Workspace...
start "" "http://localhost:5173/r0.html"
exit /b 0

:launch_viewport
echo Launching Main Previs Viewport...
start "" "http://localhost:5173/"
exit /b 0

:launch_dashboard
echo Launching Development Dashboard...
start "" "http://localhost:5173/dashboard/"
exit /b 0

:launch_ue5
echo Launching Unreal Engine 5.8 Editor...
start "" "C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe" "%~dp0native\SpatialPrevis\SpatialPrevis.uproject"
exit /b 0
