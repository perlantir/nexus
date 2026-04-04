"""CLI entry point for decigraph-memory."""

import argparse
import sys

def main():
    parser = argparse.ArgumentParser(prog="decigraph-memory", description="DeciGraph decision memory server")
    subparsers = parser.add_subparsers(dest="command")
    
    init_parser = subparsers.add_parser("init", help="Initialize a new DeciGraph project")
    init_parser.add_argument("name", nargs="?", default=".", help="Project directory name")
    init_parser.add_argument("--port", type=int, default=3100, help="Server port")
    
    subparsers.add_parser("start", help="Start the DeciGraph server")
    subparsers.add_parser("stop", help="Stop the DeciGraph server")
    
    args = parser.parse_args()
    
    if args.command == "init":
        from .server import DeciGraphServer
        server = DeciGraphServer(port=args.port)
        print(f"Starting DeciGraph in {args.name}...")
        server.start()
        print(f"DeciGraph is running on http://localhost:{args.port}")
        print(f"API Key: {server.api_key}")
        try:
            server._process.wait()
        except KeyboardInterrupt:
            server.stop()
    elif args.command == "start":
        from .server import DeciGraphServer
        server = DeciGraphServer()
        server.start()
        print(f"DeciGraph started on http://localhost:{server.port}")
    elif args.command == "stop":
        print("Stop not implemented — use Ctrl+C on the running process")
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
