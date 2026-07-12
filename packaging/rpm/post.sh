# rpm %post — mirror the deb postinst: Chromium's setuid sandbox needs root:root 4755.
# Without it Electron falls back to unprivileged user namespaces (fine on stock Fedora,
# broken on hardened kernels with userns restricted).
chmod 4755 /usr/lib/whatswine/chrome-sandbox || true
