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
import os
from urllib.parse import urljoin, urlparse, parse_qs

# Leggi domini dal file domains.json se disponibile
def load_domains():
    try:
        # Trova il percorso del file domains.json
        current_dir = os.path.dirname(os.path.abspath(__file__))
        root_dir = os.path.dirname(os.path.dirname(current_dir))
        domains_path = os.path.join(root_dir, "config", "domains.json")
        
        # Se il file esiste, leggilo
        if os.path.exists(domains_path):
            with open(domains_path, 'r') as f:
                domains_config = json.load(f)
                if 'animesaturn' in domains_config:
                    main_domain = domains_config['animesaturn']
                    # Crea varianti del dominio principale
                    domain_variants = [
                        main_domain,
                        f"www.{main_domain}"
                    ]
                    base_url = f"https://www.{main_domain}"
                    print(f"DEBUG: Caricati domini da domains.json: {domain_variants}", file=sys.stderr)
                    print(f"DEBUG: URL base: {base_url}", file=sys.stderr)
                    return domain_variants, base_url
    except Exception as e:
        print(f"DEBUG: Errore nel caricamento domini da domains.json: {e}", file=sys.stderr)
    
    # Fallback ai domini predefiniti
    default_domains = [
        "animesaturn.cx",
        "www.animesaturn.cx"
    ]
    default_base_url = "https://www.animesaturn.io"
    print(f"DEBUG: Usando domini predefiniti: {default_domains}", file=sys.stderr)
    return default_domains, default_base_url

# Supporta diversi possibili domini di AnimeSaturn
BASE_DOMAINS, BASE_URL = load_domains()
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
    """
    Ottiene l'URL della pagina di streaming da una pagina episodio
    Prova più pattern per trovare il link corretto
    """
    print(f"DEBUG: Ottenendo URL watch per: {episode_url}", file=sys.stderr)
    
    # Gestisci formati URL diversi e domini alternativi
    try:
        # Prova con diversi domini se quello corrente fallisce
        success = False
        html_content = None
        
        # Ottieni un'URL valida da provare basata sul BASE_URL attuale
        current_url = episode_url
        
        for attempt in range(2):  # Prova prima con l'URL originale, poi con tutti i domini
            try:
                resp = requests.get(current_url, headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
                html_content = resp.text
                success = True
                break
            except Exception as e:
                print(f"DEBUG: Errore durante l'accesso a {current_url}: {e}", file=sys.stderr)
                if attempt == 0:  # Se il primo tentativo fallisce, prova con altri domini
                    # Estrai il percorso dall'URL originale
                    parsed = urlparse(episode_url)
                    path_query = parsed.path
                    if parsed.query:
                        path_query += "?" + parsed.query
                        
                    # Trova un dominio alternativo
                    for domain in BASE_DOMAINS:
                        if domain not in episode_url:
                            current_url = f"https://{domain}{path_query}"
                            print(f"DEBUG: Tentativo con URL alternativo: {current_url}", file=sys.stderr)
                            break
        
        if not success or not html_content:
            print(f"ERROR: Impossibile accedere a {episode_url} o URL alternativi", file=sys.stderr)
            return None
            
        soup = BeautifulSoup(html_content, "html.parser")
        
        # 1. Se la pagina contiene già un video player, potrebbe essere già la pagina di streaming
        if soup.find("video") or "player" in html_content.lower() or "jwplayer" in html_content.lower():
            if "watch?file=" in current_url:
                print(f"DEBUG: La pagina è già una pagina di streaming: {current_url}", file=sys.stderr)
                return current_url
        
        # 2. Cerca link con testo "Guarda lo streaming" o simili
        streaming_texts = ["guarda lo streaming", "guarda episodio", "guarda anime", "guarda", "streaming", "play", "watch"]
        for a in soup.find_all("a", href=True):
            href = a["href"]
            text = a.get_text(" ", strip=True).lower()
            
            # Controlla sia il testo che eventuali div interni
            div_text = ""
            for div in a.find_all("div"):
                div_text += div.get_text(" ", strip=True).lower() + " "
            
            combined_text = text + " " + div_text
            if any(txt in combined_text for txt in streaming_texts):
                result = href if href.startswith("http") else urljoin(current_url, href)
                print(f"DEBUG: Trovato link per lo streaming: {result}", file=sys.stderr)
                return result
            
        # 3. Cerca qualsiasi link alla pagina watch
        watch_patterns = [
            "watch?file=", 
            "/watch/", 
            "/player/", 
            "/streaming/",
            "/video/"
        ]
        
        for a in soup.find_all(["a", "button", "div"], href=True) + soup.find_all(["a", "button", "div"], **{"data-href": True}):
            href = a.get("href") or a.get("data-href") or ""
            if any(pattern in href for pattern in watch_patterns):
                result = href if href.startswith("http") else urljoin(current_url, href)
                print(f"DEBUG: Trovato link watch: {result}", file=sys.stderr)
                return result
            
        # 4. Cerca iframe
        for iframe in soup.find_all("iframe", src=True):
            src = iframe["src"]
            if any(pattern in src for pattern in watch_patterns) or "embed" in src:
                result = src if src.startswith("http") else urljoin(current_url, src)
                print(f"DEBUG: Trovato iframe con src: {result}", file=sys.stderr)
                return result
        
        # 5. Se non troviamo nulla, cerca nel codice JavaScript
        # Diversi pattern per trovare link di streaming nei script
        js_patterns = [
            r'(?:player|stream|video)(?:URL|Src|Path|Link)["\s:=]+([^"\';\s}]+)',
            r'["\'](?:file|src|source)["\']:\s*["\']([^"\']+watch[^"\']+)["\']',
            r'window\.location\.href\s*=\s*["\']([^"\']+watch[^"\']+)["\']',
            r'["\'](?:url|link|href)["\']:\s*["\']([^"\']+watch[^"\']+)["\']'
        ]
        
        for pattern in js_patterns:
            matches = re.findall(pattern, html_content)
            for match in matches:
                if "watch" in match:
                    result = match if match.startswith("http") else urljoin(current_url, match)
                    print(f"DEBUG: Trovato link watch in JavaScript: {result}", file=sys.stderr)
                    return result
    
    except Exception as e:
        print(f"ERROR: Errore durante l'estrazione dell'URL watch: {e}", file=sys.stderr)
    
    print(f"DEBUG: Nessun link di streaming trovato in {episode_url}", file=sys.stderr)
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
                # Se è un jwplayer, estrai solo l'URL diretto del file
                if var_name == "jwplayer" and "file:" in value:
                    file_match = re.search(r'file:\s*["\']([^"\']+)["\']', value)
                    if file_match:
                        results[var_name] = file_match.group(1)
                    else:
                        results[var_name] = value
                else:
                    results[var_name] = value
    return results

def get_alternative_servers(watch_url):
    """
    Ottiene URL dei server alternativi da una pagina
    Considera solo il player alternativo con s=alt, non i server=X
    """
    servers = []
    try:
        # Verifica se siamo già nella pagina alternativa
        parsed_url = urlparse(watch_url)
        params = parse_qs(parsed_url.query)
        file_param = params.get('file', [''])[0]
        alt_param = params.get('s', [''])[0]
        
        # Solo se non siamo già nel player alternativo
        if file_param and alt_param != 'alt':
            # Solo il player alternativo principale
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
    Estrae tutti i possibili stream (mp4, m3u8) da una pagina di AnimeSaturn
    Priorità:
    1. Link MP4 diretti
    2. Link M3U8/HLS
    3. Player alternativo (s=alt)
    
    Ignora:
    - Link ai server alternativi (server=X)
    - Altri tipi di link
    
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
    
    # Array separati per diversi tipi di stream, per dare priorità
    mp4_streams = []  # Priorità alta
    hls_streams = []  # Priorità media
    alt_server_streams = [] # Player alternativo
    
    try:
        # Prova con diversi domini se quello corrente fallisce
        success = False
        html_content = None
        
        # Ottieni un'URL valida da provare basata sul BASE_URL attuale
        current_url = watch_url
        
        for attempt in range(2):  # Prova prima con l'URL originale, poi con tutti i domini
            try:
                resp = requests.get(current_url, headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
                html_content = resp.text
                success = True
                break
            except:
                if attempt == 0:  # Se il primo tentativo fallisce, prova con altri domini
                    # Estrai il percorso dall'URL originale
                    parsed = urlparse(watch_url)
                    path_query = parsed.path
                    if parsed.query:
                        path_query += "?" + parsed.query
                        
                    # Trova un dominio alternativo
                    for domain in BASE_DOMAINS:
                        if domain not in watch_url:
                            current_url = f"https://{domain}{path_query}"
                            print(f"DEBUG: Tentativo con URL alternativo: {current_url}", file=sys.stderr)
                            break
        
        if not success or not html_content:
            print(f"ERROR: Impossibile accedere a {watch_url} o URL alternativi", file=sys.stderr)
            return []
            
        soup = BeautifulSoup(html_content, "html.parser")
        
        # 1. Estrai link MP4 diretti da regex e video tags
        # Cerca qualsiasi URL di video (MP4, WebM, ecc.)
        mp4_urls = re.findall(r'(https?://[\w\.-]+/[^"\'<>\s]+\.(?:mp4|webm)[^"\'<>\s]*)', html_content)
        
        for mp4_url in mp4_urls:
            if not any(s['url'] == mp4_url for s in mp4_streams):
                mp4_streams.append({
                    "url": mp4_url,
                    "server": "Direct MP4",
                    "quality": "HD",
                    "headers": {
                        "Referer": current_url,
                        "User-Agent": USER_AGENT
                    }
                })
        
        # 2. Controlla video tag e source tags
        video_tags = soup.find_all("video")
        for video in video_tags:
            sources = video.find_all("source", src=True)
            for source in sources:
                src = source["src"]
                # Assicurati che l'URL sia assoluto
                if src.startswith("//"):
                    src = "https:" + src
                elif src.startswith("/"):
                    src = BASE_URL + src
                    
                quality = source.get("label", "HD") or source.get("res", "HD") or "HD"
                
                # Separa in MP4 e M3U8 stream
                if any(ext in src.lower() for ext in [".mp4", ".webm"]):
                    if not any(s['url'] == src for s in mp4_streams):
                        mp4_streams.append({
                            "url": src,
                            "server": "Direct MP4",
                            "quality": quality,
                            "headers": {
                                "Referer": current_url,
                                "User-Agent": USER_AGENT
                            }
                        })
                elif ".m3u8" in src.lower():
                    if not any(s['url'] == src for s in hls_streams):
                        hls_streams.append({
                            "url": src,
                            "server": "Direct HLS",
                            "quality": quality,
                            "headers": {
                                "Referer": current_url,
                                "User-Agent": USER_AGENT
                            }
                        })
        
        # 3. Estrai link m3u8 da script (pattern più aggressivo per trovare tutti)
        m3u8_patterns = [
            r'(https?://[\w\.-]+/[^"\'<>\s]+\.m3u8[^"\'<>\s]*)',
            r'file:\s*["\'](.+?\.m3u8.*?)["\']', 
            r'source:\s*["\'](.+?\.m3u8.*?)["\']',
            r'src:\s*["\'](.+?\.m3u8.*?)["\']',
            r'url:\s*["\'](.+?\.m3u8.*?)["\']',
            r'videoSrc\s*[:=]\s*["\'](.+?\.m3u8.*?)["\']',
            r'"(.+?\.m3u8.*?)"',
            r"'(.+?\.m3u8.*?)'"
        ]
        
        for pattern in m3u8_patterns:
            for m3u8_url in re.findall(pattern, html_content):
                # Assicurati che l'URL sia assoluto
                if m3u8_url.startswith("//"):
                    m3u8_url = "https:" + m3u8_url
                elif m3u8_url.startswith("/"):
                    m3u8_url = BASE_URL + m3u8_url
                    
                if "http" in m3u8_url and not any(s['url'] == m3u8_url for s in hls_streams):
                    hls_streams.append({
                        "url": m3u8_url,
                        "server": "HLS Stream",
                        "quality": "Auto",
                        "headers": {
                            "Referer": current_url,
                            "User-Agent": USER_AGENT
                        }
                    })
        
        # 4. Controlla script per dati JSON o variabili
        js_vars = search_js_variables(html_content, {
            "playerSource": r'file[:"\'=\s]+([^"\';\s}]+)',
            "videoSrc": r'source[:"\'=\s]+([^"\';\s}]+)',
            "videoUrl": r'url[:"\'=\s]+([^"\';\s}]+)',
            "playerData": r'player_data\s*=\s*([^;]+)',
            "jwplayer": r'jwplayer\([^\)]+\)\.setup\(\s*(\{[^\}]+\})',
            "base64Data": r'atob\([\'"]([^\'"]+)[\'"]\)'
        })
        
        # 4.1 Estrai URL da setup di jwplayer se presente
        jwplayer_matches = re.findall(r'jwplayer\([^\)]+\).setup\(\s*\{[^}]*?file:\s*"([^"]+)"', html_content)
        for jwp_url in jwplayer_matches:
            if ".m3u8" in jwp_url.lower() and not any(s['url'] == jwp_url for s in hls_streams):
                hls_streams.append({
                    "url": jwp_url,
                    "server": "JWPlayer HLS",
                    "quality": "Auto",
                    "headers": {
                        "Referer": current_url,
                        "User-Agent": USER_AGENT
                    }
                })
        
        for var_name, value in js_vars.items():
            if isinstance(value, str) and ("http" in value):
                # Assicurati che l'URL sia assoluto
                if value.startswith("//"):
                    value = "https:" + value
                elif value.startswith("/") and "://" not in value:
                    value = BASE_URL + value
                    
                if ".mp4" in value.lower() or ".webm" in value.lower():
                    if not any(s['url'] == value for s in mp4_streams):
                        mp4_streams.append({
                            "url": value,
                            "server": f"JavaScript {var_name}",
                            "quality": "unknown",
                            "headers": {
                                "Referer": current_url,
                                "User-Agent": USER_AGENT
                            }
                        })
                elif ".m3u8" in value.lower():
                    if not any(s['url'] == value for s in hls_streams):
                        hls_streams.append({
                            "url": value,
                            "server": f"JavaScript {var_name}",
                            "quality": "unknown",
                            "headers": {
                                "Referer": current_url,
                                "User-Agent": USER_AGENT
                            }
                        })
        
        # 5. Estrai dati base64 e cerca URL
        base64_matches = re.findall(r'atob\([\'"]([^\'"]+)[\'"]\)', html_content)
        for b64 in base64_matches:
            try:
                decoded = base64.b64decode(b64).decode('utf-8')
                # Cerca URL MP4
                mp4_urls = re.findall(r'(https?://[\w\.-]+/[^"\'<>\s]+\.(?:mp4|webm)[^"\'<>\s]*)', decoded)
                for url in mp4_urls:
                    if not any(s['url'] == url for s in mp4_streams):
                        mp4_streams.append({
                            "url": url,
                            "server": "Base64 MP4",
                            "quality": "unknown",
                            "headers": {
                                "Referer": current_url,
                                "User-Agent": USER_AGENT
                            }
                        })
                
                # Cerca URL M3U8
                m3u8_urls = re.findall(r'(https?://[\w\.-]+/[^"\'<>\s]+\.m3u8[^"\'<>\s]*)', decoded)
                for url in m3u8_urls:
                    if not any(s['url'] == url for s in hls_streams):
                        hls_streams.append({
                            "url": url,
                            "server": "Base64 HLS",
                            "quality": "unknown",
                            "headers": {
                                "Referer": current_url,
                                "User-Agent": USER_AGENT
                            }
                        })
            except:
                pass
        
        # 6. SOLO il player alternativo (s=alt), ignora i link ai server=X
        # Cerca sia in a href che in pulsanti e link vari
        all_links = soup.find_all(["a", "button", "div"], href=True) + soup.find_all(["a", "button", "div"], **{"data-href": True})
        for link in all_links:
            href = link.get("href") or link.get("data-href") or ""
            # Verifica che il link sia per il player alternativo (s=alt) e non per server=X
            if href and "watch" in href and "s=alt" in href and "server=" not in href:
                # Make sure URL is absolute
                if href.startswith("//"):
                    href = "https:" + href
                elif href.startswith("/"):
                    href = BASE_URL + href
                
                # Controlla se non abbiamo già questo link
                if not any(s['url'] == href for s in alt_server_streams):
                    alt_server_streams.append({
                        "url": href,
                        "server": "Player Alternativo",
                        "quality": "unknown",
                        "headers": {
                            "Referer": current_url,
                            "User-Agent": USER_AGENT
                        }
                    })
        
        # 7. Cerca solo il player alternativo, ignora altri server
        alt_servers = get_alternative_servers(current_url)
        for alt_url in alt_servers:
            if alt_url not in already_visited:
                print(f"DEBUG: Controllando player alternativo: {alt_url}", file=sys.stderr)
                # Estrai stream dal player alternativo
                alt_streams = extract_all_streams(alt_url, already_visited)
                
                # Aggiungi solo stream dal player alternativo che non sono già presenti
                for alt_stream in alt_streams:
                    # Verifica se è un vero stream e non un link a una pagina
                    if "watch?file=" in alt_stream['url'] and "s=alt" not in alt_stream['url']:
                        # Se è un link a un'altra pagina di navigazione, salta
                        continue
                        
                    if any(ext in alt_stream['url'].lower() for ext in [".mp4", ".webm"]):
                        if not any(s['url'] == alt_stream['url'] for s in mp4_streams):
                            # Marca come alternativo
                            alt_stream['server'] = f"Alt: {alt_stream['server']}"
                            mp4_streams.append(alt_stream)
                    elif ".m3u8" in alt_stream['url'].lower():
                        if not any(s['url'] == alt_stream['url'] for s in hls_streams):
                            alt_stream['server'] = f"Alt: {alt_stream['server']}"
                            hls_streams.append(alt_stream)
        
    except Exception as e:
        print(f"ERROR: Errore durante l'estrazione degli stream: {e}", file=sys.stderr)
    
    # Combina gli stream in ordine di priorità e FILTRA gli URL che non sono stream diretti
    final_streams = []
    
    # 1. Aggiungi MP4 streams (priorità più alta)
    for stream in mp4_streams:
        if not any(s['url'] == stream['url'] for s in final_streams) and is_direct_stream(stream['url']):
            final_streams.append(stream)
    
    # 2. Aggiungi HLS streams (priorità media)
    for stream in hls_streams:
        if not any(s['url'] == stream['url'] for s in final_streams) and is_direct_stream(stream['url']):
            final_streams.append(stream)
            
    # 3. Aggiungi player alternativo SOLO SE non abbiamo trovato altri stream
    if not final_streams:
        for stream in alt_server_streams:
            if not any(s['url'] == stream['url'] for s in final_streams):
                final_streams.append(stream)
    
    # Debug log
    print(f"DEBUG: Trovati {len(final_streams)} stream per URL: {watch_url}", file=sys.stderr)
    for i, s in enumerate(final_streams):
        print(f"DEBUG: Stream {i+1}: {s['server']} - {s['url']}", file=sys.stderr)
                
    return final_streams

def is_direct_stream(url):
    """
    Verifica se un URL è un link diretto a uno stream video
    e non un link a un'altra pagina di navigazione
    """
    # Se l'URL non è una stringa, non può essere un link diretto
    if not isinstance(url, str):
        return False
    
    # Se contiene estensioni di file comuni per video, è probabilmente un link diretto
    if any(ext in url.lower() for ext in ['.mp4', '.m3u8', '.ts', '.webm']):
        return True
    
    # Se inizia con { e contiene "file:", è un oggetto JS non un URL diretto
    if url.strip().startswith('{') and 'file:' in url:
        return False
    
    # Se contiene parametri come server=X, non è un link diretto
    if 'server=' in url:
        return False
        
    # Se contiene s=alt ma anche altri parametri di navigazione, probabilmente non è un link diretto
    if 's=alt' in url and 'watch?file=' in url:
        return False
    
    # Se contiene watch?file= ma non estensioni di file video, probabilmente è un link di navigazione
    if 'watch?file=' in url:
        return False
        
    return True

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
            print(f"DEBUG: Nessuna URL di streaming trovata per {args.episode_url}", file=sys.stderr)
            print(json.dumps([], indent=2))
            return
        print(f"DEBUG: URL di streaming trovata: {watch_url}", file=sys.stderr)
        all_streams = extract_all_streams(watch_url)
        print(json.dumps(all_streams, indent=2))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        main_cli()
    else:
        main()
