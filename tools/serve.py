#!/usr/bin/env python3
"""Serve local files with cross-origin isolation for high-resolution timers."""

import argparse
import functools
import http.server


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", type=int, default=8000)
    parser.add_argument("--bind", "-b", help="Address to bind to (default: all interfaces)")
    parser.add_argument("--directory", "-d", default=".", help="Directory to serve")
    args = parser.parse_args()
    http.server.test(
        HandlerClass=functools.partial(Handler, directory=args.directory),
        port=args.port,
        bind=args.bind,
    )
