"""LLMLingua worker for opencode-compressor.

Reads one JSON request per line on stdin and writes one JSON response per line
on stdout. Logs go to stderr. The loaded compressor is cached so only the first
request for a given model pays the load cost.

Request:  {"id": 1, "method": "compress", "params": {...}}
Response: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "..."}
Status:   {"event": "status", "message": "..."} (unsolicited progress)
"""

from __future__ import annotations

import inspect
import json
import os
import re
import sys
import time
import traceback
from typing import Any

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

_out = sys.stdout
sys.stdout = sys.stderr  # keep library prints off the protocol channel

# Loading a model in the worker must never get OpenCode itself killed. The OOM
# killer picks the process with the highest score; this child is expendable.
try:
    MIN_AVAILABLE_MB = int(os.environ.get("LLMLINGUA_MIN_AVAILABLE_MB", "800"))
except ValueError:
    MIN_AVAILABLE_MB = 800

_compressor: Any = None
_compressor_key: tuple | None = None

FENCE = re.compile(r"(^```[^\n]*\n.*?^```[ \t]*$)", re.MULTILINE | re.DOTALL)
STRUCTURED = re.compile(r"<llmlingua\b", re.IGNORECASE)
PARAGRAPH = re.compile(r"\n\s*\n")


def send(payload: dict) -> None:
    _out.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _out.flush()


def status(message: str) -> None:
    send({"event": "status", "message": message})


def prefer_being_killed() -> None:
    """Tell the kernel to kill this worker before OpenCode when RAM runs out."""
    try:
        with open("/proc/self/oom_score_adj", "w", encoding="ascii") as handle:
            handle.write("800")
    except OSError:
        # Not Linux, /proc unavailable, or not permitted; nothing to do.
        pass


def available_memory_mb() -> int | None:
    """MemAvailable from /proc/meminfo, in MB, when it can be read."""
    try:
        with open("/proc/meminfo", encoding="ascii") as handle:
            for line in handle:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def resolve_device(device: str) -> str:
    if device and device != "auto":
        return device
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def load(params: dict) -> Any:
    global _compressor, _compressor_key
    model = params["model"]
    llmlingua2 = bool(params.get("llmlingua2", True))
    device = resolve_device(params.get("device", "auto"))
    key = (model, llmlingua2, device)
    if _compressor is not None and _compressor_key == key:
        return _compressor

    _compressor = None
    _compressor_key = None
    try:
        import gc

        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    available = available_memory_mb()
    if available is not None and available < MIN_AVAILABLE_MB:
        raise RuntimeError(
            f"Only {available} MB of RAM is available; the local compressor needs more than {MIN_AVAILABLE_MB} MB. "
            "Close some applications, choose a smaller model in /compress-settings, or use the cloud engine."
        )
    if available is not None and available < 4096:
        status(
            f"Low memory: {available} MB available. If the machine runs out, this worker is "
            "killed before OpenCode, and the compression fails."
        )

    from llmlingua import PromptCompressor

    status(f"Loading {model} on {device} (first use downloads the model)…")
    started = time.time()
    kwargs: dict[str, Any] = {"model_name": model, "device_map": device}
    if llmlingua2:
        kwargs["use_llmlingua2"] = True
    try:
        _compressor = PromptCompressor(**kwargs)
    except Exception as error:
        if device != "cpu" and "cuda" in str(error).lower():
            status(f"{device} failed ({error}); retrying on cpu")
            kwargs["device_map"] = "cpu"
            device = "cpu"
            _compressor = PromptCompressor(**kwargs)
        else:
            raise
    _compressor_key = (model, llmlingua2, device)
    status(f"Loaded {model} on {device} in {time.time() - started:.1f}s")
    return _compressor


def supported_kwargs(fn: Any, options: dict) -> tuple[dict, list[str]]:
    signature = inspect.signature(fn)
    accepts_any = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values())
    accepted: dict[str, Any] = {}
    ignored: list[str] = []
    for name, value in options.items():
        if value is None:
            continue
        if accepts_any or name in signature.parameters:
            accepted[name] = value
        else:
            ignored.append(name)
    return accepted, ignored


def split_segments(text: str, keep_code: bool) -> list[tuple[str, bool]]:
    """Return (segment, compressible) pairs."""
    if not keep_code:
        return [(text, True)]
    segments: list[tuple[str, bool]] = []
    position = 0
    for match in FENCE.finditer(text):
        if match.start() > position:
            segments.append((text[position : match.start()], True))
        segments.append((match.group(0), False))
        position = match.end()
    if position < len(text):
        segments.append((text[position:], True))
    return segments


def compress(params: dict) -> dict:
    compressor = load(params)
    text: str = params["text"]
    options: dict = dict(params.get("options") or {})
    keep_code = bool(params.get("keepCode", True))
    min_segment_chars = int(params.get("minSegmentChars", 80))
    split_contexts = bool(params.get("splitContexts", False))
    started = time.time()
    ignored: set[str] = set()
    warnings: list[str] = []

    if STRUCTURED.search(text):
        kwargs, skipped = supported_kwargs(compressor.structured_compress_prompt, options)
        ignored.update(skipped)
        result = compressor.structured_compress_prompt(text, **kwargs)
        compressed = result["compressed_prompt"]
    else:
        parts: list[str] = []
        kwargs, skipped = supported_kwargs(compressor.compress_prompt, options)
        ignored.update(skipped)
        for segment, compressible in split_segments(text, keep_code):
            if not compressible or len(segment.strip()) < min_segment_chars:
                parts.append(segment)
                continue
            leading = segment[: len(segment) - len(segment.lstrip())]
            trailing = segment[len(segment.rstrip()) :]
            body: Any = segment.strip()
            if split_contexts:
                body = [part.strip() for part in PARAGRAPH.split(body) if part.strip()]
            try:
                result = compressor.compress_prompt(body, **kwargs)
            except Exception as error:  # keep the segment rather than fail the whole prompt
                warnings.append(f"segment left uncompressed: {error}")
                parts.append(segment)
                continue
            parts.append(leading + result["compressed_prompt"] + trailing)
        compressed = "".join(parts)

    return {
        "compressed": compressed,
        "model": _compressor_key[0] if _compressor_key else params["model"],
        "device": _compressor_key[2] if _compressor_key else None,
        "seconds": round(time.time() - started, 3),
        "ignored": sorted(ignored),
        "warnings": warnings,
    }


def info(_params: dict) -> dict:
    import llmlingua

    data: dict[str, Any] = {
        "python": sys.version.split()[0],
        "llmlingua": getattr(llmlingua, "__version__", "unknown"),
        "loaded": list(_compressor_key) if _compressor_key else None,
    }
    try:
        import torch

        data["torch"] = torch.__version__
        data["cuda"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            data["gpu"] = torch.cuda.get_device_name(0)
    except Exception as error:
        data["torch"] = f"unavailable: {error}"
    return data


METHODS = {
    "ping": lambda _params: {"pong": True},
    "info": info,
    "load": lambda params: (load(params), {"loaded": list(_compressor_key or ())})[1],
    "compress": compress,
}


def main() -> None:
    prefer_being_killed()
    send({"event": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = METHODS.get(request.get("method"))
            if method is None:
                raise ValueError(f"unknown method: {request.get('method')}")
            send({"id": request_id, "ok": True, "result": method(request.get("params") or {})})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    main()
