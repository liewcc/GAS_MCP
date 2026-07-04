import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from mcp.types import TextContent

load_dotenv()

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
CAPABILITIES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_capabilities.json")
USAGE_LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "usage_log.jsonl")
USAGE_LOG_MAX_ENTRIES = 500
FALLBACK_MODEL = "gemini-2.5-flash"


def _load_config() -> Dict[str, Any]:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _load_capabilities() -> Dict[str, Any]:
    try:
        with open(CAPABILITIES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


MODEL_CAPS = _load_capabilities()
_usage_log_lock = threading.Lock()


def _log_usage(model: str, usage: Dict[str, Any]) -> None:
    """Append one token-usage record for the USAGE tab, trimmed to the last
    USAGE_LOG_MAX_ENTRIES lines. Best-effort: logging must never break a
    chat_completion call, so any failure here is swallowed."""
    if not usage:
        return
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "prompt_tokens": usage.get("promptTokenCount", 0),
        "candidates_tokens": usage.get("candidatesTokenCount", 0),
        "thoughts_tokens": usage.get("thoughtsTokenCount", 0),
        "cached_tokens": usage.get("cachedContentTokenCount", 0),
        "total_tokens": usage.get("totalTokenCount", 0),
    }
    try:
        with _usage_log_lock:
            lines = []
            if os.path.exists(USAGE_LOG_PATH):
                with open(USAGE_LOG_PATH, "r", encoding="utf-8") as f:
                    lines = f.readlines()
            lines.append(json.dumps(entry) + "\n")
            lines = lines[-USAGE_LOG_MAX_ENTRIES:]
            with open(USAGE_LOG_PATH, "w", encoding="utf-8") as f:
                f.writelines(lines)
    except Exception:
        pass


def _infer_caps(model_id: str) -> dict:
    if model_id in MODEL_CAPS:
        return MODEL_CAPS[model_id]

    # Fallback naming heuristics
    if "embed" in model_id:
        return {"type": "embed", "vision": False, "tools": False, "context": None, "notes": "inferred"}
    elif "imagen" in model_id:
        return {"type": "image", "vision": False, "tools": False, "context": None, "notes": "inferred"}
    elif "veo" in model_id:
        return {"type": "video", "vision": False, "tools": False, "context": None, "notes": "inferred"}
    elif "aqa" in model_id:
        return {"type": "other", "vision": False, "tools": False, "context": None, "notes": "inferred"}
    elif "gemini" in model_id:
        # Gemini chat models are natively multimodal and support function calling.
        return {"type": "chat", "vision": True, "tools": True, "context": None, "notes": "inferred"}
    else:
        return {"type": "chat", "vision": False, "tools": False, "context": None, "notes": "inferred"}


def _api_key() -> str:
    # Re-read config.json on every call so a profile switched/edited via the
    # TUI's API KEY tab takes effect immediately, without restarting this server.
    cfg = _load_config()
    profiles = cfg.get("api_keys") or []
    active_name = cfg.get("active_profile")
    active = next((p for p in profiles if p.get("name") == active_name), None)
    key = (active or {}).get("api_key") or os.getenv("GAS_API_KEY")
    if not key:
        raise ValueError(
            "No active Google AI Studio API key profile found. Create one (and switch to it) via "
            "the TUI's API KEY tab, or set GAS_API_KEY in .env."
        )
    return key


client = httpx.Client(base_url="https://generativelanguage.googleapis.com/v1beta", timeout=120.0)

mcp = FastMCP("gas-mcp")


def _to_gemini_contents(messages: List[Dict[str, Any]]) -> tuple[Optional[str], List[Dict[str, Any]]]:
    """Convert OpenAI-style {role, content} messages to Gemini's {role, parts} contents.
    A leading/only 'system' message is pulled out as systemInstruction, since Gemini
    has no 'system' role in `contents`."""
    system_text = None
    contents = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        parts = [{"text": content}] if isinstance(content, str) else content

        if role == "system":
            system_text = content if isinstance(content, str) else json.dumps(content)
            continue
        # Gemini uses "model" instead of "assistant"
        gemini_role = "model" if role == "assistant" else "user"
        contents.append({"role": gemini_role, "parts": parts})
    return system_text, contents


@mcp.tool(description="""Get capability info for a Google AI Studio (Gemini API) model.
    Returns JSON with: type (chat/embed/image/video/other), vision (bool), tools (bool),
    context (int or null), notes (str).
    Use this BEFORE calling chat_completion to verify a model supports your use case.""")
def get_model_capabilities(model: str) -> TextContent:
    caps = _infer_caps(model)
    return TextContent(type="text", text=json.dumps(caps, indent=2))


@mcp.tool(
    description="""Generate a chat completion using any model hosted on Google AI Studio (Gemini API).
    One API key works for every model in the catalog -- just change the `model` string
    (e.g. "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash").

    Vision/tools: call get_model_capabilities(model) first to check if a model supports
    vision input or tool calling. Models of type "embed", "image", "video", or "other" do
    not support chat completion -- use a "chat" model instead.

    Tool calling: pass `tools` (OpenAI-style function schemas, i.e. a list of
    {"type": "function", "function": {...}} dicts) to let the model request tool calls.
    If the response contains a function call, this returns the raw JSON of the model's
    `content` (including `parts` with `functionCall`) instead of plain text, so the caller
    can execute the tools and continue the conversation.

    Args:
        messages: List of message dicts with 'role' ('system'/'user'/'assistant') and
            'content' keys (content may be a string or a list of Gemini-style content parts
            for vision input, e.g. [{"text": "..."}, {"inline_data": {...}}])
        model: Gemini model id (see list_models for the full catalog). If omitted, uses the
            default_model currently selected in the TUI's MODELS tab (config.json)
        temperature: Sampling temperature
        max_tokens: Maximum output tokens
        top_p: Nucleus sampling parameter
        seed: Optional seed for deterministic output
        tools: Optional list of OpenAI-style tool/function definitions

    Returns:
        Text content with the model's response, or the raw candidate content JSON if it
        contains a function call
    """
)
def chat_completion(
    messages: List[Dict[str, Any]],
    model: Optional[str] = None,
    temperature: float = 0.7,
    max_tokens: int = 8192,
    top_p: float = 1.0,
    seed: Optional[int] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
) -> TextContent:
    # No model specified -- use whatever is currently selected in the TUI's
    # MODELS tab (config.json's default_model), falling back if unset.
    resolved_model = model or _load_config().get("default_model") or FALLBACK_MODEL

    caps = _infer_caps(resolved_model)
    non_chat = {"embed", "image", "video", "other"}
    if caps["type"] in non_chat:
        return TextContent(type="text", text=f"Error: {resolved_model} is a {caps['type']} model and does not support chat completion. Use a chat model instead.")

    system_text, contents = _to_gemini_contents(messages)

    payload: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "topP": top_p,
        },
    }
    if system_text:
        payload["systemInstruction"] = {"parts": [{"text": system_text}]}
    if seed is not None:
        payload["generationConfig"]["seed"] = seed
    if tools is not None:
        # Translate OpenAI-style {"type": "function", "function": {...}} into
        # Gemini's {"functionDeclarations": [...]}.
        declarations = [t["function"] for t in tools if t.get("type") == "function" and "function" in t]
        if declarations:
            payload["tools"] = [{"functionDeclarations": declarations}]

    resp = client.post(
        f"/models/{resolved_model}:generateContent",
        json=payload,
        headers={"x-goog-api-key": _api_key(), "Content-Type": "application/json"},
    )
    resp.raise_for_status()
    data = resp.json()
    _log_usage(resolved_model, data.get("usageMetadata") or {})
    candidates = data.get("candidates") or []
    if not candidates:
        return TextContent(type="text", text=json.dumps(data))

    content = candidates[0].get("content", {})
    parts = content.get("parts", [])

    if any("functionCall" in p for p in parts):
        return TextContent(type="text", text=json.dumps(content))

    text = "".join(p.get("text", "") for p in parts)
    return TextContent(type="text", text=text)


@mcp.tool(
    description="""List all models available through this Google AI Studio API key.

    Returns:
        Text content with the list of model ids returned by the /v1beta/models endpoint.
    """
)
def list_models() -> TextContent:
    resp = client.get("/models", headers={"x-goog-api-key": _api_key()})
    resp.raise_for_status()
    models = [m["name"].removeprefix("models/") for m in resp.json().get("models", [])]
    return TextContent(type="text", text="\n".join(sorted(models)))


def main():
    mcp.run()


if __name__ == "__main__":
    main()
