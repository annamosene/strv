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
                "os": "Android",
                "osVersion": "10",
                "model": "Pixel 4",
                "brand": "Google"
            }
        }
    }
    resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-signature.json", json=data, headers=headers, timeout=10)
    return resp.json().get("signature")

def get_channels():
    signature = getAuthSignature()
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
            resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-catalog.json", json=data, headers=headers, timeout=10)
            r = resp.json()
            items = r.get("items", [])
            all_channels.extend(items)
            cursor = r.get("nextCursor")
            if not cursor:
                break
    return all_channels

def resolve_vavoo_link(link):
    signature = getAuthSignature()
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
        result = resp.json()
        if isinstance(result, list) and result and result[0].get("url"):
            return result[0]["url"]
        elif isinstance(result, dict) and result.get("url"):
            return result["url"]
        else:
            return None
    except Exception as e:
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
