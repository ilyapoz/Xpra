SET ARGS=%*
set DIR=%CD%

SETLOCAL EnableExtensions EnableDelayedExpansion

REM set some defaults if unspecified:
if "%DO_INSTALLER%"=="" (
	SET DO_INSTALLER=1
)
if "%RUN_INSTALLER%"=="" (
	SET RUN_INSTALLER=1
)
if "%DO_ZIP%"=="" (
	SET DO_ZIP=1
)
if "%DIST%"=="" (
	SET DIST="dist"
)

ECHO DO_INSTALLER=%DO_INSTALLER%, RUN_INSTALLER=%RUN_INSTALLER%, DO_ZIP=%DO_ZIP%, DIST=%DIST%

SET INNOSETUP="%ProgramFiles%\Inno Setup 5\ISCC.exe"
IF EXIST "%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe" (
	SET INNOSETUP="%ProgramFiles(x86)%\Inno Setup 5\ISCC.exe"
)
SET ZIP7="%ProgramFiles%\7-Zip\7z.exe"
IF EXIST "%ProgramFiles(x86)%\7-Zip\7z.exe" (
	SET ZIP7="%ProgramFiles(x86)%\7-Zip\7z.exe"
)
IF EXIST "E:\Xpra-Build-Libs\" (
	SET XPRA_WIN32_BUILD_LIB_PREFIX=E:\Xpra-Build-Libs\
)
IF EXIST "E:\Xpra-Build-Libs-v0.17.x\" (
	SET XPRA_WIN32_BUILD_LIB_PREFIX=E:\Xpra-Build-Libs-v0.17.x\
)

SET PYTHON_EXE=%PYTHON%\python.exe
SET SVNVERSION_EXE=svnversion
SET EXTRA_VERSION=

FOR /F "delims=" %%i IN ('%PYTHON_EXE% -c "import sys;print(sys.version_info.major)"') DO set PYTHON_MAJOR_VERSION=%%i
FOR /F "delims=" %%i IN ('%PYTHON_EXE% -c "import sys;print(sys.version_info.minor)"') DO set PYTHON_MINOR_VERSION=%%i
ECHO Found Python version %PYTHON_MAJOR_VERSION%.%PYTHON_MINOR_VERSION%

SET VERSION=ERROR
FOR /F "delims=" %%i IN ('%PYTHON_EXE% -c "from xpra import __version__;print(__version__)"') DO set VERSION=%%i
ECHO Packaging Xpra Version  %VERSION%
SET SVNVERSION=ERROR
FOR /F "delims=" %%i IN ('%SVNVERSION_EXE% -n ..') DO set SVNVERSION=%%i
ECHO Found svnversion       %SVNVERSION%
SET REVISION=
FOR /F "tokens=2 delims=:" %%G IN ("%SVNVERSION%") DO set REVISION=%%G
IF [%REVISION%]==[] set REVISION=%SVNVERSION%
SET FULL_VERSION=%VERSION%-r%REVISION%
ECHO Full version           %FULL_VERSION%


REM Use a custom script to move the PyOpenGL bits back into the library.zip
REM (ugly, but hacking py2exe is worse?)
REM This directory may not exist when doing a Python3 build against newer gobject bindings..
IF EXIST "%DIST%\OpenGL" (
	ECHO ****** Moving OpenGL into library.zip
	ECHO %PYTHON_EXE% win32\move_to_zip.py %DIST%\library.zip %DIST% OpenGL
	%PYTHON_EXE% win32\move_to_zip.py %DIST%\library.zip %DIST% OpenGL
)

ECHO ****** Generating HTML Manual Page
REM "Add mingw to the path unconditionally so we can find groff"
SET PATH=C:\MinGW\bin;C:\MinGW\msys\1.0\bin;%PATH%
groff.exe -mandoc -Thtml < man\xpra.1 > %DIST%\manual.html

ECHO ****** Adding TortoisePlink
REM "These are the versions currently used by TortoisePlink.exe: VC 2012 redist.."
REM "Use the Win7-onwards-only copy by default:"
SET TORTOISEPLINK="%XPRA_WIN32_BUILD_LIB_PREFIX%\TortoisePlink"
IF NOT EXIST "%TORTOISEPLINK%" (
	ECHO Error: '%TORTOISEPLINK%' does not exist!
	GOTO ERROR
)
ECHO Win7 onwards copy of TortoisePlink found in %TORTOISEPLINK%
COPY /Y %TORTOISEPLINK%\TortoisePlink.exe %DIST%\Plink.exe > NUL
COPY /Y %TORTOISEPLINK%\*.dll %DIST%\ > NUL
SET TORTOISEPLINK_XP="%XPRA_WIN32_BUILD_LIB_PREFIX%\TortoisePlink-XP"
IF NOT EXIST "%TORTOISEPLINK_XP%" (
	ECHO Error: '%TORTOISEPLINK_XP%' does not exist!
	GOTO ERROR
)
ECHO XP version of TortoisePlink found in %TORTOISEPLINK_XP%
MKDIR %DIST%\TortoisePlink-XP
COPY /B /Y /V "%TORTOISEPLINK_XP%\msvcr110.dll" %DIST%\TortoisePlink-XP\ > NUL
COPY /B /Y /V "%TORTOISEPLINK_XP%\msvcp110.dll" %DIST%\TortoisePlink-XP\ > NUL
COPY /B /Y /V "%TORTOISEPLINK_XP%\TortoisePlink.exe" %DIST%\TortoisePlink-XP\Plink.exe > NUL
COPY /B /Y /V "%TORTOISEPLINK_XP%\Putty-LICENSE.txt" %DIST%\ > NUL

if "%DO_ZIP%"=="1" (
	ECHO ***************************************************************
	ECHO ****** Creating ZIP file
	SET ZIP_DIR=Xpra%EXTRA_VERSION%%BUILD_TYPE%_%FULL_VERSION%
	SET ZIP_FILENAME=!ZIP_DIR!.zip
	IF EXIST !ZIP_DIR! (
		ECHO RD /S /Q !ZIP_DIR!
		RD /S /Q !ZIP_DIR!
	)
	IF EXIST !ZIP_FILENAME! (
		ECHO DEL !ZIP_FILENAME!
		DEL !ZIP_FILENAME!
	)
	ECHO XCOPY /S /I /X /Q %DIST% !ZIP_DIR!
	XCOPY /S /I /X /Q %DIST% !ZIP_DIR!
	ECHO %ZIP7% a -r !ZIP_FILENAME! !ZIP_DIR! ^> NUL
	%ZIP7% a -r !ZIP_FILENAME! !ZIP_DIR! > NUL
	dir !ZIP_FILENAME!
)

if "%DO_INSTALLER%"=="1" (
	ECHO ***************************************************************
	ECHO ****** Creating the installer using InnoSetup:
	SET INSTALLER_FILENAME=Xpra%EXTRA_VERSION%%BUILD_TYPE%_Setup_%FULL_VERSION%.exe
	SET INNOSETUP_LOG=win32\innosetup.log
	DEL /Q Xpra_Setup.exe !INSTALLER_FILENAME! !INNOSETUP_LOG! 2> NUL
	COPY /Y win32\xpra.iss xpra.iss > NUL
	ECHO %INNOSETUP% xpra.iss ^> !INNOSETUP_LOG!
	%INNOSETUP% xpra.iss > !INNOSETUP_LOG!
	if %ERRORLEVEL% NEQ 0 (
		ECHO InnoSetup error, see !INNOSETUP_LOG!
		GOTO ERROR
	)

	ECHO ***************************************************************
	ECHO ****** Finished - running the new installer
	MOVE /Y Output\Xpra_Setup.exe !INSTALLER_FILENAME!
	RMDIR Output
	dir !INSTALLER_FILENAME!
	if "%RUN_INSTALLER%"=="1" (
		!INSTALLER_FILENAME! %ARGS%
	) else (
		ECHO ****** Not Running Installer
	)
)
GOTO END

:ERROR
pause
:END

ENDLOCAL
