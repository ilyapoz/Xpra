# This file is part of Xpra.
# Copyright (C) 2011-2013 Antoine Martin <antoine@devloop.org.uk>
# Xpra is released under the terms of the GNU GPL v2, or, at your option, any
# later version. See the file COPYING for details.

from xpra import __version__ as local_version
from xpra.log import Logger
log = Logger()

def version_as_numbers(version):
    return [int(x) for x in version.split(".")]

def version_compat_check(remote_version):
    if remote_version is None:
        msg = "remote version not available!"
        log(msg)
        return msg
    rv = version_as_numbers(remote_version)
    lv = version_as_numbers(local_version)
    if rv==lv:
        log("identical remote version: %s", remote_version)
        return None
    if rv[:2]<=[0, 2]:
        #0.3 is the oldest version we support
        msg = "remote version %s is too old, sorry" % str(rv[:2])
        log(msg)
        return  msg
    if rv[0:3]<=[0, 7, 8]:
        log("WARNING: the remote version %s is old and broken, upgrade to the latest stable version", remote_version)
        return None
    if rv[0]>0:
        log("newer remote version %s may work, we'll see..", remote_version)
        return  None
    log("local version %s should be compatible with remote version: %s", local_version, remote_version)
    return None

def add_version_info(props, version_prefix=""):
    props[version_prefix+"version"] = local_version
    try:
        from xpra.src_info import LOCAL_MODIFICATIONS, REVISION
        from xpra.build_info import BUILD_DATE, BUILT_BY, BUILT_ON, BUILD_BIT, BUILD_CPU
        props["build.local_modifications"] = LOCAL_MODIFICATIONS
        props["build.date"] = BUILD_DATE
        props["build.by"] = BUILT_BY
        props["build.on"] = BUILT_ON
        props["build.bit"] = BUILD_BIT
        props["build.cpu"] = BUILD_CPU
        props["build.revision"] = REVISION
    except:
        pass

def main():
    d = {}
    add_version_info(d)
    print("version_info=%s" % d)


if __name__ == "__main__":
    main()
