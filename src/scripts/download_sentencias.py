"""
Descarga de sentencias de la Sala 4 del Tribunal Supremo desde CENDOJ.

Recorre las páginas de resultados de búsqueda, extrae metadatos de cada sentencia
y descarga los PDFs correspondientes.

Uso:
    python download_sentencias.py                    # Descarga todas (hasta 200)
    python download_sentencias.py --max-pages 1      # Solo primera página (10 sentencias)
    python download_sentencias.py --query "despido"  # Cambiar término de búsqueda
    python download_sentencias.py --sala-social      # Filtrar solo Sala de lo Social

Requisitos:
    pip install requests beautifulsoup4
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("ERROR: Faltan dependencias. Ejecuta:")
    print("  pip install requests beautifulsoup4")
    sys.exit(1)

# --- Configuracion por defecto ------------------------------------------------

BASE_URL = "https://www.poderjudicial.es"
SEARCH_URL = BASE_URL + "/search/sentencias/{query}/{offset}/PUB"
PDF_URL = (
    BASE_URL + "/search/contenidos.action"
    "?action=accessToPDF&publicinterface=true&tab=AN"
    "&reference={reference}&optimize={optimize}"
    "&links={query}&databasematch=TS"
)

DEFAULT_QUERY = "sistema de la seguridad social"
MAX_PAGES = 20          # CENDOJ limita a 200 resultados (20 paginas x 10)
RESULTS_PER_PAGE = 10
DELAY_BETWEEN_REQUESTS = 1.5  # segundos entre peticiones
MAX_RETRIES = 3

# Rutas de salida
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
OUTPUT_DIR = PROJECT_ROOT / "data" / "sentencias"
PDF_DIR = OUTPUT_DIR / "pdf"
METADATA_FILE = OUTPUT_DIR / "sentencias_metadata.json"
PROGRESS_FILE = OUTPUT_DIR / "download_progress.json"

# Headers para simular navegador
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
}


# --- Funciones auxiliares -----------------------------------------------------

def get_offset(page_num):
    """Calcula el offset de URL para una pagina dada (1-indexed).
    Patron CENDOJ: pagina 1 -> /1/, pagina 2 -> /11/, pagina 3 -> /21/, etc.
    """
    if page_num == 1:
        return 1
    return (page_num - 1) * 10 + 1


def sanitize_filename(roj):
    """Convierte ROJ en nombre de archivo valido. 'STS 6045/2025' -> 'STS_6045_2025'"""
    return re.sub(r'[^\w]', '_', roj).strip('_')


def load_progress():
    """Carga el progreso de descargas anteriores."""
    if PROGRESS_FILE.exists():
        with open(PROGRESS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {"pages_scraped": [], "pdfs_downloaded": [], "pdfs_failed": []}


def save_progress(progress):
    """Guarda el progreso actual."""
    with open(PROGRESS_FILE, 'w', encoding='utf-8') as f:
        json.dump(progress, f, indent=2, ensure_ascii=False)


def load_metadata():
    """Carga metadatos guardados previamente."""
    if METADATA_FILE.exists():
        with open(METADATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []


def save_metadata(metadata):
    """Guarda los metadatos."""
    with open(METADATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2, ensure_ascii=False)


def fetch_page(url, session):
    """Descarga una pagina con reintentos."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            return resp.text
        except requests.RequestException as e:
            print("  [!] Intento {}/{} fallido: {}".format(attempt, MAX_RETRIES, e))
            if attempt < MAX_RETRIES:
                wait = 2 ** attempt
                print("  Esperando {}s antes de reintentar...".format(wait))
                time.sleep(wait)
    return None


# --- Scraping de resultados ---------------------------------------------------

def parse_search_results(html, query):
    """Extrae metadatos de sentencias de una pagina de resultados."""
    soup = BeautifulSoup(html, 'html.parser')
    sentencias = []

    # Encontrar todos los links a documentos individuales
    doc_links = soup.find_all('a', href=re.compile(r'/search/documento/'))

    for link in doc_links:
        href = link.get('href', '')
        text = link.get_text(strip=True)

        # Parsear ROJ y ECLI del texto del link
        roj_match = re.search(r'ROJ:\s*(.+?)\s*-\s*(ECLI:\S+)', text)
        if not roj_match:
            continue

        roj = roj_match.group(1).strip()
        ecli = roj_match.group(2).strip()

        # Extraer reference_id y optimize_date del href
        href_match = re.search(r'/search/documento/\w+/(\d+)/.*?/(\d+)', href)
        if not href_match:
            continue

        reference_id = href_match.group(1)
        optimize_date = href_match.group(2)

        # Navegar al contenedor padre para extraer metadatos
        container = link
        for _ in range(10):
            parent = container.parent
            if parent is None:
                break
            parent_text = parent.get_text()
            if 'Tipo' in parent_text and 'Resumen' in parent_text:
                container = parent
                break
            container = parent

        block_text = container.get_text(separator='\n')

        def extract_field(pattern, txt, default=""):
            m = re.search(pattern, txt)
            return m.group(1).strip().rstrip('-').strip() if m else default

        sentencia = {
            "roj": roj,
            "ecli": ecli,
            "reference_id": reference_id,
            "optimize_date": optimize_date,
            "tipo_organo": extract_field(
                r'Tipo .rgano:\s*(.+?)(?:\n|Municipio:)', block_text
            ),
            "municipio": extract_field(
                r'Municipio:\s*(.+?)(?:\n|Ponente:)', block_text
            ),
            "ponente": extract_field(
                r'Ponente:\s*(.+?)(?:\n|N. Recurso:)', block_text
            ),
            "recurso": extract_field(
                r'N. Recurso:\s*(.+?)(?:\n|Fecha:)', block_text
            ),
            "fecha": extract_field(
                r'Fecha:\s*(.+?)(?:\n|Tipo Resoluci)', block_text
            ),
            "tipo_resolucion": extract_field(
                r'Tipo Resoluci.n:\s*(.+?)(?:\n|Resumen:)', block_text
            ),
            "resumen": extract_field(
                r'Resumen:\s*(.+?)(?:\n\s*\n|Icono compartir|$)', block_text
            ),
            "url_documento": BASE_URL + href if href.startswith('/') else href,
            "url_pdf": PDF_URL.format(
                reference=reference_id,
                optimize=optimize_date,
                query=quote(query, safe='')
            ),
            "pdf_filename": sanitize_filename(roj) + ".pdf",
        }

        # Limpiar resumen multilinea
        sentencia["resumen"] = re.sub(r'\s+', ' ', sentencia["resumen"]).strip()

        sentencias.append(sentencia)

    return sentencias


# --- Descarga de PDFs ---------------------------------------------------------

def download_pdf(sentencia, session):
    """Descarga el PDF de una sentencia. Retorna True si se descargo correctamente."""
    pdf_path = PDF_DIR / sentencia["pdf_filename"]

    if pdf_path.exists() and pdf_path.stat().st_size > 0:
        return True

    url = sentencia["url_pdf"]

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, headers=HEADERS, timeout=60, stream=True)
            resp.raise_for_status()

            content_type = resp.headers.get('Content-Type', '')
            if 'html' in content_type.lower():
                print("\n  [!] Respuesta HTML en vez de PDF")
                return False

            with open(pdf_path, 'wb') as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)

            size_kb = pdf_path.stat().st_size / 1024
            if size_kb < 1:
                print("\n  [!] PDF sospechosamente pequeno ({:.1f} KB)".format(size_kb))
                pdf_path.unlink()
                return False

            return True

        except requests.RequestException as e:
            print("\n  [!] Intento {}/{} descarga fallida: {}".format(attempt, MAX_RETRIES, e))
            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)

    return False


# --- Proceso principal --------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Descarga sentencias del TS (Sala Social) desde CENDOJ"
    )
    parser.add_argument(
        '--query', '-q', default=DEFAULT_QUERY,
        help='Termino de busqueda (default: "{}")'.format(DEFAULT_QUERY)
    )
    parser.add_argument(
        '--max-pages', '-p', type=int, default=MAX_PAGES,
        help='Maximo de paginas a recorrer (default: {})'.format(MAX_PAGES)
    )
    parser.add_argument(
        '--delay', '-d', type=float, default=DELAY_BETWEEN_REQUESTS,
        help='Segundos entre peticiones (default: {})'.format(DELAY_BETWEEN_REQUESTS)
    )
    parser.add_argument(
        '--skip-pdf', action='store_true',
        help='Solo extraer metadatos, no descargar PDFs'
    )
    parser.add_argument(
        '--sala-social', action='store_true',
        help='Filtrar solo resultados de la Sala de lo Social'
    )
    parser.add_argument(
        '--resume', action='store_true',
        help='Reanudar descarga desde el ultimo punto guardado'
    )

    args = parser.parse_args()
    query_encoded = quote(args.query, safe='')

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)

    progress = load_progress()
    existing_metadata = load_metadata()
    existing_roj = {s["roj"] for s in existing_metadata}

    print("=" * 70)
    print("DESCARGA DE SENTENCIAS - CENDOJ (Poder Judicial)")
    print("=" * 70)
    print('  Busqueda: "{}"'.format(args.query))
    print("  Paginas:  hasta {} (max. {} sentencias)".format(
        args.max_pages, args.max_pages * RESULTS_PER_PAGE))
    print("  Delay:    {}s entre peticiones".format(args.delay))
    print("  Salida:   {}".format(OUTPUT_DIR))
    if args.sala_social:
        print("  Filtro:   Solo Sala de lo Social")
    if args.skip_pdf:
        print("  PDFs:     NO (solo metadatos)")
    if args.resume and existing_metadata:
        print("  Reanudando: {} sentencias previas".format(len(existing_metadata)))
    print("=" * 70)
    print()

    session = requests.Session()
    all_sentencias = list(existing_metadata) if args.resume else []
    all_roj = set(existing_roj) if args.resume else set()
    new_count = 0
    skipped_count = 0

    # -- Fase 1: Scraping de metadatos -----------------------------------------

    print("FASE 1: Extraccion de metadatos de resultados de busqueda")
    print("-" * 50)

    for page in range(1, args.max_pages + 1):
        if args.resume and page in progress.get("pages_scraped", []):
            print("  Pagina {:2d}/{}: ya procesada, saltando".format(page, args.max_pages))
            continue

        offset = get_offset(page)
        url = SEARCH_URL.format(query=query_encoded, offset=offset)
        print("  Pagina {:2d}/{}: descargando...".format(page, args.max_pages))

        html = fetch_page(url, session)
        if html is None:
            print("  [X] No se pudo obtener la pagina {}".format(page))
            continue

        sentencias = parse_search_results(html, args.query)

        if not sentencias:
            print("  [X] Sin resultados en pagina {} -- fin de resultados".format(page))
            break

        if args.sala_social:
            before = len(sentencias)
            sentencias = [
                s for s in sentencias
                if 'social' in s.get('tipo_organo', '').lower()
            ]
            if before != len(sentencias):
                print("    (filtradas {} no-Social)".format(before - len(sentencias)))

        page_new = 0
        for s in sentencias:
            if s["roj"] not in all_roj:
                all_sentencias.append(s)
                all_roj.add(s["roj"])
                page_new += 1
            else:
                skipped_count += 1

        new_count += page_new
        print("    -> {} sentencias, {} nuevas".format(len(sentencias), page_new))

        progress.setdefault("pages_scraped", []).append(page)
        save_metadata(all_sentencias)
        save_progress(progress)

        if page < args.max_pages:
            time.sleep(args.delay)

    print()
    print("Total sentencias recopiladas: {} ({} nuevas)".format(len(all_sentencias), new_count))
    if skipped_count:
        print("  ({} duplicadas omitidas)".format(skipped_count))
    save_metadata(all_sentencias)

    if args.skip_pdf:
        print()
        print("[OK] Metadatos guardados en: {}".format(METADATA_FILE))
        return

    # -- Fase 2: Descarga de PDFs ----------------------------------------------

    print()
    print("FASE 2: Descarga de PDFs")
    print("-" * 50)

    to_download = [
        s for s in all_sentencias
        if s["roj"] not in progress.get("pdfs_downloaded", [])
        and s["roj"] not in progress.get("pdfs_failed", [])
    ]

    already = sum(1 for s in all_sentencias if (PDF_DIR / s["pdf_filename"]).exists())
    print("  {} ya descargados, {} pendientes".format(already, len(to_download)))
    print()

    success = already
    failed = 0

    for i, sentencia in enumerate(to_download, 1):
        roj = sentencia["roj"]
        pdf_path = PDF_DIR / sentencia["pdf_filename"]

        sys.stdout.write("  [{}/{}] {} ({})... ".format(
            i, len(to_download), roj, sentencia.get('fecha', '?')))
        sys.stdout.flush()

        if pdf_path.exists() and pdf_path.stat().st_size > 0:
            print("ya existe [OK]")
            progress.setdefault("pdfs_downloaded", []).append(roj)
            success += 1
            continue

        ok = download_pdf(sentencia, session)
        if ok:
            size_kb = pdf_path.stat().st_size / 1024
            print("[OK] ({:.0f} KB)".format(size_kb))
            progress.setdefault("pdfs_downloaded", []).append(roj)
            success += 1
        else:
            print("[FALLO]")
            progress.setdefault("pdfs_failed", []).append(roj)
            failed += 1

        save_progress(progress)
        time.sleep(args.delay)

    # -- Resumen final ---------------------------------------------------------

    print()
    print("=" * 70)
    print("RESUMEN")
    print("=" * 70)
    print("  Sentencias totales:   {}".format(len(all_sentencias)))
    print("  PDFs descargados:     {}".format(success))
    print("  PDFs fallidos:        {}".format(failed))
    print("  Metadatos:            {}".format(METADATA_FILE))
    print("  PDFs:                 {}".format(PDF_DIR))

    if failed > 0:
        print()
        print("  Para reintentar los fallidos, ejecuta de nuevo con --resume")
    print()


if __name__ == "__main__":
    main()
