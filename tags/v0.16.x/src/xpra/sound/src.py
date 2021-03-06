#!/usr/bin/env python
# This file is part of Xpra.
# Copyright (C) 2010-2015 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

import os
import sys
import time

from xpra.os_util import SIGNAMES, Queue
from xpra.util import csv
from xpra.sound.sound_pipeline import SoundPipeline, gobject
from xpra.gtk_common.gobject_util import n_arg_signal
from xpra.sound.gstreamer_util import get_source_plugins, plugin_str, get_encoder_formatter, normv, get_codecs, get_gst_version, \
                                MP3, CODEC_ORDER, ENCODER_DEFAULT_OPTIONS, MUXER_DEFAULT_OPTIONS, ENCODER_NEEDS_AUDIOCONVERT, SOURCE_NEEDS_AUDIOCONVERT, MS_TO_NS
from xpra.scripts.config import InitExit
from xpra.log import Logger
log = Logger("sound")

APPSINK = os.environ.get("XPRA_SOURCE_APPSINK", "appsink name=sink emit-signals=true max-buffers=10 drop=true sync=false async=false qos=false")
JITTER = int(os.environ.get("XPRA_SOUND_SOURCE_JITTER", "0"))


class SoundSource(SoundPipeline):

    __gsignals__ = SoundPipeline.__generic_signals__.copy()
    __gsignals__.update({
        "new-buffer"    : n_arg_signal(2),
        })

    def __init__(self, src_type=None, src_options={}, codecs=get_codecs(), codec_options={}, volume=1.0):
        if not src_type:
            from xpra.sound.pulseaudio_util import get_pa_device_options
            monitor_devices = get_pa_device_options(True, False)
            log.info("found pulseaudio monitor devices: %s", monitor_devices)
            if len(monitor_devices)==0:
                log.warn("could not detect any pulseaudio monitor devices")
                log.warn(" a test source will be used instead")
                src_type = "audiotestsrc"
                default_src_options = {"wave":2, "freq":100, "volume":0.4}
            else:
                monitor_device = monitor_devices.items()[0][0]
                log.info("using pulseaudio source device:")
                log.info(" '%s'", monitor_device)
                src_type = "pulsesrc"
                default_src_options = {"device" : monitor_device}
            src_options = default_src_options
        if src_type not in get_source_plugins():
            raise InitExit(1, "invalid source plugin '%s', valid options are: %s" % (src_type, ",".join(get_source_plugins())))
        matching = [x for x in CODEC_ORDER if (x in codecs and x in get_codecs())]
        log("SoundSource(..) found matching codecs %s", matching)
        if not matching:
            raise InitExit(1, "no matching codecs between arguments '%s' and supported list '%s'" % (csv(codecs), csv(get_codecs().keys())))
        codec = matching[0]
        encoder, fmt = get_encoder_formatter(codec)
        SoundPipeline.__init__(self, codec)
        self.src_type = src_type
        source_str = plugin_str(src_type, src_options)
        #FIXME: this is ugly and relies on the fact that we don't pass any codec options to work!
        encoder_str = plugin_str(encoder, codec_options or ENCODER_DEFAULT_OPTIONS.get(encoder, {}))
        fmt_str = plugin_str(fmt, MUXER_DEFAULT_OPTIONS.get(fmt, {}))
        pipeline_els = [source_str]
        if encoder in ENCODER_NEEDS_AUDIOCONVERT or src_type in SOURCE_NEEDS_AUDIOCONVERT:
            pipeline_els += ["audioconvert"]
        pipeline_els.append("volume name=volume volume=%s" % volume)
        pipeline_els += [encoder_str,
                        fmt_str,
                        APPSINK]
        self.setup_pipeline_and_bus(pipeline_els)
        self.volume = self.pipeline.get_by_name("volume")
        self.sink = self.pipeline.get_by_name("sink")
        try:
            if get_gst_version()<(1,0):
                self.sink.set_property("enable-last-buffer", False)
            else:
                self.sink.set_property("enable-last-sample", False)
        except Exception as e:
            log("failed to disable last buffer: %s", e)
        self.caps = None
        self.skipped_caps = set()
        if JITTER>0:
            self.jitter_queue = Queue()
        try:
            #Gst 1.0:
            self.sink.connect("new-sample", self.on_new_sample)
            self.sink.connect("new-preroll", self.on_new_preroll1)
        except:
            #Gst 0.10:
            self.sink.connect("new-buffer", self.on_new_buffer)
            self.sink.connect("new-preroll", self.on_new_preroll0)

    def __repr__(self):
        return "SoundSource('%s' - %s)" % (self.pipeline_str, self.state)

    def cleanup(self):
        SoundPipeline.cleanup(self)
        self.src_type = ""
        self.sink = None
        self.caps = None

    def get_info(self):
        info = SoundPipeline.get_info(self)
        if self.caps:
            info["caps"] = self.caps
        return info


    def on_new_preroll1(self, appsink):
        sample = appsink.emit('pull-preroll')
        log('new preroll1: %s', sample)
        return self.emit_buffer1(sample)

    def on_new_sample(self, bus):
        #Gst 1.0
        sample = self.sink.emit("pull-sample")
        return self.emit_buffer1(sample)

    def emit_buffer1(self, sample):
        buf = sample.get_buffer()
        #info = sample.get_info()
        size = buf.get_size()
        extract_dup = getattr(buf, "extract_dup", None)
        if extract_dup:
            data = extract_dup(0, size)
        else:
            #crappy gi bindings detected, using workaround:
            from xpra.sound.gst_hacks import map_gst_buffer
            with map_gst_buffer(buf) as a:
                data = bytes(a[:])
        return self.emit_buffer(data, {"timestamp"  : normv(buf.pts),
                                   "duration"   : normv(buf.duration),
                                   })


    def on_new_preroll0(self, appsink):
        buf = appsink.emit('pull-preroll')
        log('new preroll0: %s bytes', len(buf))
        return self.emit_buffer0(buf)

    def on_new_buffer(self, bus):
        #pygst 0.10
        buf = self.sink.emit("pull-buffer")
        return self.emit_buffer0(buf)


    def caps_to_dict(self, caps):
        if not caps:
            return {}
        d = {}
        try:
            for cap in caps:
                name = cap.get_name()
                capd = {}
                for k in cap.keys():
                    v = cap[k]
                    if type(v) in (str, int):
                        capd[k] = cap[k]
                    elif k not in self.skipped_caps:
                        log("skipping %s cap key %s=%s of type %s", name, k, v, type(v))
                d[name] = capd
        except Exception as e:
            log.error("Error parsing '%s':", caps)
            log.error(" %s", e)
        return d

    def emit_buffer0(self, buf):
        """ convert pygst structure into something more generic for the wire """
        #none of the metadata is really needed at present, but it may be in the future:
        #metadata = {"caps"      : buf.get_caps().to_string(),
        #            "size"      : buf.size,
        #            "timestamp" : buf.timestamp,
        #            "duration"  : buf.duration,
        #            "offset"    : buf.offset,
        #            "offset_end": buf.offset_end}
        log("emit buffer: %s bytes, timestamp=%s", len(buf.data), buf.timestamp//MS_TO_NS)
        metadata = {
                   "timestamp" : normv(buf.timestamp),
                   "duration"  : normv(buf.duration)
                   }
        d = self.caps_to_dict(buf.get_caps())
        if not self.caps or self.caps!=d:
            self.caps = d
            metadata["caps"] = self.caps
        return self.emit_buffer(buf.data, metadata)

    def emit_buffer(self, data, metadata={}):
        if JITTER>0:
            #will actually emit the buffer after a random delay
            if self.jitter_queue.empty():
                #queue was empty, schedule a timer to flush it
                from random import randint
                jitter = randint(1, JITTER)
                self.timeout_add(jitter, self.flush_jitter_queue)
                log("emit_buffer: will flush jitter queue in %ims", jitter)
            self.jitter_queue.put((data, metadata))
            return 0
        log("emit_buffer data=%s, len=%i, metadata=%s", type(data), len(data), metadata)
        return self.do_emit_buffer(data, metadata)

    def flush_jitter_queue(self):
        while not self.jitter_queue.empty():
            d,m = self.jitter_queue.get(False)
            self.do_emit_buffer(d, m)

    def do_emit_buffer(self, data, metadata={}):
        self.buffer_count += 1
        self.byte_count += len(data)
        metadata["time"] = int(time.time()*1000)
        self.idle_emit("new-buffer", data, metadata)
        self.emit_info()
        return 0


gobject.type_register(SoundSource)


def main():
    from xpra.platform import init, clean
    init("Xpra-Sound-Source")
    try:
        import os.path
        if "-v" in sys.argv:
            log.enable_debug()
            sys.argv.remove("-v")

        if len(sys.argv) not in (2, 3):
            log.error("usage: %s filename [codec] [--encoder=rencode]", sys.argv[0])
            return 1
        filename = sys.argv[1]
        if filename=="-":
            from xpra.os_util import disable_stdout_buffering
            disable_stdout_buffering()
        elif os.path.exists(filename):
            log.error("file %s already exists", filename)
            return 1
        codec = None

        codecs = get_codecs()
        if len(sys.argv)==3:
            codec = sys.argv[2]
            if codec not in codecs:
                log.error("invalid codec: %s, codecs supported: %s", codec, codecs)
                return 1
        else:
            parts = filename.split(".")
            if len(parts)>1:
                extension = parts[-1]
                if extension.lower() in codecs:
                    codec = extension.lower()
                    log.info("guessed codec %s from file extension %s", codec, extension)
            if codec is None:
                codec = MP3
                log.info("using default codec: %s", codec)

        #in case we're running against pulseaudio,
        #try to setup the env:
        try:
            from xpra.platform.paths import get_icon_filename
            f = get_icon_filename("xpra.png")
            from xpra.sound.pulseaudio_util import add_audio_tagging_env
            add_audio_tagging_env(icon_path=f)
        except Exception as e:
            log.warn("failed to setup pulseaudio tagging: %s", e)

        from threading import Lock
        if filename=="-":
            f = sys.stdout
        else:
            f = open(filename, "wb")
        ss = SoundSource(codecs=[codec])
        lock = Lock()
        def new_buffer(ss, data, metadata):
            log.info("new buffer: %s bytes (%s), metadata=%s", len(data), type(data), metadata)
            with lock:
                if f:
                    f.write(data)
                    f.flush()

        from xpra.gtk_common.gobject_compat import import_glib
        glib = import_glib()
        glib_mainloop = glib.MainLoop()

        ss.connect("new-buffer", new_buffer)
        ss.start()

        import signal
        def deadly_signal(sig, frame):
            log.warn("got deadly signal %s", SIGNAMES.get(sig, sig))
            glib.idle_add(ss.stop)
            glib.idle_add(glib_mainloop.quit)
            def force_quit(sig, frame):
                sys.exit()
            signal.signal(signal.SIGINT, force_quit)
            signal.signal(signal.SIGTERM, force_quit)
        from xpra.gtk_common.gobject_compat import is_gtk3
        if not is_gtk3():
            signal.signal(signal.SIGINT, deadly_signal)
        signal.signal(signal.SIGTERM, deadly_signal)

        try:
            glib_mainloop.run()
        except Exception as e:
            log.error("main loop error: %s", e)
        ss.stop()

        f.flush()
        if f!=sys.stdout:
            log.info("wrote %s bytes to %s", f.tell(), filename)
        with lock:
            f.close()
            f = None
        return 0
    finally:
        clean()


if __name__ == "__main__":
    sys.exit(main())
