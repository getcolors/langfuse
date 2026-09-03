"""The launcher contract, and the one string helper every module shares."""

from __future__ import annotations

# Bump on any change a launcher pinned to an older commit could not survive.
CONTRACT = 1


def clj_str(value) -> str:
    """Clojure's `str`: nil renders empty, booleans lowercase, a vector as its
    literal. Green compares stringified values in several rules, and Python's
    own `str` disagrees with it on exactly the inputs those rules exist to
    catch — `str(["cloudflare"])` is `['cloudflare']`, which must not read as
    the symbolic source."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "[" + " ".join(clj_str(v) if not isinstance(v, str) else f'"{v}"'
                              for v in value) + "]"
    return str(value)
