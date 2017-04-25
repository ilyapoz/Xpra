# coding=utf8
# This file is part of Xpra.
# Copyright (C) 2017 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

import os
import sys

from xpra.os_util import WIN32
from xpra.codecs.image_wrapper import ImageWrapper
from xpra.codecs.codec_constants import TransientCodecException
from xpra.codecs.nv_util import get_nvidia_module_version, get_cards

from xpra.log import Logger
log = Logger("encoder", "nvfbc")

import ctypes
from ctypes import wintypes

from libc.stdint cimport uintptr_t, uint8_t, int64_t
from xpra.monotonic_time cimport monotonic_time


ctypedef unsigned long DWORD
ctypedef int BOOL

cdef extern from "string.h":
    void* memset(void * ptr, int value, size_t num)

cdef extern from "NvFBC/nvFBC.h":
    ctypedef int NVFBCRESULT
    ctypedef unsigned long NvU32

    int NVFBC_DLL_VERSION
    int NVFBC_GLOBAL_FLAGS_NONE
    #deprecated:
    #int NVFBC_GLOBAL_FLAGS_STEREO_BUFFER
    int NVFBC_GLOBAL_FLAGS_NO_INITIAL_REFRESH
    int NVFBC_GLOBAL_FLAGS_NO_DEVICE_RESET_TOGGLE

    int NVFBC_CREATE_PARAMS_VER
    int NVFBC_STATUS_VER
    int NVFBC_CURSOR_CAPTURE_PARAMS_VER

    NVFBCRESULT NVFBC_SUCCESS
    NVFBCRESULT NVFBC_ERROR_GENERIC                     # Unexpected failure in NVFBC.
    NVFBCRESULT NVFBC_ERROR_INVALID_PARAM               # One or more of the paramteres passed to NvFBC are invalid [This include NULL pointers].
    NVFBCRESULT NVFBC_ERROR_INVALIDATED_SESSION         # NvFBC session is invalid. Client needs to recreate session.
    NVFBCRESULT NVFBC_ERROR_PROTECTED_CONTENT           # Protected content detected. Capture failed.
    NVFBCRESULT NVFBC_ERROR_DRIVER_FAILURE              # GPU driver returned failure to process NvFBC command.
    NVFBCRESULT NVFBC_ERROR_CUDA_FAILURE                # CUDA driver returned failure to process NvFBC command.
    NVFBCRESULT NVFBC_ERROR_UNSUPPORTED                 # API Unsupported on this version of NvFBC.
    NVFBCRESULT NVFBC_ERROR_HW_ENC_FAILURE              # HW Encoder returned failure to process NVFBC command.
    NVFBCRESULT NVFBC_ERROR_INCOMPATIBLE_DRIVER         # NVFBC is not compatible with this version of the GPU driver.
    NVFBCRESULT NVFBC_ERROR_UNSUPPORTED_PLATFORM        # NVFBC is not supported on this platform.
    NVFBCRESULT NVFBC_ERROR_OUT_OF_MEMORY               # Failed to allocate memory.
    NVFBCRESULT NVFBC_ERROR_INVALID_PTR                 # A NULL pointer was passed.
    NVFBCRESULT NVFBC_ERROR_INCOMPATIBLE_VERSION        # An API was called with a parameter struct that has an incompatible version. Check dwVersion field of paramter struct.
    NVFBCRESULT NVFBC_ERROR_OPT_CAPTURE_FAILURE         # Desktop Capture failed.
    NVFBCRESULT NVFBC_ERROR_INSUFFICIENT_PRIVILEGES     # User doesn't have appropriate previlages.
    NVFBCRESULT NVFBC_ERROR_INVALID_CALL                # NVFBC APIs called in wrong sequence.
    NVFBCRESULT NVFBC_ERROR_SYSTEM_ERROR                # Win32 error.
    NVFBCRESULT NVFBC_ERROR_INVALID_TARGET              # The target adapter idx can not be used for NVFBC capture. It may not correspond to an NVIDIA GPU, or may not be attached to desktop.
    NVFBCRESULT NVFBC_ERROR_NVAPI_FAILURE               # NvAPI Error
    NVFBCRESULT NVFBC_ERROR_DYNAMIC_DISABLE             # NvFBC is dynamically disabled. Cannot continue to capture

    ctypedef int NVFBC_STATE
    NVFBC_STATE NVFBC_STATE_DISABLE
    NVFBC_STATE NVFBC_STATE_ENABLE

    # Defines parameters that describe the grabbed data,
    # and provides detailed information about status of the NVFBC session.
    ctypedef struct NvFBCFrameGrabInfo:
        DWORD   dwWidth                 #[out] Indicates the current width of captured buffer.
        DWORD   dwHeight                #[out] Indicates the current height of captured buffer.
        DWORD   dwBufferWidth           #[out] Indicates the current width of the pixel buffer(padded width).
        DWORD   dwReserved              #[out] Reserved, do not use.
        BOOL    bOverlayActive          #[out] Is set to 1 if overlay was active.
        BOOL    bMustRecreate           #[out] Is set to 1 if the compressor must call NvBFC_Create again.
        BOOL    bFirstBuffer            #[out] Is set to 1 is this was the first capture call, or first call after a desktop mode change.
                                        # Relevant only for XOR and diff modes supported by NVFBCToSys interface.
        BOOL    bHWMouseVisible         #[out] Is set to 1 if HW cursor was enabled by OS at the time of the grab.
        BOOL    bProtectedContent       #[out] Is set to 1 if protected content was active (DXVA encryption Session).
        DWORD   dwDriverInternalError   #[out] To be used as diagnostic info if Grab() fails. Status is non-fatal if Grab() returns success.
                                        # Indicates the status code from lower layers. 0 or 0xFBCA11F9 indicates no error was returned.
        BOOL    bStereoOn               #[out] Is set to 1 if stereo was on.
        BOOL    bIGPUCapture            #[out] Is set to 1 if the captured frame is from iGPU. 0 if capture fails or if captured from dGPU*/
        DWORD   dwSourcePID             #[out] Indicates which process caused the last screen update that got grabbed*/
        DWORD   dwReserved3             #[out] Reserved, do not use.
        DWORD   bIsHDR                  #[out] Is set to 1 if grabbed content is in HDR format.
        #DWORD   bReservedBit1           #[out] Reserved, do not use.
        #DWORD   bReservedBits           #[out] Reserved, do not use.
        DWORD   dwWaitModeUsed          #[out] The mode used for this Grab operation (blocking or non-blocking), based on the grab flags passed by the application.
                                        # Actual blocking mode can differ from application's request if incorrect grab flags are passed.
        #NvU32   dwReserved2[11]         #[in] Resereved, should be set to 0.

    # Defines the parameters to be used with NvFBC_GetStatusEx API
    ctypedef struct NvFBCStatusEx:
        NvU32  dwVersion                #[in]  Struct version. Set to NVFBC_STATUS_VER.
        NvU32  bIsCapturePossible       #[out] Indicates if NvFBC feature is enabled.
        NvU32  bCurrentlyCapturing      #[out] Indicates if NVFBC is currently capturing for the Adapter ordinal specified in dwAdapterIdx.
        NvU32  bCanCreateNow            #[out] Deprecated. Do not use.
        NvU32  bSupportMultiHead        #[out] MultiHead grab supported.
        NvU32  bSupport16x16DiffMap     #[out] 16x16 difference map supported.
        #NvU32  bReservedBits            #[in]  Reserved, do not use.
        NvU32  dwNvFBCVersion           #[out] Indicates the highest NvFBC interface version supported by the loaded NVFBC library.
        NvU32  dwAdapterIdx             #[in]  Adapter Ordinal corresponding to the display to be grabbed. IGNORED if bCapturePID is set
        void*  pPrivateData             #[in]  optional **/
        NvU32  dwPrivateDataSize        #[in]  optional **/
        NvU32  dwReserved[59]           #[in]  Reserved. Should be set to 0.
        void*  pReserved[31]            #[in]  Reserved. Should be set to NULL.

    # Defines the parameters to be used with NvFBC_CreateEx API
    ctypedef struct NvFBCCreateParams:
        NvU32  dwVersion                #[in]  Struct version. Set to NVFBC_CREATE_PARAMS_VER.
        NvU32  dwInterfaceType          #[in]  ID of the NVFBC interface Type being requested.
        NvU32  dwMaxDisplayWidth        #[out] Max. display width allowed.
        NvU32  dwMaxDisplayHeight       #[out] Max. display height allowed.
        void*  pDevice                  #[in]  Device pointer.
        void*  pPrivateData             #[in]  Private data [optional]. 
        NvU32  dwPrivateDataSize        #[in]  Size of private data.
        NvU32  dwInterfaceVersion       #[in]  Version of the capture interface.
        void*  pNvFBC                   #[out] A pointer to the requested NVFBC object.
        NvU32  dwAdapterIdx             #[in]  Adapter Ordinal corresponding to the display to be grabbed. If pDevice is set, this parameter is ignored.
        NvU32  dwNvFBCVersion           #[out] Indicates the highest NvFBC interface version supported by the loaded NVFBC library.
        void*  cudaCtx                  #[in]  CUDA context created using cuD3D9CtxCreate with the D3D9 device passed as pDevice. Only used for NvFBCCuda interface.
                                        # It is mandatory to pass a valid D3D9 device if cudaCtx is passed. The call will fail otherwise.
                                        # Client must release NvFBCCuda object before destroying the cudaCtx.
        void*  pPrivateData2            #[in]  Private data [optional]. 
        NvU32  dwPrivateData2Size       #[in]  Size of private data.
        #NvU32  dwReserved[55]           #[in]  Reserved. Should be set to 0.
        #void*  pReserved[27]            #[in]  Reserved. Should be set to NULL.

    # Defines parameters for a Grab\Capture call to get HW cursor data in the NVFBCToSys capture session
    ctypedef struct NVFBC_CURSOR_CAPTURE_PARAMS:
        NvU32 dwVersion                 #[in]:  Struct version. Set to NVFBC_MOUSE_GRAB_INFO_VER
        NvU32 dwWidth                   #[out]: Width of mouse glyph captured
        NvU32 dwHeight                  #[out]: Height of mouse glyph captured
        NvU32 dwPitch                   #[out]: Pitch of mouse glyph captured
        NvU32 bIsHwCursor               #[out]: Tells if cursor is HW cursor or SW cursor. If set to 0, ignore height, width, pitch and pBits
        #NvU32 bReserved : 32           #[in]:  Reserved
        NvU32 dwPointerFlags            #[out]: Maps to DXGK_POINTERFLAGS::Value
        NvU32 dwXHotSpot                #[out]: Maps to DXGKARG_SETPOINTERSHAPE::XHot
        NvU32 dwYHotSpot                #[out]: Maps to DXGKARG_SETPOINTERSHAPE::YHot
        NvU32 dwUpdateCounter           #[out]: Cursor update Counter.
        NvU32 dwBufferSize              #[out]: Size of the buffer contaiing the captured cursor glyph.
        void * pBits                    #[out]: pointer to buffer containing the captured cursor glyph
        NvU32 dwReservedA[22]           #[in]:  Reserved. Set to 0
        void * pReserved[15]            #[in]:  Reserved. Set to 0

    # NVFBC API to set global overrides
    # param [in] dwFlags Global overrides for NVFBC. Use ::NVFBC_GLOBAL_FLAGS value.
    void NvFBC_SetGlobalFlags(DWORD dwFlags)

    # NVFBC API to create an NVFBC capture session.
    # Instantiates an interface identified by NvFBCCreateParams::dwInterfaceType.
    # param [inout] pCreateParams Pointer to a struct of type ::NvFBCCreateParams, typecast to void*
    # return An applicable ::NVFBCRESULT value.
    NVFBCRESULT NvFBC_CreateEx(void * pCreateParams)

    # NVFBC API to query Current NVFBC status.
    # Queries the status for the adapter pointed to by the NvFBCStatusEx::dwAdapterIdx parameter.
    # [inout] pCreateParams Pointer to a struct of type ::NvFBCStatusEx.
    # return An applicable ::NVFBCRESULT value.
    NVFBCRESULT NvFBC_GetStatusEx(NvFBCStatusEx *pNvFBCStatusEx)

    # NVFBC API to enable \ disable NVFBC feature.
    # param [in] nvFBCState Refer ::NVFBC_STATE
    # return An applicable ::NVFBCRESULT value.
    NVFBCRESULT NvFBC_Enable(NVFBC_STATE nvFBCState)

    # NVFBC API to query highest GRID SDK version supported by the loaded NVFBC library.
    # param [out] pVersion Pointer to a 32-bit integer to hold the supported GRID SDK version.
    # return An applicable ::NVFBCRESULT value.
    NVFBCRESULT NvFBC_GetSDKVersion(NvU32 * pVersion)


cdef extern from "NvFBC/nvFBCToSys.h":
    int NVFBC_TO_SYS
    int NVFBC_TOSYS_SETUP_PARAMS_VER
    int NVFBC_TOSYS_GRAB_FRAME_PARAMS_VER

    ctypedef int NVFBCToSysBufferFormat
    NVFBCToSysBufferFormat NVFBC_TOSYS_ARGB         # 32bpp, one byte per channel.
    NVFBCToSysBufferFormat NVFBC_TOSYS_RGB          # 24bpp, one byte per channel.
    NVFBCToSysBufferFormat NVFBC_TOSYS_YYYYUV420p   # 12bpp, the Y' channel at full resolution, U channel at half resolution (1 byte for four pixels), V channel at half resolution.
    NVFBCToSysBufferFormat NVFBC_TOSYS_RGB_PLANAR   # 24bpp, stored sequentially in memory as complete red channel, complete green channel, complete blue channel.
    NVFBCToSysBufferFormat NVFBC_TOSYS_XOR          # RGB format: 24bpp XOR�d with the prior frame.
    NVFBCToSysBufferFormat NVFBC_TOSYS_YUV444p      # Output Pixels in YUV444 planar format, i.e. separate 8-bpp Y, U, V planes with no subsampling.
    NVFBCToSysBufferFormat NVFBC_TOSYS_ARGB10       # RGB 10 bit format: A2B10G10R10, 32bpp.

    ctypedef int  NVFBCToSysGrabMode
    NVFBCToSysGrabMode NVFBC_TOSYS_SOURCEMODE_FULL  # Grab full res
    NVFBCToSysGrabMode NVFBC_TOSYS_SOURCEMODE_SCALE # Will convert current res to supplied resolution (dwTargetWidth and dwTargetHeight)
    NVFBCToSysGrabMode NVFBC_TOSYS_SOURCEMODE_CROP  # Native res, crops a subwindow, of dwTargetWidth and dwTargetHeight sizes, starting at dwStartX and dwStartY

    ctypedef int NVFBC_TOSYS_GRAB_FLAGS
    NVFBC_TOSYS_GRAB_FLAGS NVFBC_TOSYS_NOFLAGS      # Default (no flags set). Grabbing will wait for a new frame or HW mouse move.
    NVFBC_TOSYS_GRAB_FLAGS NVFBC_TOSYS_NOWAIT       # Grabbing will not wait for a new frame nor a HW cursor move.
    NVFBC_TOSYS_GRAB_FLAGS NVFBC_TOSYS_WAIT_WITH_TIMEOUT # Grabbing will wait for a new frame or HW mouse move with a maximum wait time of NVFBC_TOSYS_GRAB_FRAME_PARAMS::dwWaitTime millisecond

    ctypedef struct NVFBC_TOSYS_SETUP_PARAMS_V2:
        NvU32 dwVersion                             #[in]: Struct version. Set to NVFBC_TOSYS_SETUP_PARAMS_VER
        NvU32 bWithHWCursor                         #[in]: The client should set this to 1 if it requires the HW cursor to be composited on the captured image
        NvU32 bDiffMap                              #[in]: The client should set this to use the DiffMap feature
        NvU32 bEnableSeparateCursorCapture          #[in]: The client should set this to 1 if it wants to enable mouse capture in separate stream
        NvU32 bHDRRequest                           #[in]: The client should set this to 1 to request HDR capture
        NvU32 b16x16DiffMap                         #[in]: Valid only if bDiffMap is set. The client should set this to 1 it it wants to request 16x16 Diffmap, set it to 0 if it wants 128x128 Diffmap
        #NvU32 bReservedBits :27                     #[in]: Reserved. Set to 0
        NVFBCToSysBufferFormat eMode                #[in]: Output image format
        #NvU32 dwReserved1                           #[in]: Reserved. Set to 0
        void **ppBuffer                             #[out]: Container to hold NvFBC output buffers
        void **ppDiffMap                            #[out]: Container to hold NvFBC output diffmap buffers
        void  *hCursorCaptureEvent                  #[out]: Client should wait for mouseEventHandle event before calling MouseGrab function. */
        #NvU32 dwReserved[58]                        #[in]: Reserved. Set to 0
        #void *pReserved[29]                         #[in]: Reserved. Set to 0
    ctypedef NVFBC_TOSYS_SETUP_PARAMS_V2 NVFBC_TOSYS_SETUP_PARAMS

    ctypedef struct NVFBC_TOSYS_GRAB_FRAME_PARAMS_V1:
        NvU32 dwVersion				                #[in]: Struct version. Set to NVFBC_TOSYS_GRAB_FRAME_PARAMS_VER.
        NvU32 dwFlags				                #[in]: Special grabbing requests. This should be a bit-mask of NVFBC_TOSYS_GRAB_FLAGS values.
        NvU32 dwTargetWidth				            #[in]: Target image width. NvFBC will scale the captured image to fit taret width and height. Used with NVFBC_TOSYS_SOURCEMODE_SCALE and NVFBC_TOSYS_SOURCEMODE_CROP.
        NvU32 dwTargetHeight				        #[in]: Target image height. NvFBC will scale the captured image to fit taret width and height. Used with NVFBC_TOSYS_SOURCEMODE_SCALE and NVFBC_TOSYS_SOURCEMODE_CROP.
        NvU32 dwStartX				                #[in]: x-coordinate of starting pixel for cropping. Used with NVFBC_TOSYS_SOURCEMODE_CROP.
        NvU32 dwStartY				                #[in]: y-coordinate of starting pixel for cropping. Used with NVFBC_TOSYS_SOURCEMODE_CROP.
        NVFBCToSysGrabMode eGMode				    #[in]: Frame grab mode.
        NvU32 dwWaitTime				            #[in]: Time limit for NvFBCToSysGrabFrame() to wait until a new frame is available or a HW mouse moves. Use with NVFBC_TOSYS_WAIT_WITH_TIMEOUT
        NvFBCFrameGrabInfo *pNvFBCFrameGrabInfo		#[in/out]: Frame grab information and feedback from NvFBC driver.
        NvU32 dwReserved[56]				        #[in]: Reserved. Set to 0.
        void *pReserved[31]				            #[in]: Reserved. Set to NULL.
    ctypedef NVFBC_TOSYS_GRAB_FRAME_PARAMS_V1 NVFBC_TOSYS_GRAB_FRAME_PARAMS

    # Sets up NVFBC System Memory capture according to the provided parameters.
    # [in] pParam Pointer to a struct of type ::NVFBC_TOSYS_SETUP_PARAMS.
    ctypedef NVFBCRESULT (*NVFBCTOSYSSETUP) (NVFBC_TOSYS_SETUP_PARAMS *pParam) nogil

    # Captures the desktop and dumps the captured data to a System memory buffer.
    # If the API returns a failure, the client should check the return codes and
    # ::NvFBCFrameGrabInfo output fields to determine if the session needs to be re-created.
    # [inout] pParam Pointer to a struct of type ::NVFBC_TOSYS_GRAB_FRAME_PARAMS.
    ctypedef NVFBCRESULT (*NVFBCTOSYSGRABFRAME) (NVFBC_TOSYS_GRAB_FRAME_PARAMS *pParam) nogil

    # Captures HW cursor data whenever shape of mouse is changed
    # [inout] pParam Pointer to a struct of type ::NVFBC_CURSOR_CAPTURE_PARAMS
    ctypedef NVFBCRESULT (*NVFBCTOSYSCURSORCAPTURE) (NVFBC_CURSOR_CAPTURE_PARAMS *pParam) nogil

    # A high precision implementation of Sleep(). 
    # Can provide sub quantum (usually 16ms) sleep that does not burn CPU cycles.
    # [in] qwMicroSeconds The number of microseconds that the thread should sleep for.
    ctypedef NVFBCRESULT (*NVFBCTOSYSGPUBASEDCPUSLEEP) (int64_t qwMicroSeconds) nogil

    # Destroys the NVFBCToSys capture session.
    ctypedef NVFBCRESULT (*NVFBCTOSYSRELEASE) () nogil

    ctypedef struct NvFBCToSys:
        NVFBCTOSYSSETUP NvFBCToSysSetUp
        NVFBCTOSYSGRABFRAME NvFBCToSysGrabFrame
        NVFBCTOSYSCURSORCAPTURE NvFBCToSysCursorCapture      
        NVFBCTOSYSGPUBASEDCPUSLEEP NvFBCToSysGPUBasedCPUSleep
        NVFBCTOSYSRELEASE NvFBCToSysRelease


ERRORS = {
    NVFBC_SUCCESS                       : "SUCCESS",
    NVFBC_ERROR_GENERIC                 : "GENERIC",
    NVFBC_ERROR_INVALID_PARAM           : "INVALID_PARAM",
    NVFBC_ERROR_INVALIDATED_SESSION     : "INVALIDATED_SESSION",
    NVFBC_ERROR_PROTECTED_CONTENT       : "PROTECTED_CONTENT",
    NVFBC_ERROR_DRIVER_FAILURE          : "DRIVER_FAILURE",
    NVFBC_ERROR_CUDA_FAILURE            : "CUDA_FAILURE",
    NVFBC_ERROR_UNSUPPORTED             : "UNSUPPORTED",
    NVFBC_ERROR_HW_ENC_FAILURE          : "HW_ENC_FAILURE",
    NVFBC_ERROR_INCOMPATIBLE_DRIVER     : "INCOMPATIBLE_DRIVER",
    NVFBC_ERROR_UNSUPPORTED_PLATFORM    : "UNSUPPORTED_PLATFORM",
    NVFBC_ERROR_OUT_OF_MEMORY           : "OUT_OF_MEMORY",
    NVFBC_ERROR_INVALID_PTR             : "INVALID_PTR",
    NVFBC_ERROR_INCOMPATIBLE_VERSION    : "INCOMPATIBLE_VERSION",
    NVFBC_ERROR_OPT_CAPTURE_FAILURE     : "OPT_CAPTURE_FAILURE",
    NVFBC_ERROR_INSUFFICIENT_PRIVILEGES : "INSUFFICIENT_PRIVILEGES",
    NVFBC_ERROR_INVALID_CALL            : "INVALID_CALL",
    NVFBC_ERROR_SYSTEM_ERROR            : "SYSTEM_ERROR",
    NVFBC_ERROR_INVALID_TARGET          : "INVALID_TARGET",
    NVFBC_ERROR_NVAPI_FAILURE           : "NVAPI_FAILURE",
    NVFBC_ERROR_DYNAMIC_DISABLE         : "DYNAMIC_DISABLE",
    }


cdef inline cvp(val):
    return ctypes.cast(<uintptr_t> val, ctypes.c_void_p)


class NvFBCException(Exception):
    def __init__(self, code, fn):
        self.function = fn
        self.code = code
        msg = "%s - returned %s" % (fn, ERRORS.get(code, code))
        Exception.__init__(self, msg)

cdef inline raiseNvFBC(NVFBCRESULT ret, msg):
    if ret!=0:
        raise NvFBCException(ret, msg)


NvFBC = None
def init_nvfbc_library():
    global NvFBC
    if NvFBC:
        return
    if not WIN32:
        raise Exception("nvfbc is not supported on %s" % sys.platform)
    load = ctypes.WinDLL
    #we only support 64-bit:
    nvfbc_libname = "NvFBC64.dll"
    log("init_nvfbc_library() will try to load %s", nvfbc_libname)
    try:
        NvFBC = load(nvfbc_libname)
        log("init_nvfbc_library() %s(%s)=%s", load, nvfbc_libname, NvFBC)
    except Exception as e:
        log("failed to load '%s'", nvfbc_libname, exc_info=True)
        raise ImportError("nvfbc: the required library %s cannot be loaded: %s" % (nvfbc_libname, e))
    NvFBC.NvFBC_GetSDKVersion.argtypes = [ctypes.c_void_p]
    NvFBC.NvFBC_GetSDKVersion.restype = wintypes.INT
    NvFBC.NvFBC_GetStatusEx.argtypes = [ctypes.c_void_p]
    NvFBC.NvFBC_GetStatusEx.restype = wintypes.INT
    NvFBC.NvFBC_SetGlobalFlags.argtypes = [wintypes.DWORD]
    NvFBC.NvFBC_SetGlobalFlags.restype = wintypes.INT
    NvFBC.NvFBC_Enable.argtypes = [wintypes.INT]
    NvFBC.NvFBC_Enable.restype = wintypes.INT

def unload_library():
    global NvFBC
    NvFBC = None


def get_status(int adapter=0):
    global NvFBC
    assert NvFBC
    cdef NvFBCStatusEx status
    memset(&status, 0, sizeof(NvFBCStatusEx))
    status.dwVersion = NVFBC_STATUS_VER
    status.dwAdapterIdx = adapter
    cdef NVFBCRESULT res = NvFBC.NvFBC_GetStatusEx(cvp(<uintptr_t> &status))
    log("NvFBC_GetStatusEx()=%i", res)
    raiseNvFBC(res, "NvFBC_GetStatusEx")
    s = {
        "capture-possible"      : bool(status.bIsCapturePossible),
        "currently-capturing"   : bool(status.bCurrentlyCapturing),
        "can-create-now"        : bool(status.bCanCreateNow),
        "support-multihead"     : bool(status.bSupportMultiHead),
        "support-16x16diffmap"  : bool(status.bSupport16x16DiffMap),
        "version"               : int(status.dwNvFBCVersion),
        "adapter"               : int(status.dwAdapterIdx),
        }
    log("get_status()=%s", s)
    return s

def set_global_flags(DWORD flags):
    global NvFBC
    assert NvFBC
    cdef NVFBCRESULT res = NvFBC.NvFBC_SetGlobalFlags(flags)
    log("NvFBC_SetGlobalFlags(%i)=%i", flags, res)
    raiseNvFBC(res, "NvFBC_SetGlobalFlags")

def create_context(int width=-1, int height=-1):
    log("create_context(%i, %i)", width, height)
    cdef NvFBCCreateParams create
    memset(&create, 0, sizeof(NvFBCCreateParams))
    create.dwVersion = NVFBC_CREATE_PARAMS_VER
    create.dwInterfaceType = NVFBC_TO_SYS
    create.dwMaxDisplayWidth = width
    create.dwMaxDisplayHeight = height
    #create.pDevice = 0
    create.dwInterfaceVersion = NVFBC_DLL_VERSION
    cdef NVFBCRESULT res = NvFBC.NvFBC_CreateEx(cvp(<uintptr_t> &create))
    log("NvFBC_CreateEx(%#x)=%i", <uintptr_t> &create, res)
    raiseNvFBC(res, "NvFBC_CreateEx")
    info = {
        "max-display-width"     : create.dwMaxDisplayWidth,
        "max-display-height"    : create.dwMaxDisplayHeight,
        "version"               : create.dwNvFBCVersion,
        "context"               : <uintptr_t> create.pNvFBC,
        }
    log("NvFBC_CreateEx: %s", info)
    return info

def get_version():
    global NvFBC
    assert NvFBC
    cdef NvU32 version = 0
    cdef NVFBCRESULT res = NvFBC.NvFBC_GetSDKVersion(cvp(<uintptr_t> &version))
    log("NvFBC_GetSDKVersion()=%i version=%i", res, version)
    raiseNvFBC(res, "NvFBC_GetSDKVersion")
    return version

def get_type():
    return "nvfbc"

def get_info():
    info = {
            "type"              : "nvfbc",
            "version"           : get_version(),
            }
    cards = get_cards()
    if cards:
        info["cards"] = cards
    #only show the version if we have it already (don't probe now)
    v = get_nvidia_module_version(False)
    if v:
        info["kernel_module_version"] = v
    return info


cdef class NvFBC_Capture:
    cdef NvFBCToSys *context
    cdef uint8_t *framebuffer
    cdef uint8_t setup

    cdef object __weakref__

    def init_context(self, int width=-1, int height=-1):
        status = get_status()
        if not status.get("capture-possible"):
            raise Exception("NvFBC status error: capture is not possible")
        if status.get("currently-capturing"):
            raise TransientCodecException("NvFBC status error: currently capturing")
        if not status.get("can-create-now"):
            raise TransientCodecException("NvFBC status error: cannot create now")
        info = create_context(width, height)
        self.context = <NvFBCToSys*> (<uintptr_t> info["context"])
        log("init_context(%i, %i) NvFBCToSys context=%#x", width, height, <uintptr_t> self.context)
        assert self.context!=NULL
        cdef NVFBC_TOSYS_SETUP_PARAMS params
        self.framebuffer = NULL
        memset(&params, 0, sizeof(NVFBC_TOSYS_SETUP_PARAMS))
        params.dwVersion = NVFBC_TOSYS_SETUP_PARAMS_VER
        params.eMode = NVFBC_TOSYS_ARGB
        params.bWithHWCursor = True
        params.bDiffMap = False
        params.ppBuffer = <void**> &self.framebuffer
        params.ppDiffMap = NULL
        cdef NVFBCRESULT res = self.context.NvFBCToSysSetUp(&params)
        raiseNvFBC(res, "NvFBCToSysSetUp")
        self.setup = True

    def get_info(self):
        info = get_info()
        return info

    def get_type(self):
        return  "nvfbc"

    def __repr__(self):
        return "NvFBC_Capture(%#x)" % (<uintptr_t> self.context)

    def __dealloc__(self):
        self.clean()

    def get_image(self, x=0, y=0, width=0, height=0):
        log("get_image%s", (x, y, width, height))
        cdef double start = monotonic_time()
        cdef NvFBCFrameGrabInfo grab_info
        memset(&grab_info, 0, sizeof(NvFBCFrameGrabInfo))
        cdef NVFBC_TOSYS_GRAB_FRAME_PARAMS grab
        memset(&grab, 0, sizeof(NVFBC_TOSYS_GRAB_FRAME_PARAMS))
        grab.dwVersion = NVFBC_TOSYS_GRAB_FRAME_PARAMS_VER
        grab.dwFlags = NVFBC_TOSYS_NOWAIT
        grab.dwTargetWidth = 0  #width
        grab.dwTargetHeight = 0 #height
        grab.dwStartX = x
        grab.dwStartY = y
        grab.eGMode = NVFBC_TOSYS_SOURCEMODE_FULL
        grab.pNvFBCFrameGrabInfo = &grab_info
        cdef NVFBCRESULT res
        with nogil:
            res = self.context.NvFBCToSysGrabFrame(&grab)
        if res!=0 and grab_info.bMustRecreate:
            pass    #TODO!
        if res!=0 and grab_info.dwDriverInternalError:
            pass
        if res==NVFBC_ERROR_INVALIDATED_SESSION:
            pass    #retry!
        log("NvFBCToSysGrabFrame(%#x)=%i", <uintptr_t> &grab, res)
        raiseNvFBC(res, "NvFBCToSysGrabFrame")
        info = {
            "width"             : int(grab_info.dwWidth),
            "height"            : int(grab_info.dwHeight),
            "stride"            : int(grab_info.dwBufferWidth),
            "overlay-active"    : bool(grab_info.bOverlayActive),
            "first-buffer"      : bool(grab_info.bFirstBuffer),
            "hw-mouse-visible"  : bool(grab_info.bHWMouseVisible),
            "protected-content" : bool(grab_info.bProtectedContent),
            "stereo"            : bool(grab_info.bStereoOn),
            "IGPU-capture"      : bool(grab_info.bIGPUCapture),
            "source-pid"        : int(grab_info.dwSourcePID),
            "HDR"               : bool(grab_info.bIsHDR),
            "wait-mode"         : int(grab_info.dwWaitModeUsed),
            }
        cdef double end = monotonic_time()
        log("NvFBCToSysGrabFrame: framebuffer=%#x, size=%#x, elapsed=%ims", <uintptr_t> self.framebuffer, grab_info.dwHeight*grab_info.dwBufferWidth, int((end-start)*1000))
        log("NvFBCToSysGrabFrame: info=%s", info)
        start = monotonic_time()
        #TODO: only copy when the next frame is going to overwrite the buffer,
        #or when closing the context
        buf = self.framebuffer[:grab_info.dwHeight*grab_info.dwBufferWidth*4]
        image = ImageWrapper(0, 0, int(grab_info.dwWidth), int(grab_info.dwHeight), buf, "BGRX", 32, int(grab_info.dwBufferWidth*4))
        end = monotonic_time()
        log("image=%s (copy took %ims)", image, int((end-start)*1000))
        return image

    def clean(self):                        #@DuplicatedSignature
        log("clean()")
        if self.context:
            if self.setup:
                self.setup = False
                self.context.NvFBCToSysRelease()
            self.context = NULL


def init_module():
    log("nvfbc.init_module()")
    init_nvfbc_library()

def cleanup_module():
    log("nvenc.cleanup_module()")
    unload_library()

def selftest(full=False):
    pass