# This file is part of Xpra.
# Copyright (C) 2010 Nathaniel Smith <njs@pobox.com>
# Copyright (C) 2011-2013 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

import os.path
import sys


def _get_data_dir():
    if not getattr(sys, 'frozen', ''):
        return  os.getcwd()
    #on win32 we must send stdout to a logfile to prevent an alert box on exit shown by py2exe
    #UAC in vista onwards will not allow us to write where the software is installed,
    #so we place the log file (etc) in "~/Application Data"
    appdata = os.environ.get("APPDATA")
    if not os.path.exists(appdata):
        os.mkdir(appdata)
    data_dir = os.path.join(appdata, "Xpra")
    if not os.path.exists(data_dir):
        os.mkdir(data_dir)
    return data_dir

def get_icon_dir():
    return os.path.join(get_app_dir(), "icons")

def get_default_conf_dir():
    return _get_data_dir()

def get_default_socket_dir():
    return _get_data_dir()

APP_DIR = None
if hasattr(sys, 'frozen') and sys.frozen in (True, "windows_exe", "console_exe"):    #@UndefinedVariable
    #cx_freeze = sys.frozen == True
    #py2exe =  sys.frozen in ("windows_exe", "console_exe")
    if sys.version > '3':
        APP_DIR = os.path.dirname(sys.executable)
    else:
        APP_DIR = os.path.dirname(unicode(sys.executable, sys.getfilesystemencoding()))
    sys.path.insert(0, APP_DIR)
    os.chdir(APP_DIR)
    #so we can easily load DLLs with ctypes:
    os.environ['PATH'] = APP_DIR + ';' + os.environ['PATH']

def get_resources_dir():
    return get_app_dir()

def get_app_dir():
    global APP_DIR
    if APP_DIR is not None:
        return APP_DIR
    from xpra.platform.paths import default_get_app_dir   #imported here to prevent import loop
    return default_get_app_dir()
