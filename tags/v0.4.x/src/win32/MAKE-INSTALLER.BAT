ECHO OFF

REM "*********CHANGE THESE BEFORE RUNNING**************"
SET PYTHON=C:\Python27
SET PYTHON_EXE=%PYTHON%\python.exe
SET INNOSETUP="C:\Program Files\Inno Setup 5\ISCC.exe"
SET BUILD_DIR=build
REM "*********CHANGE THESE BEFORE RUNNING**************"

REM "SET THESE TO 0 TO DISABLE VPX/X264:"
SET X264=1
SET VPX=1


REM "*** These are the DLLs you are looking for:"
REM 6fda4c0ef8715eead5b8cec66512d3c8  Microsoft.VC90.CRT/Microsoft.VC90.CRT.manifest
REM 4a8bc195abdc93f0db5dab7f5093c52f  Microsoft.VC90.CRT/msvcm90.dll
REM 6de5c66e434a9c1729575763d891c6c2  Microsoft.VC90.CRT/msvcp90.dll
REM e7d91d008fe76423962b91c43c88e4eb  Microsoft.VC90.CRT/msvcr90.dll
REM f6a85f3b0e30c96c993c69da6da6079e  Microsoft.VC90.CRT/vcomp90.dll
REM 17683bda76942b55361049b226324be9  Microsoft.VC90.MFC/Microsoft.VC90.MFC.manifest
REM 462ddcc5eb88f34aed991416f8e354b2  Microsoft.VC90.MFC/mfc90.dll
REM b9030d821e099c79de1c9125b790e2da  Microsoft.VC90.MFC/mfc90u.dll
REM d4e7c1546cf3131b7d84b39f8da9e321  Microsoft.VC90.MFC/mfcm90.dll
REM 371226b8346f29011137c7aa9e93f2f6  Microsoft.VC90.MFC/mfcm90u.dll


ECHO ****** Clearing build directory
RMDIR /S /Q %BUILD_DIR% dist Output
DEL /Q Xpra_Setup.exe
DEL /Q xpra\x264\win32\codec.pyd
DEL /Q xpra\x264\codec.pyd
DEL /Q xpra\vpx\win32\codec.pyd
DEL /Q xpra\vpx\codec.pyd

ECHO ***************************************************************
ECHO ****** Hack for x264/vpx:
ECHO ****** build x264/vpx pyd and place it where it should be...
SET BUILD_ARGS=
IF %X264% NEQ 1 SET BUILD_ARGS=%BUILD_ARGS% --without-x264
IF %VPX% NEQ 1 SET BUILD_ARGS=%BUILD_ARGS% --without-vpx

ECHO %PYTHON_EXE% -OO setup.py build %BUILD_ARGS%
%PYTHON_EXE% -OO setup.py build %BUILD_ARGS% > build-xpra.log
if %errorlevel% NEQ 0 (
	ECHO "build error, see build-xpra.log"
	GOTO:EOF
)
IF %X264% NEQ 1 GOTO:NO_X264
SET X264_CODEC_PYD=build\lib.win32-2.7\xpra\x264\codec.pyd
COPY %X264_CODEC_PYD% xpra\x264\
if %errorlevel% NEQ 0 (
	ECHO "build error: cannot find compiled x264 codec.pyd"
	GOTO:EOF
)
:NO_X264
IF %VPX% NEQ 1 GOTO:NO_VPX
SET VPX_CODEC_PYD=build\lib.win32-2.7\xpra\vpx\codec.pyd
COPY %VPX_CODEC_PYD% xpra\vpx\
if %errorlevel% NEQ 0 (
	ECHO "build error: cannot find compiled vpx codec.pyd"
	GOTO:EOF
)
:NO_VPX

ECHO ***************************************************************
ECHO ****** py2exe
%PYTHON_EXE% -OO setup.py py2exe > py2exe-xpra.log
if %errorlevel% NEQ 0 (
	ECHO "py2exe error, see py2exe-xpra.log"
	GOTO:EOF
)

ECHO ***************************************************************
ECHO ****** InnoSetup
COPY win32\xpra.iss xpra.iss
%INNOSETUP% xpra.iss > innosetup.log
ECHO returncode: %errorlevel%
if %errorlevel% NEQ 0 (
	ECHO "InnoSetup error"
	GOTO:EOF
)
dir Output
MOVE /Y Output\Xpra_Setup.exe Xpra_Setup.exe
RMDIR Output

Xpra_Setup.exe
