"""DeciGraph Memory — zero-config decision memory for multi-agent teams."""

from nexus_sdk.client import DeciGraphClient
from .server import DeciGraphServer

_server = None

def init(db_path="./decigraph.db", port=3100):
    """Start DeciGraph with zero config. One line."""
    global _server
    _server = DeciGraphServer(db_path=db_path, port=port)
    _server.start()
    return DeciGraphClient(
        base_url=f"http://localhost:{port}",
        api_key=_server.api_key
    )

def stop():
    """Stop the running DeciGraph server."""
    global _server
    if _server:
        _server.stop()
        _server = None
