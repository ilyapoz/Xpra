# This file is part of Xpra.
# Copyright (C) 2008 Nathaniel Smith <njs@pobox.com>
# Copyright (C) 2012, 2013 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

from gtk import gdk
import gobject
import os

from xpra.log import Logger
log = Logger()

from xpra.client.gtk_base.gtk_window_backing_base import GTKWindowBacking
from xpra.client.window_backing_base import PIL, fire_paint_callbacks

use_PIL = bool(PIL) and os.environ.get("XPRA_USE_PIL", "1")=="1"


"""
This is the gtk2 version.
(works much better than gtk3!)
Superclass for PixmapBacking and GLBacking
"""
class GTK2WindowBacking(GTKWindowBacking):

    def __init__(self, wid, w, h, has_alpha):
        GTKWindowBacking.__init__(self, wid)
        self._has_alpha = has_alpha

    def init(self, w, h, has_alpha):
        raise Exception("override me!")


    def paint_image(self, coding, img_data, x, y, width, height, options, callbacks):
        """ can be called from any thread """
        if use_PIL:
            return GTKWindowBacking.paint_image(self, coding, img_data, x, y, width, height, options, callbacks)
        #gdk needs UI thread:
        gobject.idle_add(self.paint_pixbuf_gdk, coding, img_data, x, y, width, height, options, callbacks)
        return  False

    def paint_pixbuf_gdk(self, coding, img_data, x, y, width, height, options, callbacks):
        """ must be called from UI thread """
        loader = gdk.PixbufLoader(coding)
        loader.write(img_data, len(img_data))
        loader.close()
        pixbuf = loader.get_pixbuf()
        if not pixbuf:
            log.error("failed %s pixbuf=%s data len=%s" % (coding, pixbuf, len(img_data)))
            fire_paint_callbacks(callbacks, False)
            return  False
        raw_data = pixbuf.get_pixels()
        rowstride = pixbuf.get_rowstride()
        img_data = self.process_delta(raw_data, width, height, rowstride, options)
        self.do_paint_rgb24(img_data, x, y, width, height, rowstride, options, callbacks)
        return False
