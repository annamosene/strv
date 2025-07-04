#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vavoo_resolver.py
Script unico: dato il nome del canale, trova il link Vavoo e lo risolve in tempo reale.
"""
import sys
import requests
import json
import os
import re

def get_domain(service):
    config_path = os.path.join(os.path.dirname(__file__), 'config/domains.json')
    with open(config_path, 'r') as f:
        domains = json.load(f)
    return domains.get(service)

VAVOO_DOMAIN = get_domain("vavoo")

def getAuthSignature():
    """Funzione che replica esattamente quella dell'addon utils.py"""
    headers = {
        "user-agent": "okhttp/4.11.0",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "content-length": "1106",
        "accept-encoding": "gzip"
    }
    data = {
        "token": "tosFwQCJMS8qrW_AjLoHPQ41646J5dRNha6ZWHnijoYQQQoADQoXYSo7ki7O5-CsgN4CH0uRk6EEoJ0728ar9scCRQW3ZkbfrPfeCXW2VgopSW2FWDqPOoVYIuVPAOnXCZ5g",
        "reason": "app-blur",
        "locale": "de",
        "theme": "dark",
        "metadata": {
            "device": {
                "type": "Handset",
                "brand": "google",
                "model": "Nexus",
                "name": "21081111RG",
                "uniqueId": "d10e5d99ab665233"
            },
            "os": {
                "name": "android",
                "version": "7.1.2",
                "abis": ["arm64-v8a", "armeabi-v7a", "armeabi"],
                "host": "android"
            },
            "app": {
                "platform": "android",
                "version": "3.1.20",
                "buildId": "289515000",
                "engine": "hbc85",
                "signatures": ["6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e"],
                "installer": "app.revanced.manager.flutter"
            },
            "version": {
                "package": "tv.vavoo.app",
                "binary": "3.1.20",
                "js": "3.1.20"
            }
        },
        "appFocusTime": 0,
        "playerActive": False,
        "playDuration": 0,
        "devMode": False,
        "hasAddon": True,
        "castConnected": False,
        "package": "tv.vavoo.app",
        "version": "3.1.20",
        "process": "app",
        "firstAppStart": 1743962904623,
        "lastAppStart": 1743962904623,
        "ipLocation": "",
        "adblockEnabled": True,
        "proxy": {
            "supported": ["ss", "openvpn"],
            "engine": "ss",
            "ssVersion": 1,
            "enabled": True,
            "autoServer": True,
            "id": "pl-waw"
        },
        "iap": {
            "supported": False
        }
    }
    try:
        resp = requests.post("https://www.vavoo.tv/api/app/ping", json=data, headers=headers, timeout=10)
        resp.raise_for_status()
        return resp.json().get("addonSig")
    except Exception as e:
        print(f"Errore nel recupero della signature: {e}", file=sys.stderr)
        return None

def get_channels():
    signature = getAuthSignature()
    if not signature:
        print("[DEBUG] Failed to get signature for channels", file=sys.stderr)
        return []
    
    headers = {
        "user-agent": "okhttp/4.11.0",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "mediahubmx-signature": signature
    }
    all_channels = []
    for group in ["Italy"]:
        cursor = 0
        while True:
            data = {
                "language": "de",
                "region": "AT",
                "catalogId": "iptv",
                "id": "iptv",
                "adult": False,
                "search": "",
                "sort": "name",
                "filter": {"group": group},
                "cursor": cursor,
                "clientVersion": "3.0.2"
            }
            try:
                resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-catalog.json", json=data, headers=headers, timeout=10)
                resp.raise_for_status()
                r = resp.json()
                items = r.get("items", [])
                all_channels.extend(items)
                cursor = r.get("nextCursor")
                if not cursor:
                    break
            except Exception as e:
                print(f"[DEBUG] Error getting channels: {e}", file=sys.stderr)
                break
    return all_channels

def resolve_vavoo_link(link):
    signature = getAuthSignature()
    if not signature:
        print("[DEBUG] Failed to get signature for resolution", file=sys.stderr)
        return None
        
    headers = {
        "user-agent": "MediaHubMX/2",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "content-length": "115",
        "accept-encoding": "gzip",
        "mediahubmx-signature": signature
    }
    data = {
        "language": "de",
        "region": "AT",
        "url": link,
        "clientVersion": "3.0.2"
    }
    try:
        resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-resolve.json", json=data, headers=headers, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        if isinstance(result, list) and result and result[0].get("url"):
            return result[0]["url"]
        elif isinstance(result, dict) and result.get("url"):
            return result["url"]
        else:
            print(f"[DEBUG] Unexpected response format: {result}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[DEBUG] Error resolving link: {e}", file=sys.stderr)
        return None

def normalize_vavoo_name(name):
    # Rimuove suffisso tipo ' .c', ' .a', ' .b' alla fine
    name = name.strip()
    name = re.sub(r'\s+\.[a-zA-Z]$', '', name)
    return name.upper()

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python3 vavoo_resolver.py <channel_name>", file=sys.stderr)
        sys.exit(1)
    
    wanted = normalize_vavoo_name(sys.argv[1])
    print(f"[DEBUG] Looking for channel: {wanted}", file=sys.stderr)
    
    try:
        channels = get_channels()
        print(f"[DEBUG] Found {len(channels)} total channels", file=sys.stderr)
        
        found = None
        for ch in channels:
            chname = normalize_vavoo_name(ch.get('name', ''))
            if chname == wanted:
                found = ch
                print(f"[DEBUG] Found matching channel: {ch.get('name')}", file=sys.stderr)
                break
        
        if not found:
            print(f"[DEBUG] Channel '{wanted}' not found in {len(channels)} channels", file=sys.stderr)
            # Debug: mostra alcuni nomi di canali per aiutare
            sample_names = [normalize_vavoo_name(ch.get('name', '')) for ch in channels[:10]]
            print(f"[DEBUG] Sample channel names: {sample_names}", file=sys.stderr)
            print("NOT_FOUND", file=sys.stderr)
            sys.exit(2)
            
        url = found.get('url')
        if not url:
            print("[DEBUG] No URL found for channel", file=sys.stderr)
            print("NO_URL", file=sys.stderr)
            sys.exit(3)
            
        print(f"[DEBUG] Resolving URL: {url}", file=sys.stderr)
        resolved = resolve_vavoo_link(url)
        if resolved:
            print(resolved)  # Questo è l'output che viene letto
            sys.exit(0)
        else:
            print("[DEBUG] Failed to resolve URL", file=sys.stderr)
            print("RESOLVE_FAIL", file=sys.stderr)
            sys.exit(4)
            
    except Exception as e:
        print(f"[DEBUG] Exception: {str(e)}", file=sys.stderr)
        print("ERROR", file=sys.stderr)
        sys.exit(5) 
