# This file is part of Xpra.
# Copyright (C) 2008, 2009 Nathaniel Smith <njs@pobox.com>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

from xpra.os_util import strtobytes, bytestostr
import traceback
import sys

def dump_exc():
    """Call this from a except: clause to print a nice traceback."""
    print("".join(traceback.format_exception(*sys.exc_info())))

# A simple little class whose instances we can stick random bags of attributes
# on.
class AdHocStruct(object):
    def __repr__(self):
        return ("<%s object, contents: %r>"
                % (type(self).__name__, self.__dict__))

class typedict(dict):

    def capsget(self, key, default):
        v = self.get(strtobytes(key), default)
        if sys.version >= '3' and type(v)==bytes:
            v = bytestostr(v)
        return v

    def strget(self, k, default=None):
        v = self.capsget(k, default)
        if v is None:
            return None
        return str(v)

    def intget(self, k, d=0):
        return int(self.capsget(k, d))

    def boolget(self, k, default_value=False):
        return bool(self.capsget(k, default_value))

    def dictget(self, k, default_value={}):
        v = self.capsget(k, default_value)
        if v is None:
            return None
        assert type(v)==dict, "expected a dict value for %s but got %s" % (k, type(v))
        return v

    def listget(self, k, default_value=[]):
        v = self.capsget(k, default_value)
        if v is None:
            return None
        assert type(v) in (list, tuple), "expected a list or tuple value for %s but got %s" % (k, type(v))
        return v


def std(_str, extras="-,./ "):
    def f(v):
        return str.isalnum(str(v)) or v in extras
    return filter(f, _str)

def alnum(_str):
    def f(v):
        return str.isalnum(str(v))
    return filter(f, _str)

def nn(x):
    if x is None:
        return  ""
    return x

def nonl(x):
    if x is None:
        return None
    return str(x).replace("\n", "\\n").replace("\r", "\\r")
