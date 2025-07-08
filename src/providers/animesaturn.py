#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AnimeSaturn Stream Extractor
Estrae tutti i possibili link di streaming (MP4, M3U8, embed) dagli episodi di animesaturn.cx
Dipendenze: requests, beautifulsoup4 (pip install requests beautifulsoup4)
"""

import requests
from bs4 import BeautifulSoup
import re
import sys
import json
import urllib.parse
import argparse
import base64
from urllib.parse import urljoin, urlparse, parse_qs

BASE_URL = "https://www.animesaturn.cx"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
HEADERS = {"User-Agent": USER_AGENT}
TIMEOUT = 20

def search_anime(query, mal_id=None):
    """
    Ricerca anime tramite la barra di ricerca di AnimeSaturn
    Se viene fornito un mal_id, viene utilizzato solo per scopi di logging
    """
    # Log per debug
    if mal_id:
        print(f"DEBUG: Ricerca per '{query}' con MAL ID {mal_id}", file=sys.stderr)
    else:
        print(f"DEBUG: Ricerca per '{query}' senza MAL ID", file=sys.stderr)
        
    search_url = f"{BASE_URL}/index.php?search=1&key={query.replace(' ', '+')}"
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": f"{BASE_URL}/animelist?search={query.replace(' ', '+')}",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01"
    }
    resp = requests.get(search_url, headers=headers, timeout=TIMEOUT)
    resp.raise_for_status()
    results = []
    for item in resp.json():
        results.append({
            "title": item["name"],
            "url": f"{BASE_URL}/anime/{item['link']}"
        })
    return results

def get_watch_url(episode_url):
    resp = requests.get(episode_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    # Cerca il link con testo "Guarda lo streaming"
    for a in soup.find_all("a", href=True):
        div = a.find("div")
        if div and "Guarda lo streaming" in div.get_text():
            return a["href"] if a["href"].startswith("http") else BASE_URL + a["href"]
    # Fallback: cerca il link alla pagina watch come prima
    watch_link = soup.find("a", href=re.compile(r"^/watch\\?file="))
    if watch_link:
        return BASE_URL + watch_link["href"]
    iframe = soup.find("iframe", src=re.compile(r"^/watch\\?file="))
    if iframe:
        return BASE_URL + iframe["src"]
    return None

def extract_mp4_url(watch_url):
    resp = requests.get(watch_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    # Cerca direttamente il link mp4 nel sorgente
    mp4_match = re.search(r'https://[\w\.-]+/[^"\']+\\.mp4', resp.text)
    if mp4_match:
        return mp4_match.group(0)
    # In alternativa, analizza i tag video/source
    soup = BeautifulSoup(resp.text, "html.parser")
    video = soup.find("video")
    if video:
        source = video.find("source")
        if source and source.get("src"):
            return source["src"]
    return None
    
def search_js_variables(html_content, patterns):
    """
    Ricerca variabili JavaScript nel codice HTML
    Utile per estrarre URL nascosti nei script
    """
    results = {}
    for var_name, regex_pattern in patterns.items():
        match = re.search(regex_pattern, html_content)
        if match:
            value = match.group(1)
            try:
                # Prova a decodificare valori JSON
                results[var_name] = json.loads(value)
            except:
                results[var_name] = value
    return results

def get_alternative_servers(watch_url):
    """
    Ottiene URL dei server alternativi da una pagina
    """
    servers = []
    try:
        # Estrai il parametro file dall'URL
        parsed_url = urlparse(watch_url)
        params = parse_qs(parsed_url.query)
        file_param = params.get('file', [''])[0]
        
        if file_param:
            # Controlla server alternativo con parametro s=alt
            alt_url = f"{BASE_URL}/watch?file={file_param}&s=alt"
            servers.append(alt_url)
            
    except Exception as e:
        print(f"ERROR: Impossibile ottenere server alternativi: {e}", file=sys.stderr)
    
    return servers

def parse_base64_data(data):
    """
    Decodifica dati base64 che potrebbero contenere URL stream
    """
    if not data:
        return None
    
    try:
        decoded = base64.b64decode(data).decode('utf-8')
        if 'http' in decoded:
            urls = re.findall(r'https?://[^\s"\']+\.(mp4|m3u8)[^\s"\']*', decoded)
            if urls:
                return urls[0]
    except:
        pass
    
    return None

def extract_m3u8_from_script(html_content):
    """
    Estrae URL m3u8 da script JavaScript nella pagina
    """
    m3u8_urls = []
    # Pattern per m3u8 URLs
    m3u8_patterns = [
        r'file:\s*["\'](.+?\.m3u8.*?)["\']', 
        r'source:\s*["\'](.+?\.m3u8.*?)["\']',
        r'src:\s*["\'](.+?\.m3u8.*?)["\']',
        r'"(.+?\.m3u8.*?)"',
        r"'(.+?\.m3u8.*?)'"
    ]
    
    for pattern in m3u8_patterns:
        matches = re.findall(pattern, html_content)
        for match in matches:
            if "http" in match and match not in m3u8_urls:
                m3u8_urls.append(match)
    
    return m3u8_urls

def extract_all_streams(watch_url, already_visited=None):
    """
    Estrae tutti i possibili stream (mp4, m3u8, embed players) da una pagina di AnimeSaturn
    Parametri:
        watch_url: URL della pagina di streaming
        already_visited: Set di URL già visitati (per evitare ricorsioni infinite)
    Ritorna:
        Una lista di dizionari con url, headers, server e qualità
    """
    if already_visited is None:
        already_visited = set()
    
    # Evita cicli infiniti
    if watch_url in already_visited:
        return []
    
    already_visited.add(watch_url)
    print(f"DEBUG: Esaminando URL: {watch_url}", file=sys.stderr)
    
    streams = []
    try:
        resp = requests.get(watch_url, headers=HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        html_content = resp.text
        soup = BeautifulSoup(html_content, "html.parser")
        
        # 1. Estrai link MP4 diretti da regex e video tags
        mp4_urls = re.findall(r'https?://[\w\.-]+/[^"\']+\.mp4[^"\']*', html_content)
        
        for mp4_url in mp4_urls:
            if not any(s['url'] == mp4_url for s in streams):
                streams.append({
                    "url": mp4_url,
                    "server": "Direct MP4",
                    "quality": "HD",
                    "headers": {
                        "Referer": watch_url,
                        "User-Agent": USER_AGENT
                    }
                })
        
        # 2. Controlla video tag e source tags
        video_tags = soup.find_all("video")
        for video in video_tags:
            sources = video.find_all("source", src=True)
            for source in sources:
                src = source["src"]
                if not any(s['url'] == src for s in streams):
                    quality = source.get("label", "HD") or source.get("res", "HD") or "HD"
                    file_type = "MP4" if ".mp4" in src else "HLS" if ".m3u8" in src else "Stream"
                    streams.append({
                        "url": src,
                        "server": f"Direct {file_type}",
                        "quality": quality,
                        "headers": {
                            "Referer": watch_url,
                            "User-Agent": USER_AGENT
                        }
                    })
        
        # 3. Estrai link m3u8 da script
        m3u8_urls = extract_m3u8_from_script(html_content)
        for m3u8_url in m3u8_urls:
            if not any(s['url'] == m3u8_url for s in streams):
                streams.append({
                    "url": m3u8_url,
                    "server": "HLS Stream",
                    "quality": "Auto",
                    "headers": {
                        "Referer": watch_url,
                        "User-Agent": USER_AGENT
                    }
                })
        
        # 4. Controlla script per dati JSON o variabili
        js_vars = search_js_variables(html_content, {
            "playerSource": r'file:\s*[\'"]([^"\']+)[\'"]',
            "videoSrc": r'source\s*:\s*[\'"]([^"\']+)[\'"]',
            "videoUrl": r'url\s*:\s*[\'"]([^"\']+)[\'"]',
            "playerData": r'player_data\s*=\s*([^;]+)',
            "base64Data": r'atob\([\'"]([^\'"]+)[\'"]\)'
        })
        
        for var_name, value in js_vars.items():
            if isinstance(value, str) and ("http" in value and (".mp4" in value or ".m3u8" in value)):
                if not any(s['url'] == value for s in streams):
                    streams.append({
                        "url": value,
                        "server": f"JavaScript {var_name}",
                        "quality": "unknown",
                        "headers": {
                            "Referer": watch_url,
                            "User-Agent": USER_AGENT
                        }
                    })
        
        # 5. Estrai dati base64 e cerca URL
        base64_matches = re.findall(r'atob\([\'"]([^\'"]+)[\'"]\)', html_content)
        for b64 in base64_matches:
            url = parse_base64_data(b64)
            if url and not any(s['url'] == url for s in streams):
                streams.append({
                    "url": url,
                    "server": "Base64 Decoded",
                    "quality": "unknown",
                    "headers": {
                        "Referer": watch_url,
                        "User-Agent": USER_AGENT
                    }
                })
        
        # 6. Cerca iframe player
        iframes = soup.find_all("iframe", src=True)
        for i, iframe in enumerate(iframes):
            src = iframe.get("src")
            # Skip ads
            if src and not ("ad." in src or "ads." in src or "banner" in src or "promo" in src):
                # Make URL absolute
                if src.startswith("//"):
                    src = "https:" + src
                elif src.startswith("/"):
                    src = BASE_URL + src
                
                # Identify server
                server_name = "Server Embed"
                if "animeplayx" in src:
                    server_name = "AnimePlyx"
                elif "filemoon" in src:
                    server_name = "FileMoon"
                elif "doodstream" in src or "dood." in src:
                    server_name = "DoodStream"
                elif "playerme" in src:
                    server_name = "AnimePlayerMe"
                elif "stream" in src:
                    server_name = f"Stream {i+1}"
                else:
                    server_name = f"Server {i+1}"
                
                if not any(s['url'] == src for s in streams):
                    streams.append({
                        "url": src,
                        "server": server_name,
                        "quality": "unknown",
                        "headers": {
                            "Referer": watch_url,
                            "User-Agent": USER_AGENT
                        }
                    })
        
        # 7. Cerca link player nei link
        all_links = soup.find_all("a", href=True)
        for link in all_links:
            href = link.get("href")
            if href and ("watch?file=" in href or "/play/" in href or "/video/" in href):
                # Make sure URL is absolute
                if href.startswith("//"):
                    href = "https:" + href
                elif href.startswith("/"):
                    href = BASE_URL + href
                
                if not any(s['url'] == href for s in streams):
                    streams.append({
                        "url": href,
                        "server": "Link Player",
                        "quality": "unknown",
                        "headers": {
                            "Referer": watch_url,
                            "User-Agent": USER_AGENT
                        }
                    })
        
        # 8. Cerca server alternativi
        alt_servers = get_alternative_servers(watch_url)
        for alt_url in alt_servers:
            if alt_url not in already_visited:
                print(f"DEBUG: Controllando server alternativo: {alt_url}", file=sys.stderr)
                alt_streams = extract_all_streams(alt_url, already_visited)
                
                # Aggiungi solo stream che non sono già presenti
                for alt_stream in alt_streams:
                    if not any(s['url'] == alt_stream['url'] for s in streams):
                        # Marca come server alternativo
                        alt_stream['server'] = f"Alt: {alt_stream['server']}"
                        streams.append(alt_stream)
        
    except Exception as e:
        print(f"ERROR: Errore durante l'estrazione degli stream: {e}", file=sys.stderr)
    
    # Debug log
    print(f"DEBUG: Trovati {len(streams)} stream per URL: {watch_url}", file=sys.stderr)
    for i, s in enumerate(streams):
        print(f"DEBUG: Stream {i+1}: {s['server']} - {s['url']}", file=sys.stderr)
                
    return streams

def get_episodes_list(anime_url):
    resp = requests.get(anime_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    episodes = []
    for a in soup.select("a.bottone-ep"):
        title = a.get_text(strip=True)
        href = a["href"]
        # Se il link è assoluto, usalo così, altrimenti aggiungi BASE_URL
        if href.startswith("http"):
            url = href
        else:
            url = BASE_URL + href
        episodes.append({"title": title, "url": url})
    return episodes

def download_mp4(mp4_url, referer_url, filename=None):
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": referer_url
    }
    if not filename:
        filename = mp4_url.split("/")[-1].split("?")[0]
    print(f"\n⬇️ Download in corso: {filename}\n")
    r = requests.get(mp4_url, headers=headers, stream=True)
    r.raise_for_status()
    with open(filename, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)
    print(f"✅ Download completato: {filename}\n")

def main():
    print("🎬 === AnimeSaturn MP4 Link Extractor === 🎬")
    print("Estrae il link MP4 diretto dagli episodi di animesaturn.cx\n")
    query = input("🔍 Nome anime da cercare: ").strip()
    if not query:
        print("❌ Query vuota, uscita.")
        return
    print(f"\n⏳ Ricerca di '{query}' in corso...")
    anime_results = search_anime(query)
    if not anime_results:
        print("❌ Nessun risultato trovato.")
        return
    print(f"\n✅ Trovati {len(anime_results)} risultati:")
    for i, a in enumerate(anime_results, 1):
        print(f"{i}) {a['title']}")
    try:
        idx = int(input("\n👆 Seleziona anime: ")) - 1
        selected = anime_results[idx]
    except Exception:
        print("❌ Selezione non valida.")
        return
    print(f"\n⏳ Recupero episodi di '{selected['title']}'...")
    episodes = get_episodes_list(selected["url"])
    if not episodes:
        print("❌ Nessun episodio trovato.")
        return
    print(f"\n✅ Trovati {len(episodes)} episodi:")
    for i, ep in enumerate(episodes, 1):
        print(f"{i}) {ep['title']}")
    try:
        ep_idx = int(input("\n👆 Seleziona episodio: ")) - 1
        ep_selected = episodes[ep_idx]
    except Exception:
        print("❌ Selezione non valida.")
        return
    print(f"\n⏳ Recupero link stream per '{ep_selected['title']}'...")
    watch_url = get_watch_url(ep_selected["url"])
    if not watch_url:
        print("❌ Link stream non trovato nella pagina episodio.")
        return
    print(f"\n🔗 Pagina stream: {watch_url}")
    mp4_url = extract_mp4_url(watch_url)
    if mp4_url:
        print(f"\n🎬 LINK MP4 FINALE:\n   {mp4_url}\n")
        print("🎉 ✅ Estrazione completata con successo!")
        # Oggetto stream per Stremio
        stremio_stream = {
            "url": mp4_url,
            "headers": {
                "Referer": watch_url,
                "User-Agent": USER_AGENT
            }
        }
        print("\n🔗 Oggetto stream per Stremio:")
        print(json.dumps(stremio_stream, indent=2))
        # Link proxy universale
        proxy_base = "https://mfpi.pizzapi.uk/proxy/stream/"
        filename = mp4_url.split("/")[-1].split("?")[0]
        proxy_url = (
            f"{proxy_base}{urllib.parse.quote(filename)}?d={urllib.parse.quote(mp4_url)}"
            f"&api_password=mfp"
            f"&h_user-agent={urllib.parse.quote(USER_AGENT)}"
            f"&h_referer={urllib.parse.quote(watch_url)}"
        )
        print("\n🔗 Link proxy universale (VLC/Stremio/Browser):")
        print(proxy_url)
        # Download automatico (opzionale)
        # download_mp4(mp4_url, watch_url)
    else:
        print("❌ LINK MP4 FINALE: Estrazione fallita")
        print("\n💡 Possibili cause dell'errore:")
        print("   • Episodio non disponibile")
        print("   • Struttura della pagina cambiata")
        print("   • Problemi di connessione")

def main_cli():
    parser = argparse.ArgumentParser(description="AnimeSaturn Scraper CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Search command
    search_parser = subparsers.add_parser("search", help="Search for an anime")
    search_parser.add_argument("--query", required=True, help="Anime title to search for")
    search_parser.add_argument("--mal-id", help="Optional MyAnimeList ID for better matching")

    # Get episodes command
    episodes_parser = subparsers.add_parser("get_episodes", help="Get episode list for an anime")
    episodes_parser.add_argument("--anime-url", required=True, help="AnimeSaturn URL of the anime")

    # Get stream command
    stream_parser = subparsers.add_parser("get_stream", help="Get stream URL for an episode")
    stream_parser.add_argument("--episode-url", required=True, help="AnimeSaturn episode URL")
    
    # Get all streams command (new)
    all_streams_parser = subparsers.add_parser("get_all_streams", help="Get all available stream URLs for an episode")
    all_streams_parser.add_argument("--episode-url", required=True, help="AnimeSaturn episode URL")

    args = parser.parse_args()

    if args.command == "search":
        results = search_anime(args.query, args.mal_id)
        print(json.dumps(results, indent=2))
    elif args.command == "get_episodes":
        results = get_episodes_list(args.anime_url)
        print(json.dumps(results, indent=2))
    elif args.command == "get_stream":
        watch_url = get_watch_url(args.episode_url)
        mp4_url = extract_mp4_url(watch_url) if watch_url else None
        stremio_stream = None
        if mp4_url:
            stremio_stream = {
                "url": mp4_url,
                "headers": {
                    "Referer": watch_url,
                    "User-Agent": USER_AGENT
                }
            }
        # Test: se vuoi solo il link mp4, restituisci {"url": mp4_url}
        print(json.dumps(stremio_stream if stremio_stream else {"url": mp4_url}, indent=2))
    elif args.command == "get_all_streams":
        watch_url = get_watch_url(args.episode_url)
        if not watch_url:
            print(json.dumps([], indent=2))
            return
        all_streams = extract_all_streams(watch_url)
        print(json.dumps(all_streams, indent=2))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        main_cli()
    else:
        main()
