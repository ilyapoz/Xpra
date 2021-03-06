%{!?__python2: %define __python2 python2}
%{!?python2_sitearch: %define python2_sitearch %(%{__python2} -c "from distutils.sysconfig import get_python_lib; print get_python_lib(1)")}

#this spec file is for both Fedora and CentOS
#only Fedora has Python3 at present:
%if 0%{?fedora}
%define with_python3 1
%endif

Name:           PyOpenGL-accelerate
Version:        3.1.0
Release:        2%{?dist}
Summary:        Acceleration code for PyOpenGL
License:        BSD
Group:          System Environment/Libraries
URL:            http://pyopengl.sourceforge.net/
Source0:        http://downloads.sourceforge.net/pyopengl/%{name}-%{version}.tar.gz
BuildRoot:      %{_tmppath}/%{name}-%{version}-%{release}-root-%(%{__id_u} -n)
BuildRequires:  python-devel Cython PyOpenGL
#see: http://fedoraproject.org/wiki/Changes/Remove_Python-setuptools-devel
%if 0%{?fedora}
BuildRequires:  python-setuptools
%else
BuildRequires:  python-setuptools-devel
%endif
Requires:       PyOpenGL

%description
This set of C (Cython) extensions provides acceleration of common operations for slow points in PyOpenGL 3.x.


%if 0%{?with_python3}
%package -n python3-PyOpenGL-accelerate
Summary:        Acceleration code for PyOpenGL
Group:          System Environment/Libraries

%description -n python3-PyOpenGL-accelerate
This set of C (Cython) extensions provides acceleration of common operations for slow points in PyOpenGL 3.x.
%endif


%prep
%setup -q -n %{name}-%{version}

%if 0%{?with_python3}
rm -rf %{py3dir}
cp -a . %{py3dir}
%endif

%build
%{__python2} setup.py build

%if 0%{?with_python3}
pushd %{py3dir}
%{__python3} setup.py build
popd
%endif

%install
rm -rf $RPM_BUILD_ROOT
%{__python2} setup.py install -O1 --skip-build --root="$RPM_BUILD_ROOT" \
  --prefix="%{_prefix}"

%if 0%{?with_python3}
%{__python3} setup.py install --root %{buildroot}
%endif

%clean
rm -rf $RPM_BUILD_ROOT


%files
%defattr(-,root,root,-)
%{python2_sitearch}/*OpenGL_accelerate*

%if 0%{?with_python3}
%files -n python3-PyOpenGL-accelerate
%defattr(-,root,root)
%{python3_sitearch}/*OpenGL_accelerate*
%endif


%changelog
* Wed Sep 17 2014 Antoine Martin <antoine@nagafix.co.uk> 3.1.0-2
- Add Python3 package

* Fri Aug 08 2014 Antoine Martin <antoine@devloop.org.uk> 3.1.0-1
- Initial packaging for xpra
