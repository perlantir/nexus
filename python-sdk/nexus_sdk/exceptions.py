"""
DeciGraph SDK — Exceptions
======================
All SDK-specific exception types.
"""

from __future__ import annotations


class DeciGraphError(Exception):
    """Base class for all DeciGraph SDK errors."""


class DeciGraphApiError(DeciGraphError):
    """Raised when the DeciGraph API returns a non-2xx HTTP response."""

    def __init__(self, status_code: int, message: str, response_body: dict | None = None) -> None:
        self.status_code = status_code
        self.message = message
        self.response_body = response_body or {}
        super().__init__(f"HTTP {status_code}: {message}")


class DeciGraphNotFoundError(DeciGraphApiError):
    """Raised on HTTP 404 responses."""


class DeciGraphAuthError(DeciGraphApiError):
    """Raised on HTTP 401 / 403 responses."""


class DeciGraphValidationError(DeciGraphApiError):
    """Raised on HTTP 422 validation failures."""


class DeciGraphConnectionError(DeciGraphError):
    """Raised when the SDK cannot reach the DeciGraph server."""


__all__ = [
    "DeciGraphError",
    "DeciGraphApiError",
    "DeciGraphNotFoundError",
    "DeciGraphAuthError",
    "DeciGraphValidationError",
    "DeciGraphConnectionError",
]
