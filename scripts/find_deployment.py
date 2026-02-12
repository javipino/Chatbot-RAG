"""Try different deployment names to find the working one."""
import json
import os
from urllib.request import Request, urlopen
from urllib.error import HTTPError

AZURE_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "https://javie-mku5l3k8-swedencentral.cognitiveservices.azure.com")
API_KEY = os.environ["AZURE_OPENAI_KEY"]  # Required

# Try various possible deployment names
candidates = [
    "gpt-5-nano",
    "gpt-5.2",
    "gpt-52",
    "gpt-5-2",
    "gpt-52-codex",
    "gpt-5.2-codex",
    "gpt-5-2-codex",
]

simple_payload = json.dumps({
    "messages": [{"role": "user", "content": "Hola"}],
    "max_tokens": 5
}).encode("utf-8")

for name in candidates:
    for api_ver in ["2025-01-01-preview", "2024-10-21", "2024-02-01"]:
        url = f"{AZURE_ENDPOINT}/openai/deployments/{name}/chat/completions?api-version={api_ver}"
        headers = {"Content-Type": "application/json", "api-key": API_KEY}
        req = Request(url, data=simple_payload, headers=headers, method="POST")
        try:
            with urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                model = result.get("model", "?")
                print(f"  ✓ FOUND: deployment={name}, api_version={api_ver}, model={model}")
        except HTTPError as e:
            if e.code == 404:
                pass  # not found, try next
            elif e.code == 429:
                print(f"  ✓ FOUND (rate limited): deployment={name}, api_version={api_ver}")
            else:
                body = e.read().decode()[:150]
                print(f"  ? {name} (api={api_ver}): HTTP {e.code} — {body}")
        except Exception as e:
            print(f"  ? {name}: {e}")
        # Only try first working api version per deployment
