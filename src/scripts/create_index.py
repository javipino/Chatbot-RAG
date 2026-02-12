"""Create the Azure AI Search index for normativa chunks."""
import json, urllib.request, ssl, os

SEARCH_ENDPOINT = os.getenv("AZURE_SEARCH_ENDPOINT", "https://ai-search-javi.search.windows.net")
ADMIN_KEY = os.environ["AZURE_SEARCH_KEY"]  # Required
INDEX_NAME = os.getenv("AZURE_SEARCH_INDEX", "normativa")
API_VERSION = "2024-07-01"

index_schema = {
    "name": INDEX_NAME,
    "fields": [
        {"name": "id", "type": "Edm.String", "key": True, "filterable": True},
        {"name": "law", "type": "Edm.String", "searchable": True, "filterable": True, "facetable": True, "sortable": False},
        {"name": "chapter", "type": "Edm.String", "searchable": True, "filterable": False, "sortable": False},
        {"name": "section", "type": "Edm.String", "searchable": True, "filterable": True, "sortable": False},
        {"name": "text", "type": "Edm.String", "searchable": True, "filterable": False, "sortable": False},
        {"name": "resumen", "type": "Edm.String", "searchable": True, "filterable": False, "sortable": False},
        {"name": "palabras_clave", "type": "Collection(Edm.String)", "searchable": True, "filterable": True, "facetable": True},
        {"name": "preguntas", "type": "Edm.String", "searchable": True, "filterable": False, "sortable": False},
        {"name": "text_vector", "type": "Collection(Edm.Single)", "searchable": True, "dimensions": 1536,
         "vectorSearchProfile": "default-profile"}
    ],
    "vectorSearch": {
        "algorithms": [
            {"name": "default-algo", "kind": "hnsw", "hnswParameters": {"m": 4, "efConstruction": 400, "efSearch": 500, "metric": "cosine"}}
        ],
        "profiles": [
            {"name": "default-profile", "algorithm": "default-algo"}
        ]
    },
    "semantic": {
        "configurations": [
            {
                "name": "default-semantic",
                "prioritizedFields": {
                    "titleField": {"fieldName": "section"},
                    "prioritizedContentFields": [
                        {"fieldName": "text"},
                        {"fieldName": "resumen"},
                        {"fieldName": "preguntas"}
                    ],
                    "prioritizedKeywordsFields": [
                        {"fieldName": "palabras_clave"}
                    ]
                }
            }
        ],
        "defaultConfiguration": "default-semantic"
    }
}

# Create the index via REST API
url = f"{SEARCH_ENDPOINT}/indexes/{INDEX_NAME}?api-version={API_VERSION}"
data = json.dumps(index_schema).encode('utf-8')

ctx = ssl.create_default_context()

req = urllib.request.Request(url, data=data, method='PUT')
req.add_header('Content-Type', 'application/json')
req.add_header('api-key', ADMIN_KEY)

try:
    with urllib.request.urlopen(req, context=ctx) as resp:
        result = json.loads(resp.read())
        print(f"Index '{INDEX_NAME}' created/updated successfully!")
        print(f"Fields: {len(result['fields'])}")
        for f in result['fields']:
            print(f"  {f['name']}: {f['type']} {'[key]' if f.get('key') else ''} {'[searchable]' if f.get('searchable') else ''} {'[filterable]' if f.get('filterable') else ''}")
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print(f"Error {e.code}: {body}")
