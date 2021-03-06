#!/usr/bin/env python
# This file is part of Xpra.
# Copyright (C) 2011-2014 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

import dbus
from xpra.log import Logger
log = Logger("dbus")


class DBusHelper(object):

    def __init__(self):
        from xpra.x11.dbus_common import init_session_bus
        self.bus = init_session_bus()

    def call_function(self, bus_name, path, interface, function, args, ok_cb, err_cb):
        try:
            #remote_object = self.bus.get_object("com.example.SampleService","/SomeObject")
            obj = self.bus.get_object(bus_name, path)
            log("dbus.get_object(%s, %s)=%s", bus_name, path, obj)
        except dbus.DBusException:
            msg = "failed to locate object at: %s:%s" % (bus_name, path)
            log("DBusHelper: %s", msg)
            err_cb(msg)
            return
        try:
            fn = obj.get_dbus_method(function, interface)
            log("%s.get_dbus_method(%s, %s)=%s", obj, function, interface, fn)
        except:
            msg = "failed to locate remote function '%s' on %s" % (function, obj)
            log("DBusHelper: %s", msg)
            err_cb(msg)
            return
        try:
            log("calling %s(%s)", fn, args)
            keywords = {"dbus_interface"        : interface,
                        "reply_handler"         : ok_cb,
                        "error_handler"         : err_cb}
            fn.call_async(*args, **keywords)
        except Exception, e:
            msg = "error invoking %s on %s: %s" % (function, obj, e)
            log("DBusHelper: %s", msg)
            err_cb(msg)

    def dbus_to_native(self, value):
        #log("dbus_to_native(%s) type=%s", value, type(value))
        if value is None:
            return None
        elif isinstance(value, int):
            return int(value)
        elif isinstance(value, long):
            return long(value)
        elif isinstance(value, dict):
            d = {}
            for k,v in value.items():
                d[self.dbus_to_native(k)] = self.dbus_to_native(v)
            return d
        elif isinstance(value, unicode):
            return str(value)
        elif isinstance(value, basestring):
            return str(value)
        elif isinstance(value, float):
            return float(value)
        elif isinstance(value, list):
            return [self.dbus_to_native(x) for x in value]
        return value
