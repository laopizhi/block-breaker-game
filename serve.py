#!/usr/bin/env python3
"""
Local dev server for Neon Block Breaker.

Serves the game with caching DISABLED so you always get the latest files while
developing (plain `python3 -m http.server` caches aggressively and will show you
stale versions). For a real deployment, use any normal static host instead.

Usage:  python3 serve.py        # then open http://localhost:8000
"""
import http.server
import socketserver
import os

PORT = 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


with socketserver.TCPServer(("", PORT), NoCacheHandler) as httpd:
    ip_hint = "  (on your phone, use http://<your-mac-IP>:%d)" % PORT
    print("Neon Block Breaker running at http://localhost:%d%s" % (PORT, ip_hint))
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
