#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Vavoo Link Resolver - Versione migliorata
Usa gli stessi parametri dell'addon plugin.video.vavooto per risolvere i link Vavoo
"""

import requests
import json
import sys
import time
from urllib.parse import quote_plus

class VavooResolver:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'MediaHubMX/2'
        })

    def getAuthSignature(self):
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
            resp = self.session.post("https://www.vavoo.tv/api/app/ping", json=data, headers=headers, timeout=10)
            resp.raise_for_status()
            return resp.json().get("addonSig")
        except Exception as e:
            print(f"Errore nel recupero della signature: {e}")
            return None

    def gettsSignature(self):
        """Funzione che replica esattamente quella dell'addon utils.py per il fallback"""
        vec = {"vec": "9frjpxPjxSNilxJPCJ0XGYs6scej3dW/h/VWlnKUiLSG8IP7mfyDU7NirOlld+VtCKGj03XjetfliDMhIev7wcARo+YTU8KPFuVQP9E2DVXzY2BFo1NhE6qEmPfNDnm74eyl/7iFJ0EETm6XbYyz8IKBkAqPN/Spp3PZ2ulKg3QBSDxcVN4R5zRn7OsgLJ2CNTuWkd/h451lDCp+TtTuvnAEhcQckdsydFhTZCK5IiWrrTIC/d4qDXEd+GtOP4hPdoIuCaNzYfX3lLCwFENC6RZoTBYLrcKVVgbqyQZ7DnLqfLqvf3z0FVUWx9H21liGFpByzdnoxyFkue3NzrFtkRL37xkx9ITucepSYKzUVEfyBh+/3mtzKY26VIRkJFkpf8KVcCRNrTRQn47Wuq4gC7sSwT7eHCAydKSACcUMMdpPSvbvfOmIqeBNA83osX8FPFYUMZsjvYNEE3arbFiGsQlggBKgg1V3oN+5ni3Vjc5InHg/xv476LHDFnNdAJx448ph3DoAiJjr2g4ZTNynfSxdzA68qSuJY8UjyzgDjG0RIMv2h7DlQNjkAXv4k1BrPpfOiOqH67yIarNmkPIwrIV+W9TTV/yRyE1LEgOr4DK8uW2AUtHOPA2gn6P5sgFyi68w55MZBPepddfYTQ+E1N6R/hWnMYPt/i0xSUeMPekX47iucfpFBEv9Uh9zdGiEB+0P3LVMP+q+pbBU4o1NkKyY1V8wH1Wilr0a+q87kEnQ1LWYMMBhaP9yFseGSbYwdeLsX9uR1uPaN+u4woO2g8sw9Y5ze5XMgOVpFCZaut02I5k0U4WPyN5adQjG8sAzxsI3KsV04DEVymj224iqg2Lzz53Xz9yEy+7/85ILQpJ6llCyqpHLFyHq/kJxYPhDUF755WaHJEaFRPxUqbparNX+mCE9Xzy7Q/KTgAPiRS41FHXXv+7XSPp4cy9jli0BVnYf13Xsp28OGs/D8Nl3NgEn3/eUcMN80JRdsOrV62fnBVMBNf36+LbISdvsFAFr0xyuPGmlIETcFyxJkrGZnhHAxwzsvZ+Uwf8lffBfZFPRrNv+tgeeLpatVcHLHZGeTgWWml6tIHwWUqv2TVJeMkAEL5PPS4Gtbscau5HM+FEjtGS+KClfX1CNKvgYJl7mLDEf5ZYQv5kHaoQ6RcPaR6vUNn02zpq5/X3EPIgUKF0r/0ctmoT84B2J1BKfCbctdFY9br7JSJ6DvUxyde68jB+Il6qNcQwTFj4cNErk4x719Y42NoAnnQYC2/qfL/gAhJl8TKMvBt3Bno+va8ve8E0z8yEuMLUqe8OXLce6nCa+L5LYK1aBdb60BYbMeWk1qmG6Nk9OnYLhzDyrd9iHDd7X95OM6X5wiMVZRn5ebw4askTTc50xmrg4eic2U1w1JpSEjdH/u/hXrWKSMWAxaj34uQnMuWxPZEXoVxzGyuUbroXRfkhzpqmqqqOcypjsWPdq5BOUGL/Riwjm6yMI0x9kbO8+VoQ6RYfjAbxNriZ1cQ+AW1fqEgnRWXmjt4Z1M0ygUBi8w71bDML1YG6UHeC2cJ2CCCxSrfycKQhpSdI1QIuwd2eyIpd4LgwrMiY3xNWreAF+qobNxvE7ypKTISNrz0iYIhU0aKNlcGwYd0FXIRfKVBzSBe4MRK2pGLDNO6ytoHxvJweZ8h1XG8RWc4aB5gTnB7Tjiqym4b64lRdj1DPHJnzD4aqRixpXhzYzWVDN2kONCR5i2quYbnVFN4sSfLiKeOwKX4JdmzpYixNZXjLkG14seS6KR0Wl8Itp5IMIWFpnNokjRH76RYRZAcx0jP0V5/GfNNTi5QsEU98en0SiXHQGXnROiHpRUDXTl8FmJORjwXc0AjrEMuQ2FDJDmAIlKUSLhjbIiKw3iaqp5TVyXuz0ZMYBhnqhcwqULqtFSuIKpaW8FgF8QJfP2frADf4kKZG1bQ99MrRrb2A="}
        try:
            url = 'https://www.vavoo.tv/api/box/ping2'
            req = self.session.post(url, data=vec).json()
            return req['response'].get('signed')
        except Exception as e:
            print(f"Errore nel recupero della ts signature: {e}")
            return None

    def resolve_link(self, link, streammode=1, verbose=True):
        """
        Risolve un link Vavoo usando gli stessi parametri dell'addon
        streammode=1: usa mediahubmx-resolve (metodo principale)
        streammode=0: usa il metodo ts con gettsSignature (fallback)
        """
        if not "vavoo" in link:
            if verbose:
                print("Il link non sembra essere un link Vavoo")
            return None

        if streammode == 1:
            # Metodo principale - stesso di vjlive.py
            signature = self.getAuthSignature()
            if not signature:
                if verbose:
                    print("Impossibile ottenere la signature, provo il fallback...")
                return self.resolve_link(link, streammode=0, verbose=verbose)

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
                resp = self.session.post("https://vavoo.to/mediahubmx-resolve.json", json=data, headers=headers, timeout=10)
                resp.raise_for_status()

                if verbose:
                    print(f"Status: {resp.status_code}")
                    print(f"Body: {resp.text}")

                result = resp.json()
                if isinstance(result, list) and result and result[0].get("url"):
                    resolved_url = result[0]["url"]
                    channel_name = result[0].get("name", "Unknown")
                    if verbose:
                        print(f"Canale: {channel_name}")
                    return resolved_url
                elif isinstance(result, dict) and result.get("url"):
                    return result["url"]
                else:
                    if verbose:
                        print("Nessun link valido trovato nella risposta")
                    return None

            except Exception as e:
                if verbose:
                    print(f"Errore nel metodo principale: {e}")
                return None
        else:
            # Metodo fallback - stesso di vjlive.py
            try:
                ts_signature = self.gettsSignature()
                if not ts_signature:
                    if verbose:
                        print("Impossibile ottenere la ts signature")
                    return None

                ts_url = "%s.ts?n=1&b=5&vavoo_auth=%s" % (link.replace("vavoo-iptv", "live2")[0:-12], ts_signature)
                return ts_url
            except Exception as e:
                if verbose:
                    print(f"Errore nel metodo fallback: {e}")
                return None

    def test_url(self, url):
        """Testa se un URL risolto è effettivamente accessibile"""
        try:
            resp = self.session.head(url, timeout=5)
            return resp.status_code == 200
        except:
            return False

    def resolve_with_fallback(self, link, verbose=True):
        """Risolve un link provando prima il metodo principale e poi il fallback"""
        if verbose:
            print(f"Risoluzione link: {link}")
            print("Provo il metodo principale (streammode=1)...")

        resolved = self.resolve_link(link, streammode=1, verbose=verbose)
        if resolved:
            if verbose:
                print("✅ Metodo principale riuscito")
            return resolved, "principale"

        if verbose:
            print("❌ Metodo principale fallito, provo il fallback...")
        resolved = self.resolve_link(link, streammode=0, verbose=verbose)
        if resolved:
            if verbose:
                print("✅ Metodo fallback riuscito")
            return resolved, "fallback"

        if verbose:
            print("❌ Entrambi i metodi sono falliti")
        return None, None

def main():
    resolver = VavooResolver()

    # Link di test
    test_links = [
        "https://vavoo.to/vavoo-iptv/play/277580225585f503fbfc87",
        # Aggiungi qui altri link da testare
    ]

    if len(sys.argv) > 1:
        # Link passato come argomento
        link = sys.argv[1]
        resolved, method = resolver.resolve_with_fallback(link)
        if resolved:
            print(f"\n🎯 Link risolto con metodo {method}:")
            print(resolved)
        else:
            print("\n❌ Impossibile risolvere il link")
            sys.exit(1)
    else:
        # Test con i link predefiniti
        for i, link in enumerate(test_links, 1):
            print(f"\n{'='*60}")
            print(f"Test {i}/{len(test_links)}")
            print(f"{'='*60}")

            resolved, method = resolver.resolve_with_fallback(link)
            if resolved:
                print(f"\n🎯 Risolto con metodo {method}:")
                print(resolved)

                # Test di accessibilità (opzionale)
                print("\n🔍 Test accessibilità URL...")
                if resolver.test_url(resolved):
                    print("✅ URL accessibile")
                else:
                    print("⚠️  URL potrebbe non essere accessibile")
            else:
                print("\n❌ Risoluzione fallita")

            if i < len(test_links):
                print("\nPremere Enter per continuare...")
                input()

if __name__ == "__main__":
    main()
