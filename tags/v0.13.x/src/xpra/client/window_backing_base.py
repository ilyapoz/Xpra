# This file is part of Xpra.
# Copyright (C) 2008 Nathaniel Smith <njs@pobox.com>
# Copyright (C) 2012-2014 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

import zlib

from xpra.log import Logger
log = Logger("paint")

from threading import Lock
from xpra.net.mmap_pipe import mmap_read
from xpra.net.protocol import has_lz4, LZ4_uncompress
from xpra.util import typedict
from xpra.codecs.codec_constants import get_colorspace_from_avutil_enum, get_PIL_decodings
from xpra.codecs.loader import get_codec
from xpra.codecs.video_helper import getVideoHelper
from xpra.os_util import BytesIOClass, bytestostr, builtins
_memoryview = builtins.__dict__.get("memoryview")
try:
    from xpra.codecs.xor import xor_str
except:
    xor_str = None
#for alpha unpremultiply utility function
#(subclasses should ensure argb is present before calling it!)
try:
    from xpra.codecs.argb.argb import unpremultiply_argb, unpremultiply_argb_in_place, byte_buffer_to_buffer   #@UnresolvedImport
except:
    log.warn("argb module is missing, cannot support alpha channels")
    unpremultiply_argb, unpremultiply_argb_in_place, byte_buffer_to_buffer  = None, None, None

PIL = get_codec("PIL")

#ie:
#CSC_OPTIONS = { "YUV420P" : {"RGBX" : [opencl.spec, swscale.spec], "BGRX" : ...} }
CSC_OPTIONS = None
def load_csc_options():
    global CSC_OPTIONS
    if CSC_OPTIONS is None:
        CSC_OPTIONS = {}
        vh = getVideoHelper()
        for csc_in in vh.get_csc_inputs():
            CSC_OPTIONS[csc_in] = vh.get_csc_specs(csc_in)
    return CSC_OPTIONS

#get the list of video encodings (and the module for each one):
VIDEO_DECODERS = None
def load_video_decoders():
    global VIDEO_DECODERS
    if VIDEO_DECODERS is None:
        VIDEO_DECODERS = {}
        vh = getVideoHelper()
        for encoding in vh.get_decodings():
            specs = vh.get_decoder_specs(encoding)
            for colorspace, decoders in specs.items():
                log("%s decoders for %s: %s", encoding, colorspace, decoders)
                assert len(decoders)>0
                #use the first one:
                _, decoder_module = decoders[0]
                VIDEO_DECODERS[encoding] = decoder_module
        log("video decoders: %s", VIDEO_DECODERS)
    return VIDEO_DECODERS


def fire_paint_callbacks(callbacks, success):
    for x in callbacks:
        try:
            x(success)
        except KeyboardInterrupt:
            raise
        except:
            log.error("error calling %s(%s)", x, success, exc_info=True)


"""
Generic superclass for all Backing code,
see CairoBacking and GTKWindowBacking for actual implementations
"""
class WindowBackingBase(object):
    def __init__(self, wid, window_alpha, idle_add):
        load_csc_options()
        load_video_decoders()
        self.wid = wid
        self.idle_add = idle_add
        self._alpha_enabled = window_alpha
        self._backing = None
        self._last_pixmap_data = None
        self._video_decoder = None
        self._csc_decoder = None
        self._decoder_lock = Lock()
        self._PIL_encodings = get_PIL_decodings(PIL)
        self.draw_needs_refresh = True
        self.mmap = None
        self.mmap_enabled = False

    def enable_mmap(self, mmap_area):
        self.mmap = mmap_area
        self.mmap_enabled = True

    def close(self):
        self._backing = None
        log("%s.close() video_decoder=%s", self, self._video_decoder)
        #try without blocking, if that fails then
        #the lock is held by the decoding thread,
        #and it will run the cleanup after releasing the lock
        #(it checks for self._backing None)
        self.close_decoder(False)

    def close_decoder(self, blocking=False):
        if self._decoder_lock is None or not self._decoder_lock.acquire(blocking):
            return False
        try:
            self.do_clean_video_decoder()
            self.do_clean_csc_decoder()
            return True
        finally:
            self._decoder_lock.release()

    def do_clean_video_decoder(self):
        if self._video_decoder:
            self._video_decoder.clean()
            self._video_decoder = None

    def do_clean_csc_decoder(self):
        if self._csc_decoder:
            self._csc_decoder.clean()
            self._csc_decoder = None


    def get_encoding_properties(self):
        rgb_modes = self.RGB_MODES
        return {
                 "encodings.rgb_formats"    : rgb_modes,
                 "encoding.transparency"    : self._alpha_enabled,
                 "encoding.full_csc_modes"  : self._get_full_csc_modes(rgb_modes),
                 "encoding.csc_modes"       : self._get_csc_modes(rgb_modes)
                 }

    def _get_full_csc_modes(self, rgb_modes):
        #calculate the server CSC modes the server is allowed to use
        #based on the client CSC modes we can convert to in the backing class we use
        #and trim the transparency if we cannot handle it
        target_rgb_modes = list(rgb_modes)
        if not self._alpha_enabled:
            target_rgb_modes = [x for x in target_rgb_modes if x.find("A")<0]
        full_csc_modes = getVideoHelper().get_server_full_csc_modes_for_rgb(*target_rgb_modes)
        log("full csc modes (%s)=%s", target_rgb_modes, full_csc_modes)
        return full_csc_modes

    def _get_csc_modes(self, rgb_modes):
        #as above, but for older servers: less detailed than "full" csc modes info
        csc_modes = []
        for modes in self._get_full_csc_modes(rgb_modes).values():
            csc_modes += modes
        csc_modes = list(set(csc_modes))
        return csc_modes


    def img_data_tobytes(self, img_data):
        if _memoryview and isinstance(img_data, _memoryview):
            return img_data.tobytes()
        return img_data

    def unpremultiply(self, img_data):
        if type(img_data)==str:
            #cannot do in-place:
            assert unpremultiply_argb is not None, "missing argb.unpremultiply_argb"
            return byte_buffer_to_buffer(unpremultiply_argb(img_data))
        #assume this is a writeable buffer (ie: ctypes from mmap):
        assert unpremultiply_argb_in_place is not None, "missing argb.unpremultiply_argb_in_place"
        unpremultiply_argb_in_place(img_data)
        return img_data


    def process_delta(self, raw_data, width, height, rowstride, options):
        """
            Can be called from any thread, decompresses and xors the rgb raw_data,
            then stores it for later xoring if needed.
        """
        img_data = raw_data
        if options:
            if options.intget("zlib", 0)>0:
                img_data = zlib.decompress(raw_data)
            elif options.boolget("lz4", False):
                assert has_lz4
                img_data = LZ4_uncompress(raw_data)
        if len(img_data)!=rowstride * height:
            log.error("invalid img data %s: %s", type(img_data), str(img_data)[:256])
            raise Exception("expected %s bytes for %sx%s with rowstride=%s but received %s (%s compressed)" %
                                (rowstride * height, width, height, rowstride, len(img_data), len(raw_data)))
        delta = options.intget("delta", -1)
        rgb_data = img_data
        if delta>=0:
            if not self._last_pixmap_data:
                raise Exception("delta region references pixmap data we do not have!")
            if xor_str is None:
                raise Exception("received a delta region but we do not support delta encoding!")
            lwidth, lheight, store, ldata = self._last_pixmap_data
            assert width==lwidth and height==lheight and delta==store
            rgb_data = xor_str(img_data, ldata)
        #store new pixels for next delta:
        store = options.intget("store", -1)
        if store>=0:
            self._last_pixmap_data =  width, height, store, rgb_data
        return rgb_data


    def paint_image(self, coding, img_data, x, y, width, height, options, callbacks):
        """ can be called from any thread """
        #log("paint_image(%s, %s bytes, %s, %s, %s, %s, %s, %s)", coding, len(img_data), x, y, width, height, options, callbacks)
        assert PIL, "PIL not found"
        buf = BytesIOClass(img_data)
        img = PIL.Image.open(buf)
        assert img.mode in ("L", "P", "RGB", "RGBA"), "invalid image mode: %s" % img.mode
        transparency = options.get("transparency", -1)
        if img.mode=="P":
            if transparency>=0:
                #this deals with alpha without any extra work
                img = img.convert("RGBA")
            else:
                img = img.convert("RGB")
        elif img.mode=="L":
            if transparency>=0:
                #why do we have to deal with alpha ourselves??
                def mask_value(a):
                    if a!=transparency:
                        return 255
                    return 0
                mask = PIL.Image.eval(img, mask_value)
                mask = mask.convert("L")
                def nomask_value(a):
                    if a!=transparency:
                        return a
                    return 0
                img = PIL.Image.eval(img, nomask_value)
                img = img.convert("RGBA")
                img.putalpha(mask)
            else:
                img = img.convert("RGB")

        raw_data = img.tostring("raw", img.mode)
        paint_options = typedict(options)
        if img.mode=="RGB":
            #PIL flattens the data to a continuous straightforward RGB format:
            rowstride = width*3
            paint_options["rgb_format"] = "RGB"
            img_data = self.process_delta(raw_data, width, height, rowstride, options)
            self.idle_add(self.do_paint_rgb24, img_data, x, y, width, height, rowstride, paint_options, callbacks)
        elif img.mode=="RGBA":
            rowstride = width*4
            paint_options["rgb_format"] = "RGBA"
            img_data = self.process_delta(raw_data, width, height, rowstride, options)
            self.idle_add(self.do_paint_rgb32, img_data, x, y, width, height, rowstride, paint_options, callbacks)
        return False

    def paint_webp(self, img_data, x, y, width, height, options, callbacks):
        dec_webp = get_codec("dec_webp")
        if dec_webp:
            return self.paint_webp_using_cwebp(img_data, x, y, width, height, options, callbacks)
        return self.paint_webp_using_webm(img_data, x, y, width, height, options, callbacks)

    def paint_webp_using_cwebp(self, img_data, x, y, width, height, options, callbacks):
        dec_webp = get_codec("dec_webp")
        has_alpha = options.get("has_alpha", False)
        buffer_wrapper, width, height, stride, has_alpha, rgb_format = dec_webp.decompress(img_data, has_alpha)
        options["rgb_format"] = rgb_format
        def free_buffer(*args):
            buffer_wrapper.free()
        callbacks.append(free_buffer)
        data = buffer_wrapper.get_pixels()
        if has_alpha:
            return self.paint_rgb32(data, x, y, width, height, stride, options, callbacks)
        else:
            return self.paint_rgb24(data, x, y, width, height, stride, options, callbacks)

    def paint_webp_using_webm(self, img_data, x, y, width, height, options, callbacks):
        """ can be called from any thread """
        dec_webm = get_codec("dec_webm")
        assert dec_webm is not None, "webp decoder not found"
        paint_options = typedict(options)
        if options.get("has_alpha", False):
            decode = dec_webm.DecodeRGBA
            rowstride = width*4
            paint_rgb = self.do_paint_rgb32
            paint_options["rgb_format"] = "RGBA"
        else:
            decode = dec_webm.DecodeRGB
            rowstride = width*3
            paint_rgb = self.do_paint_rgb24
            paint_options["rgb_format"] = "RGB"
        log("paint_webp(%s) using decode=%s, paint=%s, paint_options=%s",
             ("%s bytes" % len(img_data), x, y, width, height, options, callbacks), decode, paint_rgb, paint_options)
        rgb_data = decode(img_data)
        pixels = str(rgb_data.bitmap)
        self.idle_add(paint_rgb, pixels, x, y, width, height, rowstride, paint_options, callbacks)
        return  False

    def paint_rgb24(self, raw_data, x, y, width, height, rowstride, options, callbacks):
        """ called from non-UI thread
            this method calls process_delta before calling do_paint_rgb24 from the UI thread via idle_add
        """
        rgb24_data = self.process_delta(raw_data, width, height, rowstride, options)
        self.idle_add(self.do_paint_rgb24, rgb24_data, x, y, width, height, rowstride, options, callbacks)
        return  False

    def do_paint_rgb24(self, img_data, x, y, width, height, rowstride, options, callbacks):
        """ must be called from UI thread
            this method is only here to ensure that we always fire the callbacks,
            the actual paint code is in _do_paint_rgb24
        """
        try:
            success = (self._backing is not None) and self._do_paint_rgb24(img_data, x, y, width, height, rowstride, options)
            fire_paint_callbacks(callbacks, success)
        except KeyboardInterrupt:
            raise
        except:
            log.error("do_paint_rgb24 error", exc_info=True)
            fire_paint_callbacks(callbacks, False)

    def _do_paint_rgb24(self, img_data, x, y, width, height, rowstride, options):
        raise Exception("override me!")


    def paint_rgb32(self, raw_data, x, y, width, height, rowstride, options, callbacks):
        """ called from non-UI thread
            this method calls process_delta before calling do_paint_rgb32 from the UI thread via idle_add
        """
        rgb32_data = self.process_delta(raw_data, width, height, rowstride, options)
        self.idle_add(self.do_paint_rgb32, rgb32_data, x, y, width, height, rowstride, options, callbacks)
        return  False

    def do_paint_rgb32(self, img_data, x, y, width, height, rowstride, options, callbacks):
        """ must be called from UI thread
            this method is only here to ensure that we always fire the callbacks,
            the actual paint code is in _do_paint_rgb32
        """
        try:
            success = (self._backing is not None) and self._do_paint_rgb32(img_data, x, y, width, height, rowstride, options)
            fire_paint_callbacks(callbacks, success)
        except KeyboardInterrupt:
            raise
        except:
            log.error("do_paint_rgb32 error", exc_info=True)
            fire_paint_callbacks(callbacks, False)

    def _do_paint_rgb32(self, img_data, x, y, width, height, rowstride, options):
        raise Exception("override me!")


    def make_csc(self, src_width, src_height, src_format,
                       dst_width, dst_height, dst_format_options, speed):
        global CSC_OPTIONS
        in_options = CSC_OPTIONS.get(src_format, {})
        assert len(in_options)>0, "no csc options for '%s' input in %s" % (src_format, CSC_OPTIONS)
        for dst_format in dst_format_options:
            specs = in_options.get(dst_format)
            log("make_csc%s specs=%s", (src_width, src_height, src_format, dst_width, dst_height, dst_format_options, speed), specs)
            if not specs:
                continue
            for spec in specs:
                if spec.min_w>src_width or spec.min_w>dst_width or \
                   spec.max_w<src_width or spec.max_w<dst_width:
                    log("csc module %s cannot cope with dimensions %sx%s to %sx%s", spec.codec_class, src_width, src_height, dst_width, dst_height)
                    continue
                if not spec.can_scale and (src_width!=dst_width or src_height!=dst_height):
                    log("csc module %s cannot scale")
                    continue
                try:
                    csc = spec.make_instance()
                    csc.init_context(src_width, src_height, src_format,
                               dst_width, dst_height, dst_format, speed)
                    return csc
                except:
                    log.error("failed to create csc instance of %s for %s to %s", spec.codec_class, src_format, dst_format, exc_info=True)
        raise Exception("no csc module found for %s(%sx%s) to %s(%sx%s) in %s" % (src_format, src_width, src_height, " or ".join(dst_format_options), dst_width, dst_height, CSC_OPTIONS))

    def paint_with_video_decoder(self, decoder_module, coding, img_data, x, y, width, height, options, callbacks):
        #log("paint_with_video_decoder%s", (decoder_module, coding, "%s bytes" % len(img_data), x, y, width, height, options, callbacks))
        assert decoder_module, "decoder module not found for %s" % coding
        try:
            self._decoder_lock.acquire()
            if self._backing is None:
                log("window %s is already gone!", self.wid)
                fire_paint_callbacks(callbacks, False)
                return  False
            enc_width, enc_height = options.intpair("scaled_size", (width, height))
            input_colorspace = options.strget("csc")
            if not input_colorspace:
                # Backwards compatibility with pre 0.10.x clients
                # We used to specify the colorspace as an avutil PixelFormat constant
                old_csc_fmt = options.intget("csc_pixel_format")
                input_colorspace = get_colorspace_from_avutil_enum(old_csc_fmt)
                if input_colorspace is None:
                    #completely broken and out of date servers (ie: v0.3.x):
                    log("csc was not specified and we cannot find a colorspace from csc_pixel_format=%s, assuming it is an old server and using YUV420P", old_csc_fmt)
                    input_colorspace = "YUV420P"

            #do we need a prep step for decoders that cannot handle the input_colorspace directly?
            decoder_colorspaces = decoder_module.get_input_colorspaces(coding)
            assert input_colorspace in decoder_colorspaces, "decoder does not support %s for %s" % (input_colorspace, coding)

            if self._video_decoder:
                if self._video_decoder.get_encoding()!=coding:
                    log("paint_with_video_decoder: encoding changed from %s to %s", self._video_decoder.get_encoding(), coding)
                    self.do_clean_video_decoder()
                elif self._video_decoder.get_width()!=enc_width or self._video_decoder.get_height()!=enc_height:
                    log("paint_with_video_decoder: window dimensions have changed from %s to %s", (self._video_decoder.get_width(), self._video_decoder.get_height()), (enc_width, enc_height))
                    self.do_clean_video_decoder()
                elif self._video_decoder.get_colorspace()!=input_colorspace:
                    log("paint_with_video_decoder: colorspace changed from %s to %s", self._video_decoder.get_colorspace(), input_colorspace)
                    self.do_clean_video_decoder()
                elif options.get("frame")==0:
                    log("paint_with_video_decoder: first frame of new stream")
                    self.do_clean_video_decoder()
            if self._video_decoder is None:
                log("paint_with_video_decoder: new %s(%s,%s,%s)", decoder_module.Decoder, width, height, input_colorspace)
                self._video_decoder = decoder_module.Decoder()
                self._video_decoder.init_context(coding, enc_width, enc_height, input_colorspace)
                log("paint_with_video_decoder: info=%s", self._video_decoder.get_info())

            img = self._video_decoder.decompress_image(img_data, options)
            if not img:
                raise Exception("paint_with_video_decoder: wid=%s, %s decompression error on %s bytes of picture data for %sx%s pixels using %s, options=%s" % (
                      self.wid, coding, len(img_data), width, height, self._video_decoder, options))
            self.do_video_paint(img, x, y, enc_width, enc_height, width, height, options, callbacks)
        finally:
            self._decoder_lock.release()
            if self._backing is None:
                self.close_decoder(True)
        return  False

    def do_video_paint(self, img, x, y, enc_width, enc_height, width, height, options, callbacks):
        #try 24 bit first (paint_rgb24), then 32 bit (paint_rgb32):
        target_rgb_formats = ["RGB", "RGBX"]
        #as some video formats like vpx can forward transparency
        #also we could skip the csc step in some cases:
        pixel_format = img.get_pixel_format()
        if self._csc_decoder is not None:
            if self._csc_decoder.get_src_format()!=pixel_format:
                log("do_video_paint csc: switching src format from %s to %s", self._csc_decoder.get_src_format(), pixel_format)
                self.do_clean_csc_decoder()
            elif self._csc_decoder.get_dst_format() not in target_rgb_formats:
                log("do_video_paint csc: switching dst format from %s to %s", self._csc_decoder.get_dst_format(), target_rgb_formats)
                self.do_clean_csc_decoder()
            elif self._csc_decoder.get_src_width()!=enc_width or self._csc_decoder.get_src_height()!=enc_height:
                log("do_video_paint csc: switching src size from %sx%s to %sx%s",
                         enc_width, enc_height, self._csc_decoder.get_src_width(), self._csc_decoder.get_src_height())
                self.do_clean_csc_decoder()
            elif self._csc_decoder.get_dst_width()!=width or self._csc_decoder.get_dst_height()!=height:
                log("do_video_paint csc: switching src size from %sx%s to %sx%s",
                         width, height, self._csc_decoder.get_dst_width(), self._csc_decoder.get_dst_height())
                self.do_clean_csc_decoder()
        if self._csc_decoder is None:
            #use higher quality csc to compensate for lower quality source
            #(which generally means that we downscaled via YUV422P or lower)
            #or when upscaling the video:
            q = options.intget("quality", 50)
            csc_speed = int(min(100, 100-q, 100.0 * (enc_width*enc_height) / (width*height)))
            self._csc_decoder = self.make_csc(enc_width, enc_height, pixel_format,
                                           width, height, target_rgb_formats, csc_speed)
            log("do_video_paint new csc decoder: %s", self._csc_decoder)
        rgb_format = self._csc_decoder.get_dst_format()
        rgb = self._csc_decoder.convert_image(img)
        log("do_video_paint rgb using %s.convert_image(%s)=%s", self._csc_decoder, img, rgb)
        img.free()
        assert rgb.get_planes()==0, "invalid number of planes for %s: %s" % (rgb_format, rgb.get_planes())
        #make a new options dict and set the rgb format:
        paint_options = typedict(options)
        paint_options["rgb_format"] = rgb_format
        #this will also take care of firing callbacks (from the UI thread):
        def paint():
            data = rgb.get_pixels()
            rowstride = rgb.get_rowstride()
            if len(rgb_format)==3:
                self.do_paint_rgb24(data, x, y, width, height, rowstride, paint_options, callbacks)
            else:
                assert len(rgb_format)==4
                self.do_paint_rgb32(data, x, y, width, height, rowstride, paint_options, callbacks)
            rgb.free()
        self.idle_add(paint)

    def paint_mmap(self, img_data, x, y, width, height, rowstride, options, callbacks):
        """ must be called from UI thread """
        #we could run just paint_rgb24 from the UI thread,
        #but this would not make much of a difference
        #and would complicate the code (add a callback to free mmap area)
        """ see _mmap_send() in server.py for details """
        assert self.mmap_enabled
        data = mmap_read(self.mmap, img_data)
        rgb_format = options.strget("rgb_format", "RGB")
        #Note: BGR(A) is only handled by gl_window_backing
        if rgb_format in ("RGB", "BGR"):
            self.do_paint_rgb24(data, x, y, width, height, rowstride, options, callbacks)
        elif rgb_format in ("RGBA", "BGRA", "BGRX", "RGBX"):
            self.do_paint_rgb32(data, x, y, width, height, rowstride, options, callbacks)
        else:
            raise Exception("invalid rgb format: %s" % rgb_format)
        return  False


    def draw_region(self, x, y, width, height, coding, img_data, rowstride, options, callbacks):
        """ dispatches the paint to one of the paint_XXXX methods """
        log("draw_region(%s, %s, %s, %s, %s, %s bytes, %s, %s, %s)", x, y, width, height, coding, len(img_data), rowstride, options, callbacks)
        img_data = self.img_data_tobytes(img_data)
        coding = bytestostr(coding)
        if coding == "mmap":
            self.idle_add(self.paint_mmap, img_data, x, y, width, height, rowstride, options, callbacks)
        elif coding == "rgb24":
            if rowstride==0:
                rowstride = width * 3
            self.paint_rgb24(img_data, x, y, width, height, rowstride, options, callbacks)
        elif coding == "rgb32":
            if rowstride==0:
                rowstride = width * 4
            self.paint_rgb32(img_data, x, y, width, height, rowstride, options, callbacks)
        elif coding in VIDEO_DECODERS:
            self.paint_with_video_decoder(VIDEO_DECODERS.get(coding), coding, img_data, x, y, width, height, options, callbacks)
        elif coding == "webp":
            self.paint_webp(img_data, x, y, width, height, options, callbacks)
        elif coding in self._PIL_encodings:
            self.paint_image(coding, img_data, x, y, width, height, options, callbacks)
        else:
            self.do_draw_region(x, y, width, height, coding, img_data, rowstride, options, callbacks)

    def do_draw_region(self, x, y, width, height, coding, img_data, rowstride, options, callbacks):
        raise Exception("invalid encoding: %s" % coding)
