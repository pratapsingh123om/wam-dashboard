# cohere_client.py
# Simple Cohere REST helper using requests.
import os
import requests
import logging

COHERE_KEY = os.environ.get("COHERE_API_KEY", "").strip()
COHERE_URL = "https://api.cohere.com/v1/generate"  # Cohere generation endpoint

logger = logging.getLogger("cohere_client")

def is_configured():
    return bool(COHERE_KEY)

def analyze_with_cohere(prompt, model="command", max_tokens=256, temperature=0.0):
    """
    Send `prompt` to Cohere and return textual result or raise exception.
    Returns a dict: { 'success': True, 'text': '...' } or raises.
    """
    if not COHERE_KEY:
        raise RuntimeError("COHERE_API_KEY not set")

    headers = {
        "Authorization": f"Bearer {COHERE_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    r = requests.post(COHERE_URL, headers=headers, json=payload, timeout=30)
    # Raise for HTTP errors so caller can capture
    r.raise_for_status()
    j = r.json()
    # Cohere returns generated text under choices[0].text or `generations` depending on model/version
    text = None
    if "generations" in j and isinstance(j["generations"], list) and j["generations"]:
        text = j["generations"][0].get("text") or j["generations"][0].get("content")
    elif "choices" in j and isinstance(j["choices"], list) and j["choices"]:
        text = j["choices"][0].get("text")
    else:
        # fallback: stringify entire body
        text = str(j)
    return {"success": True, "text": text, "raw": j}
