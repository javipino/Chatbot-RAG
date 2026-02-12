"""Check available deployments on the Azure OpenAI endpoint."""
import json
import os
from urllib.request import Request, urlopen

AZURE_ENDPOINT = os.getenv("AZURE_OPENAI_ENDPOINT", "https://javie-mku5l3k8-swedencentral.cognitiveservices.azure.com")
API_KEY = os.environ["AZURE_OPENAI_KEY"]  # Required

# List deployments
url = f"{AZURE_ENDPOINT}/openai/deployments?api-version=2024-10-21"
headers = {"api-key": API_KEY}
req = Request(url, headers=headers)
with urlopen(req, timeout=15) as resp:
    result = json.loads(resp.read().decode("utf-8"))

print("Available deployments:")
for d in result.get("data", []):
    print(f"  - {d['id']} (model: {d.get('model', 'unknown')}, status: {d.get('status', '?')})")
