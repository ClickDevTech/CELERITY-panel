'use strict';

// Decoy page shared by the panel homepage and the node front.

const MAX_CUSTOM_BYTES = 256 * 1024;

// Verbatim nginx 1.24 (Debian/Ubuntu) welcome page. Do not reformat.
const NGINX_WELCOME_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;

const NGINX_WELCOME_BUFFER = Buffer.from(NGINX_WELCOME_HTML, 'utf8');

// Throws with a message safe to show in the UI.
function validateCustomHtml(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error('Empty file');
    }
    if (buffer.length > MAX_CUSTOM_BYTES) {
        throw new Error(`File too large (max ${MAX_CUSTOM_BYTES} bytes)`);
    }
    const probe = buffer.subarray(0, Math.min(4096, buffer.length));
    if (probe.includes(0)) {
        throw new Error('Binary content not allowed');
    }
}

module.exports = {
    MAX_CUSTOM_BYTES,
    NGINX_WELCOME_HTML,
    NGINX_WELCOME_BUFFER,
    validateCustomHtml,
};
