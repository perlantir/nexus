"""Manages the DeciGraph Node.js server process."""

import subprocess
import platform
import time
import os
import secrets
from pathlib import Path

class DeciGraphServer:
    def __init__(self, db_path="./decigraph.db", port=3100):
        self.db_path = str(Path(db_path).resolve())
        self.port = port
        self.api_key = os.environ.get("DECIGRAPH_API_KEY", f"nx_{secrets.token_hex(20)}")
        self._process = None

    def start(self):
        binary = self._get_binary_path()
        if not binary:
            raise RuntimeError(
                "DeciGraph server binary not found. "
                "Install Node.js and run: npx @decigraph/cli start"
            )
        env = {
            **os.environ,
            "DECIGRAPH_DB_PATH": self.db_path,
            "PORT": str(self.port),
            "DECIGRAPH_API_KEY": self.api_key,
        }
        self._process = subprocess.Popen(
            [str(binary), "start"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._wait_for_health()
        return self

    def stop(self):
        if self._process:
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
            self._process = None

    def _get_binary_path(self):
        system = platform.system().lower()
        machine = platform.machine().lower()
        if "arm" in machine or "aarch64" in machine:
            arch = "arm64"
        else:
            arch = "x64"
        
        name = f"decigraph-{system}-{arch}"
        if system == "windows":
            name += ".exe"
        
        # Check bundled binaries
        bin_dir = Path(__file__).parent / "bin"
        binary = bin_dir / name
        if binary.exists():
            return binary
        
        # Fall back to npx
        import shutil
        npx = shutil.which("npx")
        if npx:
            return None  # Caller should use npx @decigraph/cli start instead
        
        return None

    def _wait_for_health(self, timeout=30):
        import urllib.request
        start = time.time()
        while time.time() - start < timeout:
            try:
                req = urllib.request.urlopen(
                    f"http://localhost:{self.port}/api/health"
                )
                if req.status == 200:
                    return
            except Exception:
                time.sleep(0.5)
        raise TimeoutError("DeciGraph server did not start within timeout")
    
    def __enter__(self):
        self.start()
        return self
    
    def __exit__(self, *args):
        self.stop()
