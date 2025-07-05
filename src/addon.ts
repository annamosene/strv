import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';
import { AnimeUnityConfig } from "./types/animeunity";
import { execFile } from 'child_process';
import { EPGManager } from './utils/epg';

// Definiamo temporaneamente process per evitare errori TypeScript
declare const process: any;
declare const __dirname: string;

// Interfaccia per la configurazione URL
interface AddonConfig {
  mediaFlowProxyUrl?: string;
  mediaFlowProxyPassword?: string;
  tmdbApiKey?: string;
  bothLinks?: string;
  animeunityEnabled?: string;
  animesaturnEnabled?: string;
  enableLiveTV?: string;
  mfpProxyUrl?: string;
  mfpProxyPassword?: string;
  tvProxyUrl?: string;
  [key: string]: any;
}

// Base manifest configuration
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "2.0.1",
    name: "StreamViX",
    description: "Addon for Vixsrc and AnimeUnity streams.", 
    icon: "/public/icon.png",
    background: "/public/backround.png",
    types: ["movie", "series", "tv"],
    idPrefixes: ["tt", "kitsu", "tv"],
    catalogs: [
        {
            type: "tv",
            id: "tv-channels",
            name: "StreamViX TV",
            extra: [
                {
                    name: "genre",
                    isRequired: false,
                    options: [
                        "RAI",
                        "Mediaset", 
                        "Sky",
                        "Bambini",
                        "News",
                        "Sport",
                        "Cinema",
                        "Generali"
                    ]
                }
            ]
        }
    ],
    resources: ["stream", "catalog", "meta"],
    behaviorHints: {
        configurable: true
    },
    config: [
        {
            key: "tmdbApiKey",
            title: "TMDB API Key",
            type: "text"
        },
        {
            key: "mediaFlowProxyUrl", 
            title: "MediaFlow Proxy URL",
            type: "text"
        },
        {
            key: "mediaFlowProxyPassword",
            title: "MediaFlow Proxy Password ", 
            type: "text"
        },
        {
            key: "bothLinks",
            title: "Mostra entrambi i link (Proxy e Direct)",
            type: "checkbox"
        },
        {
            key: "animeunityEnabled",
            title: "Enable AnimeUnity",
            type: "checkbox"
        },
        {
            key: "animesaturnEnabled",
            title: "Enable AnimeSaturn",
            type: "checkbox"
        },
        {
            key: "enableLiveTV",
            title: "Abilita Live TV",
            type: "checkbox"
        },
        {
            key: "mfpProxyUrl",
            title: "MFP Render Proxy (per MPD)",
            type: "text"
        },
        {
            key: "mfpProxyPassword",
            title: "MFP Password",
            type: "text"
        },
        {
            key: "tvProxyUrl",
            title: "TV Proxy (per Vavoo)",
            type: "text"
        }
    ]
};

// Load custom configuration if available
function loadCustomConfig(): Manifest {
    try {
        const configPath = path.join(__dirname, '..', 'addon-config.json');
        
        if (fs.existsSync(configPath)) {
            const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            return {
                ...baseManifest,
                id: customConfig.addonId || baseManifest.id,
                name: customConfig.addonName || baseManifest.name,
                description: customConfig.addonDescription || baseManifest.description,
                version: customConfig.addonVersion || baseManifest.version,
                logo: customConfig.addonLogo || baseManifest.logo,
                icon: customConfig.addonLogo || baseManifest.icon,
                background: baseManifest.background
            };
        }
    } catch (error) {
        console.error('Error loading custom configuration:', error);
    }
    
    return baseManifest;
}

// Funzione per codificare la configurazione in Base64 (senza Buffer)
function encodeConfigToBase64(config: AddonConfig): string {
    const jsonString = JSON.stringify(config);
    // Usa encoding manuale per evitare dipendenze da Buffer
    return btoa(unescape(encodeURIComponent(jsonString)));
}

// Funzione per decodificare la configurazione da Base64 (senza Buffer)
function decodeConfigFromBase64(base64String: string): AddonConfig {
    console.log(`🔧 Attempting to decode Base64 config (length: ${base64String.length})`);
    
    // Prima controlla se è già un JSON valido (non encoded)
    try {
        const directParse = JSON.parse(base64String);
        console.log(`✅ Direct JSON parse successful`);
        return directParse;
    } catch (e) {
        // Non è un JSON diretto, procedi con il Base64
    }
    
    try {
        // Strategia principale: decodifica Base64 e parse JSON
        const jsonString = atob(base64String);
        const parsed = JSON.parse(jsonString);
        console.log(`✅ Base64 decode successful`);
        return parsed;
    } catch (error) {
        console.log(`❌ Base64 decode failed:`, (error as Error).message || error);
        return {};
    }
}

// Polyfill per btoa/atob per Node.js
function btoa(str: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;
    while (i < str.length) {
        const a = str.charCodeAt(i++);
        const b = i < str.length ? str.charCodeAt(i++) : 0;
        const c = i < str.length ? str.charCodeAt(i++) : 0;
        const bitmap = (a << 16) | (b << 8) | c;
        result += chars.charAt((bitmap >> 18) & 63) +
                  chars.charAt((bitmap >> 12) & 63) +
                  (i - 1 < str.length ? chars.charAt((bitmap >> 6) & 63) : '=') +
                  (i - 2 < str.length ? chars.charAt(bitmap & 63) : '=');
    }
    return result;
}

function atob(str: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    str = str.replace(/[^A-Za-z0-9+/]/g, '');
    let result = '';
    let i = 0;
    while (i < str.length) {
        const encoded1 = chars.indexOf(str.charAt(i++));
        const encoded2 = chars.indexOf(str.charAt(i++));
        const encoded3 = chars.indexOf(str.charAt(i++));
        const encoded4 = chars.indexOf(str.charAt(i++));
        const bitmap = (encoded1 << 18) | (encoded2 << 12) | (encoded3 << 6) | encoded4;
        result += String.fromCharCode((bitmap >> 16) & 255);
        if (encoded3 !== 64) result += String.fromCharCode((bitmap >> 8) & 255);
        if (encoded4 !== 64) result += String.fromCharCode(bitmap & 255);
    }
    return result;
}

// Funzione per parsare la configurazione dall'URL (supporta sia JSON che Base64)
function parseConfigFromArgs(args: any): AddonConfig {
    console.log(`🔧 parseConfigFromArgs called with:`, typeof args, args);
    
    const config: AddonConfig = {};
    
    if (typeof args === 'string') {
        // Prima prova con Base64
        try {
            console.log(`🔧 Trying to decode Base64 config: ${args.substring(0, 50)}...`);
            const decoded = decodeConfigFromBase64(args);
            console.log(`🔧 Successfully decoded Base64 config:`, decoded);
            return decoded;
        } catch (base64Error) {
            console.log(`🔧 Base64 decode failed, trying JSON decode...`);
            
            // Fallback: prova con JSON tradizionale
            try {
                console.log(`🔧 Trying to decode JSON config: ${args}`);
                const decoded = decodeURIComponent(args);
                console.log(`🔧 Decoded: ${decoded}`);
                const parsed = JSON.parse(decoded);
                console.log(`🔧 Parsed JSON config:`, parsed);
                return parsed;
            } catch (jsonError) {
                console.log(`🔧 Failed to parse both Base64 and JSON config:`, jsonError);
                return {};
            }
        }
    }
    
    if (typeof args === 'object' && args !== null) {
        console.log(`🔧 Using object config:`, args);
        return args;
    }
    
    console.log(`🔧 Returning empty config`);
    return config;
}

// Funzione per leggere e parsare la playlist M3U generata da vavoom3u.py
function parseM3U(m3uPath: string): { name: string; url: string }[] {
  if (!fs.existsSync(m3uPath)) return [];
  const content = fs.readFileSync(m3uPath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const channels: { name: string; url: string }[] = [];
  let currentName: string | null = null;
  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const match = line.match(/,(.*)$/);
      currentName = match ? match[1].trim().toUpperCase().replace(/\s+/g, '') : null;
    } else if (currentName && line && !line.startsWith('#')) {
      channels.push({ name: currentName, url: line.trim() });
      currentName = null;
    }
  }
  return channels;
}

// Funzione per risolvere un canale Vavoo tramite lo script Python UNIFICATO
function resolveVavooChannelByName(channelName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[Vavoo] Timeout for channel: ${channelName}`);
      resolve(null);
    }, 10000);

    console.log(`[Vavoo] Resolving channel: ${channelName}`);
    
    const options = {
      timeout: 10000,
      env: {
        ...process.env,
        PYTHONPATH: '/Users/eschiano/Library/Python/3.9/lib/python/site-packages'
      }
    };
    
    execFile('python3', [path.join(__dirname, '../vavoo_resolver.py'), channelName], options, (error: Error | null, stdout: string, stderr: string) => {
      clearTimeout(timeout);
      
      if (error) {
        console.error(`[Vavoo] Error for ${channelName}:`, error.message);
        if (stderr) console.error(`[Vavoo] Stderr:`, stderr);
        return resolve(null);
      }
      
      if (!stdout || stdout.trim() === '') {
        console.log(`[Vavoo] No output for ${channelName}`);
        return resolve(null);
      }
      
      const result = stdout.trim();
      console.log(`[Vavoo] Resolved ${channelName} to: ${result}`);
      resolve(result);
    });
  });
}

// Funzione per ottenere il link Vavoo originale (non risolto)
function getVavooOriginalLink(channelName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[Vavoo] Timeout for original link: ${channelName}`);
      resolve(null);
    }, 10000);

    console.log(`[Vavoo] Getting original link for channel: ${channelName}`);
    
    const options = {
      timeout: 10000,
      env: {
        ...process.env,
        PYTHONPATH: '/Users/eschiano/Library/Python/3.9/lib/python/site-packages'
      }
    };
    
    execFile('python3', [path.join(__dirname, '../vavoo_resolver.py'), channelName, '--original-link'], options, (error: Error | null, stdout: string, stderr: string) => {
      clearTimeout(timeout);
      
      if (error) {
        console.error(`[Vavoo] Error getting original link for ${channelName}:`, error.message);
        if (stderr) console.error(`[Vavoo] Stderr:`, stderr);
        return resolve(null);
      }
      
      if (!stdout || stdout.trim() === '') {
        console.log(`[Vavoo] No original link output for ${channelName}`);
        return resolve(null);
      }
      
      const result = stdout.trim();
      console.log(`[Vavoo] Original link for ${channelName}: ${result}`);
      resolve(result);
    });
  });
}

// Carica canali TV e domini da file esterni (per HuggingFace/Docker)
const tvChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
const domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));

// Carica configurazione EPG
const epgConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/epg_config.json'), 'utf-8'));

// Inizializza EPG Manager
let epgManager: EPGManager | null = null;
if (epgConfig.enabled) {
    epgManager = new EPGManager(epgConfig);
    console.log(`📺 EPG Manager inizializzato con URL: ${epgConfig.epgUrl}`);
    console.log(`📺 URL alternativi configurati: ${epgConfig.alternativeUrls?.length || 0}`);
    
    // Avvia aggiornamento EPG in background senza bloccare l'avvio
    setTimeout(() => {
        if (epgManager) {
            epgManager.updateEPG().then(success => {
                if (success) {
                    console.log(`✅ EPG aggiornato con successo in background`);
                } else {
                    console.log(`⚠️ Aggiornamento EPG fallito in background, verrà ritentato al prossimo utilizzo`);
                }
            }).catch(error => {
                console.error(`❌ Errore durante l'aggiornamento EPG in background:`, error);
            });
        }
    }, 1000); // Ritarda di 1 secondo per permettere al server di avviarsi
}

// Funzione per determinare se un canale è in chiaro (da rai1 a rai4k)
function isFreeToAirChannel(channelId: string): boolean {
  // Canali in chiaro da rai1 a rai4k come richiesto
  const freeToAirIds = [
    'rai1', 'rai2', 'rai3', 'rai4', 'rai5', 'raimovie', 'raipremium', 'raigulp', 'raiyoyo', 
    'rainews24', 'raistoria', 'raiscuola', 'raisport', 'rai4k'
  ];
  return freeToAirIds.includes(channelId);
}

// Funzione per determinare la categoria di un canale
function getChannelCategory(channel: any): string {
  // Se il canale ha già una categoria definita, usala
  if (channel.category) {
    return channel.category;
  }
  
  const name = channel.name.toLowerCase();
  const description = channel.description.toLowerCase();
  
  // RAI
  if (name.includes('rai') || description.includes('rai')) {
    return 'rai';
  }
  
  // Mediaset
  if (name.includes('mediaset') || description.includes('mediaset') || 
      name.includes('canale 5') || name.includes('italia') || name.includes('rete 4') ||
      name.includes('iris') || name.includes('focus') || name.includes('cine34') ||
      name.includes('boing') || name.includes('cartoonito') || name.includes('super') ||
      name.includes('tgcom') || name.includes('mediaset extra')) {
    return 'mediaset';
  }
  
  // Sky
  if (name.includes('sky') || description.includes('sky') || 
      name.includes('cinema') || name.includes('sport') || name.includes('uno') ||
      name.includes('serie') || name.includes('atlantic') || name.includes('crime') ||
      name.includes('investigation') || name.includes('documentaries') || name.includes('nature') ||
      name.includes('arte') || name.includes('mtv') || name.includes('comedy') ||
      name.includes('eurosport') || name.includes('nick') || name.includes('cartoon') ||
      name.includes('boomerang') || name.includes('deakids') || name.includes('adventure')) {
    return 'sky';
  }
  
  // Bambini
  if (name.includes('gulp') || name.includes('yoyo') || name.includes('frisbee') ||
      name.includes('k2') || name.includes('boing') || name.includes('cartoonito') ||
      name.includes('super') || name.includes('nick') || name.includes('cartoon') ||
      name.includes('boomerang') || name.includes('deakids')) {
    return 'kids';
  }
  
  // News
  if (name.includes('news') || name.includes('tg') || name.includes('focus') ||
      name.includes('rainews') || name.includes('skytg') || name.includes('tgcom')) {
    return 'news';
  }
  
  // Sport
  if (name.includes('sport') || name.includes('tennis') || name.includes('eurosport') ||
      name.includes('raisport') || name.includes('sportitalia') || name.includes('supertennis')) {
    return 'sport';
  }
  
  // Cinema
  if (name.includes('cinema') || name.includes('movie') || name.includes('warner') ||
      name.includes('giallo') || name.includes('top crime')) {
    return 'movies';
  }
  
  return 'general';
}

// Aggiorna i canali con i link Vavoo dalla M3U
function updateVavooUrlsOnChannels(m3uPath: string): void {
  const m3uChannels = parseM3U(m3uPath);
  for (const c of tvChannels) {
    (c as any).vavooUrl = null;
    for (const vname of (c as any).vavooNames) {
      const found = m3uChannels.find(m => m.name.replace(/\s+/g, '') === vname.replace(/\s+/g, ''));
      if (found) {
        (c as any).vavooUrl = found.url;
        break;
      }
    }
  }
}
// Esegui update all'avvio (puoi anche schedulare periodicamente)
updateVavooUrlsOnChannels(path.join(__dirname, '../vavoo_proxy_playlist.m3u'));

// Proxy base (modifica qui o usa env var)
const PROXY_URL = process.env.MY_PROXY_URL || "https://tuo-proxy-url.com/proxy?url=";

function normalizeProxyUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(config: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    if (config.mediaFlowProxyUrl || config.bothLinks || config.tmdbApiKey) {
        manifest.name;
    }
    const builder = new addonBuilder(manifest);

    // === HANDLER CATALOGO TV ===
    builder.defineCatalogHandler(({ type, id, extra }: { type: string; id: string; extra?: any }) => {
      console.log(`📺 CATALOG REQUEST: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
      if (type === "tv") {
        let filteredChannels = tvChannels;
        
        // Filtra per genere se specificato
        if (extra && extra.genre) {
          const genre = extra.genre;
          console.log(`🔍 Filtering by genre: ${genre}`);
          
          // Mappa i nomi dei generi dal manifest ai nomi delle categorie
          const genreMap: { [key: string]: string } = {
            "RAI": "rai",
            "Mediaset": "mediaset", 
            "Sky": "sky",
            "Bambini": "kids",
            "News": "news",
            "Sport": "sport",
            "Cinema": "movies",
            "Generali": "general"
          };
          
          const targetCategory = genreMap[genre];
          if (targetCategory) {
            filteredChannels = tvChannels.filter((channel: any) => getChannelCategory(channel) === targetCategory);
            console.log(`✅ Filtered to ${filteredChannels.length} channels in category: ${targetCategory}`);
          } else {
            console.log(`⚠️ Unknown genre: ${genre}`);
          }
        } else {
          console.log(`📺 No genre filter, showing all ${tvChannels.length} channels`);
        }
        
        // Aggiungi prefisso tv: agli ID e posterShape landscape
        const tvChannelsWithPrefix = filteredChannels.map((channel: any) => ({
          ...channel,
          id: `tv:${channel.id}`, // Aggiungi prefisso tv:
          posterShape: "landscape" // Imposta forma poster orizzontale per canali TV
        }));
        console.log(`✅ Returning ${tvChannelsWithPrefix.length} TV channels for catalog ${id} with prefixed IDs`);
        return Promise.resolve({ metas: tvChannelsWithPrefix });
      }
      console.log(`❌ No catalog found for type=${type}, id=${id}`);
      return Promise.resolve({ metas: [] });
    });

    // === HANDLER META TV ===
    builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
      console.log(`📺 META REQUEST: type=${type}, id=${id}`);
      if (type === "tv") {
        // CORREZIONE: Rimuovi prefisso tv: per trovare il canale
        const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
        const channel = tvChannels.find((c: any) => c.id === cleanId);
        if (channel) {
          console.log(`✅ Found meta for channel: ${channel.name} (original id: ${cleanId})`);
          
          // Prepara i metadati base
          const metaWithPrefix = {
            ...channel,
            id: `tv:${channel.id}`,
            posterShape: "landscape" // Imposta forma poster orizzontale per canali TV
          };

          // Aggiungi informazioni EPG se disponibili
          if (epgManager) {
            try {
              console.log(`🔍 EPG DEBUG per ${channel.name}:`);
              console.log(`  - epgChannelIds:`, (channel as any).epgChannelIds);
              
              // Usa prima gli epgChannelIds dal canale, poi fallback al nome
              const epgChannelIds = (channel as any).epgChannelIds;
              const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
              
              console.log(`  - epgChannelId trovato:`, epgChannelId);
              
              if (epgChannelId) {
                console.log(`📺 EPG Channel ID trovato per ${channel.name}: ${epgChannelId}`);
                
                // Ottieni programma corrente e prossimo
                const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                const nextProgram = await epgManager.getNextProgram(epgChannelId);
                
                console.log(`  - currentProgram:`, currentProgram ? currentProgram.title : 'null');
                console.log(`  - nextProgram:`, nextProgram ? nextProgram.title : 'null');
                
                if (currentProgram || nextProgram) {
                  let epgDescription = channel.description || '';
                  
                  if (currentProgram) {
                    const startTime = epgManager.formatTime(currentProgram.start);
                    const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                    epgDescription += `\n\n🔴 IN ONDA ORA (${startTime}${endTime ? `-${endTime}` : ''}): ${currentProgram.title}`;
                    if (currentProgram.description) {
                      epgDescription += `\n${currentProgram.description}`;
                    }
                  }
                  
                  if (nextProgram) {
                    const nextStartTime = epgManager.formatTime(nextProgram.start);
                    const nextEndTime = nextProgram.stop ? epgManager.formatTime(nextProgram.stop) : '';
                    epgDescription += `\n\n⏭️ A SEGUIRE (${nextStartTime}${nextEndTime ? `-${nextEndTime}` : ''}): ${nextProgram.title}`;
                    if (nextProgram.description) {
                      epgDescription += `\n${nextProgram.description}`;
                    }
                  }
                  
                  metaWithPrefix.description = epgDescription;
                  console.log(`✅ EPG aggiunto alla descrizione per ${channel.name}`);
                } else {
                  console.log(`⚠️ Nessun programma trovato per ${channel.name}`);
                }
              } else {
                console.log(`⚠️ Nessun EPG Channel ID trovato per ${channel.name}${epgChannelIds ? ` (IDs cercati: ${epgChannelIds.join(', ')})` : ''}`);
              }
            } catch (epgError) {
              console.error(`❌ Errore EPG per ${channel.name}:`, epgError);
            }
          } else {
            console.log(`⚠️ EPG Manager non disponibile per ${channel.name}`);
          }
          
          return Promise.resolve({ meta: metaWithPrefix });
        } else {
          console.log(`❌ No meta found for channel ID: ${id} (cleaned: ${cleanId})`);
        }
      }
      return Promise.resolve({ meta: null });
    });

    // === HANDLER UNICO STREAM ===
    builder.defineStreamHandler(async ({ type, id }: { type: string; id: string }) => {        // --- TV LOGIC ---
        if (type === "tv") {
          console.log(`========= TV STREAM REQUEST =========`);
          console.log(`Channel ID: ${id}`);
          console.log(`Config received:`, JSON.stringify(config, null, 2));
          
          // CORREZIONE: Rimuovi prefisso tv: per trovare il canale
          const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
          console.log(`Clean ID for lookup: ${cleanId}`);
          
          const channel = tvChannels.find((c: any) => c.id === cleanId);
          if (!channel) {
            console.log(`❌ Channel ${id} (cleaned: ${cleanId}) not found in tvChannels`);
            return { streams: [] };
          }
          
          console.log(`✅ Found channel:`, JSON.stringify(channel, null, 2));
          
          const streams: { url: string; title: string }[] = [];
          const mfpUrl = config.mfpProxyUrl ? normalizeProxyUrl(config.mfpProxyUrl) : 
                       (config.mediaFlowProxyUrl ? normalizeProxyUrl(config.mediaFlowProxyUrl) : '');
          const mfpPsw = config.mfpProxyPassword || config.mediaFlowProxyPassword || '';
          const tvProxyUrl = config.tvProxyUrl ? normalizeProxyUrl(config.tvProxyUrl) : '';
          const staticUrl = (channel as any).staticUrl;

          console.log(`🔧 Configuration:`);
          console.log(`  - MFP URL: ${mfpUrl || 'NOT SET'}`);
          console.log(`  - MFP Password: ${mfpPsw ? 'SET' : 'NOT SET'}`);
          console.log(`  - TV Proxy URL: ${tvProxyUrl || 'NOT SET'}`);
          console.log(`  - Static URL: ${staticUrl || 'NOT SET'}`);

          // Controlla se il canale è in chiaro (da rai1 a rai4k)
          const isFreeToAir = isFreeToAirChannel(cleanId);
          console.log(`🔧 Channel ${cleanId} is free to air: ${isFreeToAir}`);

          // 1. Stream via staticUrl (MPD o HLS)
          if (staticUrl) {
            if (isFreeToAir) {
              // Per canali in chiaro, usa direttamente il staticUrl senza MFP
              streams.push({
                url: staticUrl,
                title: `${(channel as any).name} (MPD)`
              });
              console.log(`✅ Added direct staticUrl for free-to-air channel: ${staticUrl}`);
            } else if (mfpUrl && mfpPsw) {
              // Per canali non in chiaro, usa MFP proxy
              let proxyUrl: string;
              if (staticUrl.includes('.mpd')) {
                // Per file MPD usiamo il proxy MPD
                proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl}`;
              } else {
                // Per altri stream usiamo il proxy stream normale
                proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl}`;
              }
              streams.push({
                url: proxyUrl,
                title: `${(channel as any).name} (MPD)`
              });
              console.log(`✅ Added MFP proxy stream: ${proxyUrl}`);
            } else {
              console.log(`❌ Cannot create stream: staticUrl=${!!staticUrl}, mfpUrl=${!!mfpUrl}, mfpPsw=${!!mfpPsw}`);
            }
          } else {
            console.log(`❌ No staticUrl available for channel ${cleanId}`);
          }

          // 2. Stream via staticUrl2 (seconda URL statica)
          const staticUrl2 = (channel as any).staticUrl2;
          if (staticUrl2) {
            if (isFreeToAir) {
              // Per canali in chiaro, usa direttamente il staticUrl2 senza MFP
              streams.push({
                url: staticUrl2,
                title: `${(channel as any).name} (MPD)`
              });
              console.log(`✅ Added direct staticUrl2 for free-to-air channel: ${staticUrl2}`);
            } else if (mfpUrl && mfpPsw) {
              // Per canali non in chiaro, usa MFP proxy
              let proxyUrl: string;
              if (staticUrl2.includes('.mpd')) {
                // Per file MPD usiamo il proxy MPD
                proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl2}`;
              } else {
                // Per altri stream usiamo il proxy stream normale
                proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl2}`;
              }
              streams.push({
                url: proxyUrl,
                title: `${(channel as any).name} (MPD)`
              });
              console.log(`✅ Added MFP proxy stream for staticUrl2: ${proxyUrl}`);
            } else {
              console.log(`❌ Cannot create stream for staticUrl2: staticUrl2=${!!staticUrl2}, mfpUrl=${!!mfpUrl}, mfpPsw=${!!mfpPsw}`);
            }
          }

          // 3. Stream Vavoo dinamico (ottieni link originale per proxy) - SOLO per canali NON in chiaro
          if (!isFreeToAir && tvProxyUrl && (channel as any).vavooNames && Array.isArray((channel as any).vavooNames)) {
            try {
              console.log(`[TV] Trying Vavoo original link for ${id} (non-free-to-air channel)`);
              console.log(`[TV] Vavoo names available:`, (channel as any).vavooNames);
              console.log(`[TV] TV Proxy URL:`, tvProxyUrl);
              
              // Prova tutti i nomi Vavoo per questo canale
              let vavooResolved = false;
              for (const vavooName of (channel as any).vavooNames) {
                if (vavooResolved) break; // Esce al primo successo
                
                console.log(`[TV] Trying to get Vavoo original link: ${vavooName}`);
                try {
                  const originalLink = await getVavooOriginalLink(vavooName);
                  console.log(`[TV] Vavoo original link result for ${vavooName}:`, originalLink);
                  
                  if (originalLink && originalLink !== 'NOT_FOUND' && originalLink !== 'NO_URL' && originalLink !== 'RESOLVE_FAIL' && originalLink !== 'ERROR') {
                    // Passa il link Vavoo originale al proxy (NON quello risolto)
                    const vavooUrl = `${tvProxyUrl}/proxy/m3u?url=${encodeURIComponent(originalLink)}`;
                    streams.push({
                      url: vavooUrl,
                      title: `${(channel as any).name} (V)`
                    });
                    console.log(`[TV] ✅ Added Vavoo stream for ${id} with name ${vavooName}: ${vavooUrl}`);
                    vavooResolved = true;
                  } else {
                    console.log(`[TV] ❌ Failed to get Vavoo original link: ${vavooName} (result: ${originalLink})`);
                  }
                } catch (vavooError) {
                  console.error(`[TV] ❌ Error resolving Vavoo name ${vavooName}:`, vavooError);
                }
              }
              
              if (!vavooResolved) {
                console.log(`[TV] ❌ No Vavoo streams found for ${id}`);
              }
            } catch (error) {
              console.error(`[TV] ❌ General error resolving Vavoo for ${id}:`, error);
            }
          } else if (isFreeToAir) {
            console.log(`[TV] ⏭️ Skipping Vavoo for free-to-air channel ${id} - using only direct streams`);
          } else {
            console.log(`[TV] ❌ Skipping Vavoo for ${id}: tvProxyUrl=${!!tvProxyUrl}, vavooNames=${(channel as any).vavooNames}`);
          }

          console.log(`🔍 Total streams generated: ${streams.length}`);
          streams.forEach((stream, index) => {
            console.log(`  Stream ${index + 1}: ${stream.title} -> ${stream.url.substring(0, 100)}...`);
          });
          
          // Se non ci sono stream, aggiungi un messaggio informativo
          if (streams.length === 0) {
            console.warn(`❌ No streams available for channel ${id} - adding fallback`);
            streams.push({
              url: 'data:text/plain;base64,Tm8gc3RyZWFtcyBhdmFpbGFibGU=', // "No streams available"
              title: `${(channel as any).name} - Nessun stream disponibile`
            });
          }
          
          console.log(`========= END TV STREAM REQUEST =========`);
          return { streams };
        }
      // --- ANIMEUNITY/ANIMESATURN LOGIC ---
      try {
        const allStreams: Stream[] = [];
        // Gestione AnimeUnity per ID Kitsu o MAL con fallback variabile ambiente
        const animeUnityEnabled = (config.animeunityEnabled === 'on') || 
                                (process.env.ANIMEUNITY_ENABLED?.toLowerCase() === 'true');
        // Gestione AnimeSaturn per ID Kitsu o MAL con fallback variabile ambiente
        const animeSaturnEnabled = (config.animesaturnEnabled === 'on') || 
                                (process.env.ANIMESATURN_ENABLED?.toLowerCase() === 'true');
        // Gestione parallela AnimeUnity e AnimeSaturn per ID Kitsu, MAL, IMDB, TMDB
        if ((id.startsWith('kitsu:') || id.startsWith('mal:') || id.startsWith('tt') || id.startsWith('tmdb:')) && (animeUnityEnabled || animeSaturnEnabled)) {
            const bothLinkValue = config.bothLinks === 'on';
            const animeUnityConfig: AnimeUnityConfig = {
                enabled: animeUnityEnabled,
                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                bothLink: bothLinkValue,
                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || ''
            };
            const animeSaturnConfig = {
                enabled: animeSaturnEnabled,
                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                bothLink: bothLinkValue,
                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || ''
            };
            let animeUnityStreams: Stream[] = [];
            let animeSaturnStreams: Stream[] = [];
            // Parsing stagione/episodio per IMDB/TMDB
            let seasonNumber: number | null = null;
            let episodeNumber: number | null = null;
            let isMovie = false;
            if (id.startsWith('tt') || id.startsWith('tmdb:')) {
                // Esempio: tt1234567:1:2 oppure tmdb:12345:1:2
                const parts = id.split(':');
                if (parts.length === 1) {
                    isMovie = true;
                } else if (parts.length === 2) {
                    episodeNumber = parseInt(parts[1]);
                } else if (parts.length === 3) {
                    seasonNumber = parseInt(parts[1]);
                    episodeNumber = parseInt(parts[2]);
                }
            }
            // AnimeUnity
            if (animeUnityEnabled) {
                try {
                    const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                    let animeUnityResult;
                    if (id.startsWith('kitsu:')) {
                        console.log(`[AnimeUnity] Processing Kitsu ID: ${id}`);
                        animeUnityResult = await animeUnityProvider.handleKitsuRequest(id);
                    } else if (id.startsWith('mal:')) {
                        console.log(`[AnimeUnity] Processing MAL ID: ${id}`);
                        animeUnityResult = await animeUnityProvider.handleMalRequest(id);
                    } else if (id.startsWith('tt')) {
                        console.log(`[AnimeUnity] Processing IMDB ID: ${id}`);
                        animeUnityResult = await animeUnityProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                    } else if (id.startsWith('tmdb:')) {
                        console.log(`[AnimeUnity] Processing TMDB ID: ${id}`);
                        animeUnityResult = await animeUnityProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                    }
                    if (animeUnityResult && animeUnityResult.streams) {
                        animeUnityStreams = animeUnityResult.streams;
                        for (const s of animeUnityResult.streams) {
                            allStreams.push({ ...s, name: 'StreamViX AU' });
                        }
                    }
                } catch (error) {
                    console.error('🚨 AnimeUnity error:', error);
                }
            }
            // AnimeSaturn
            if (animeSaturnEnabled) {
                try {
                    const { AnimeSaturnProvider } = await import('./providers/animesaturn-provider');
                    const animeSaturnProvider = new AnimeSaturnProvider(animeSaturnConfig);
                    let animeSaturnResult;
                    if (id.startsWith('kitsu:')) {
                        console.log(`[AnimeSaturn] Processing Kitsu ID: ${id}`);
                        animeSaturnResult = await animeSaturnProvider.handleKitsuRequest(id);
                    } else if (id.startsWith('mal:')) {
                        console.log(`[AnimeSaturn] Processing MAL ID: ${id}`);
                        animeSaturnResult = await animeSaturnProvider.handleMalRequest(id);
                    } else if (id.startsWith('tt')) {
                        console.log(`[AnimeSaturn] Processing IMDB ID: ${id}`);
                        animeSaturnResult = await animeSaturnProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                    } else if (id.startsWith('tmdb:')) {
                        console.log(`[AnimeSaturn] Processing TMDB ID: ${id}`);
                        animeSaturnResult = await animeSaturnProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                    }
                    if (animeSaturnResult && animeSaturnResult.streams) {
                        animeSaturnStreams = animeSaturnResult.streams;
                        for (const s of animeSaturnResult.streams) {
                            allStreams.push({ ...s, name: 'StreamViX AS' });
                        }
                    }
                } catch (error) {
                    console.error('[AnimeSaturn] Errore:', error);
                }
            }
        }
        // Mantieni logica VixSrc per tutti gli altri ID
        if (!id.startsWith('kitsu:') && !id.startsWith('mal:')) {
            console.log(`📺 Processing non-Kitsu or MAL ID with VixSrc: ${id}`);
            let bothLinkValue: boolean;
            if (config.bothLinks !== undefined) {
                bothLinkValue = config.bothLinks === 'on';
            } else {
                bothLinkValue = process.env.BOTHLINK?.toLowerCase() === 'true';
            }
            const finalConfig: ExtractorConfig = {
                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY,
                mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                bothLink: bothLinkValue
            };
            const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);
            if (res) {
                for (const st of res) {
                    if (st.streamUrl == null) continue;
                    console.log(`Adding stream with title: "${st.name}"`);
                    allStreams.push({
                        title: st.name,
                        name: 'StreamViX Vx',
                        url: st.streamUrl,
                        behaviorHints: {
                            notWebReady: true,
                            headers: { "Referer": st.referer },
                        },
                    });
                }
                console.log(`📺 VixSrc streams found: ${res.length}`);
            }
        }
        console.log(`✅ Total streams returned: ${allStreams.length}`);
        return { streams: allStreams };
      } catch (error) {
        console.error('Stream extraction failed:', error);
        return { streams: [] };
      }
    });

    return builder;
}

// === FUNZIONE STUB PER RISOLUZIONE DINAMICA ===
async function resolveDynamicChannel(id: string): Promise<string | null> {
  // TODO: integra il tuo script qui
  // Esempio: return await fetch("http://localhost:5000/resolve?id=" + id).then(r => r.text());
  return null;
}

// Server Express
const app = express();

// Serve static files from public directories
app.use('/public', express.static(path.join(__dirname, '../public')));
app.use('/src/public', express.static(path.join(__dirname, 'public')));

// CORS Headers per tutti i requests
app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

// MIDDLEWARE GLOBALE PER LOGGING DI TUTTE LE RICHIESTE
app.use((req: Request, res: Response, next: NextFunction) => {
    const timestamp = new Date().toISOString();
    console.log(`\n🌐 [${timestamp}] INCOMING REQUEST:`);
    console.log(`   Method: ${req.method}`);
    console.log(`   URL: ${req.url}`);
    console.log(`   Path: ${req.path}`);
    console.log(`   Params:`, req.params);
    console.log(`   Query:`, req.query);
    console.log(`   Headers:`, JSON.stringify(req.headers, null, 2));
    console.log(`   User-Agent: ${req.get('User-Agent') || 'N/A'}`);
    console.log(`   Referer: ${req.get('Referer') || 'N/A'}`);
    console.log(`────────────────────────────────────────────────────────────\n`);
    
    // Log anche la risposta
    const originalSend = res.send;
    res.send = function(data: any) {
        console.log(`📤 [${timestamp}] RESPONSE for ${req.method} ${req.url}:`);
        console.log(`   Status: ${res.statusCode}`);
        if (typeof data === 'string' && data.length < 1000) {
            console.log(`   Body: ${data}`);
        } else {
            console.log(`   Body: [${typeof data}] ${JSON.stringify(data).substring(0, 200)}...`);
        }
        console.log(`════════════════════════════════════════════════════════════\n`);
        return originalSend.call(this, data);
    };
    
    next();
});

// Gestione preflight CORS OPTIONS
app.options('*', (req: Request, res: Response) => {
    console.log(`🔄 OPTIONS PREFLIGHT request for: ${req.url}`);
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Max-Age', '86400');
    res.sendStatus(200);
});

app.use('/public', express.static(path.join(__dirname, 'public')));

// Landing page
app.get('/', async (_: Request, res: Response) => {
    const manifest = loadCustomConfig();
    
    // Esempio di configurazione per i test Base64
    const exampleConfig: AddonConfig = {
        tmdbApiKey: "",
        mediaFlowProxyUrl: "",
        mediaFlowProxyPassword: "",
        mfpProxyUrl: "https://mfpi.pizzapi.uk/",
        mfpProxyPassword: "mfp",
        tvProxyUrl: "https://tvproxy.pizzapi.uk/"
    };
    
    const base64Config = encodeConfigToBase64(exampleConfig);
    console.log(`🔧 Generated Base64 config for testing: ${base64Config.substring(0, 50)}...`);
    console.log(`🔧 Example URL: /${base64Config}/manifest.json`);
    
    // Aggiungi informazioni EPG se disponibili
    let epgInfo = null;
    if (epgManager) {
        try {
            epgInfo = epgManager.getStats();
        } catch (error) {
            console.error('Error getting EPG stats:', error);
        }
    }
    
    const landingHTML = landingTemplate(manifest, epgInfo);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// Manifest endpoint senza configurazione (per test)
app.get('/manifest.json', (req: Request, res: Response) => {
    console.log(`📋 SIMPLE MANIFEST REQUEST (no config)`);
    const manifest = loadCustomConfig();
    
    // Add absolute URLs for icon and background
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const manifestWithAbsoluteUrls = {
        ...manifest,
        icon: `${baseUrl}/public/icon.png`,
        background: `${baseUrl}/public/backround.png`
    };
    
    console.log(`📋 SIMPLE MANIFEST DETAILS:`);
    console.log(`   - ID: ${manifest.id}`);
    console.log(`   - Icon: ${manifestWithAbsoluteUrls.icon}`);
    console.log(`   - Background: ${manifestWithAbsoluteUrls.background}`);
    console.log(`   - Types: ${JSON.stringify(manifest.types)}`);
    console.log(`   - ID Prefixes: ${JSON.stringify(manifest.idPrefixes)}`);
    console.log(`   - Resources: ${JSON.stringify(manifest.resources)}`);
    console.log(`   - Catalogs: ${JSON.stringify(manifest.catalogs)}`);
    res.json(manifestWithAbsoluteUrls);
});

// Addon routes with configuration - PATH PARAMETER APPROACH (like MammaMia)
app.get('/:config/manifest.json', (req: Request, res: Response) => {
    const configStr = req.params.config;
    const config = parseConfigFromArgs(configStr);
    console.log(`📋 MANIFEST REQUEST with config:`, config);
    const builder = createBuilder(config);
    const manifest = builder.getInterface().manifest;
    
    // Add absolute URLs for icon and background
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const manifestWithAbsoluteUrls = {
        ...manifest,
        icon: `${baseUrl}/public/icon.png`,
        background: `${baseUrl}/public/backround.png`
    };
    
    console.log(`📋 MANIFEST RESPONSE DETAILS:`);
    console.log(`   - ID: ${manifest.id}`);
    console.log(`   - Icon: ${manifestWithAbsoluteUrls.icon}`);
    console.log(`   - Background: ${manifestWithAbsoluteUrls.background}`);
    console.log(`   - Types: ${JSON.stringify(manifest.types)}`);
    console.log(`   - ID Prefixes: ${JSON.stringify(manifest.idPrefixes)}`);
    console.log(`   - Resources: ${JSON.stringify(manifest.resources)}`);
    console.log(`   - Catalogs: ${JSON.stringify(manifest.catalogs)}`);
    
    res.json(manifestWithAbsoluteUrls);
});

app.get('/:config/catalog/:type/:id.json', (req: Request, res: Response) => {
    const configStr = req.params.config;
    const type = req.params.type;
    const id = req.params.id;
    const genre = req.query.genre as string; // Estrai il genere dai query parameters
    const config = parseConfigFromArgs(configStr);
    
    console.log(`📖 CATALOG REQUEST: type=${type}, id=${id}, genre=${genre}, config parsed:`, !!config);
    
    // Chiamata diretta all'handler senza usare .get()
    if (type === "tv") {
        let filteredChannels = tvChannels;
        
        // Filtra per genere se specificato
        if (genre) {
            console.log(`🔍 Filtering by genre: ${genre}`);
            
            // Mappa i nomi dei generi dal manifest ai nomi delle categorie
            const genreMap: { [key: string]: string } = {
                "RAI": "rai",
                "Mediaset": "mediaset", 
                "Sky": "sky",
                "Bambini": "kids",
                "News": "news",
                "Sport": "sport",
                "Cinema": "movies",
                "Generali": "general"
            };
            
            const targetCategory = genreMap[genre];
            if (targetCategory) {
                filteredChannels = tvChannels.filter((channel: any) => getChannelCategory(channel) === targetCategory);
                console.log(`✅ Filtered to ${filteredChannels.length} channels in category: ${targetCategory}`);
            } else {
                console.log(`⚠️ Unknown genre: ${genre}`);
            }
        } else {
            console.log(`📺 No genre filter, showing all ${tvChannels.length} channels`);
        }
        
        // Aggiungi prefisso tv: agli ID e posterShape landscape
        const tvChannelsWithPrefix = filteredChannels.map((channel: any) => ({
            ...channel,
            id: `tv:${channel.id}`, // Aggiungi prefisso tv:
            posterShape: "landscape" // Imposta forma poster orizzontale per canali TV
        }));
        console.log(`✅ Returning ${tvChannelsWithPrefix.length} TV channels for catalog ${id} with prefixed IDs`);
        res.json({ metas: tvChannelsWithPrefix });
    } else {
        console.log(`❌ No catalog found for type=${type}, id=${id}`);
        res.status(404).json({ error: 'Not found' });
    }
});

app.get('/:config/meta/:type/:id.json', async (req: Request, res: Response) => {
    const configStr = req.params.config;
    const type = req.params.type;
    const id = req.params.id;
    const config = parseConfigFromArgs(configStr);
    
    console.log(`📺 META REQUEST: type=${type}, id=${id}, config parsed:`, !!config);
    
    // Usa la logica del meta handler direttamente
    if (type === "tv") {
        // CORREZIONE: Rimuovi prefisso tv: per trovare il canale
        const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
        console.log(`Clean ID for lookup: ${cleanId}`);
        
        const channel = tvChannels.find((c: any) => c.id === cleanId);
        if (channel) {
            console.log(`✅ Found meta for channel: ${channel.name} (original id: ${cleanId})`);
            
            // Prepara i metadati base
            const metaWithPrefix = {
                ...channel,
                id: `tv:${channel.id}`,
                posterShape: "landscape" // Imposta forma poster orizzontale per canali TV
            };

            // Aggiungi informazioni EPG se disponibili
            if (epgManager) {
                try {
                    console.log(`🔍 EPG DEBUG per ${channel.name}:`);
                    console.log(`  - epgChannelIds:`, (channel as any).epgChannelIds);
                    
                    // Usa prima gli epgChannelIds dal canale, poi fallback al nome
                    const epgChannelIds = (channel as any).epgChannelIds;
                    const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                    
                    console.log(`  - epgChannelId trovato:`, epgChannelId);
                    
                    if (epgChannelId) {
                        console.log(`📺 EPG Channel ID trovato per ${channel.name}: ${epgChannelId}`);
                        
                        // Ottieni programma corrente e prossimo
                        const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                        const nextProgram = await epgManager.getNextProgram(epgChannelId);
                        
                        console.log(`  - currentProgram:`, currentProgram ? currentProgram.title : 'null');
                        console.log(`  - nextProgram:`, nextProgram ? nextProgram.title : 'null');
                        
                        if (currentProgram || nextProgram) {
                            let epgDescription = channel.description || '';
                            
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start);
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                                epgDescription += `\n\n🔴 IN ONDA ORA (${startTime}${endTime ? `-${endTime}` : ''}): ${currentProgram.title}`;
                                if (currentProgram.description) {
                                    epgDescription += `\n${currentProgram.description}`;
                                }
                            }
                            
                            if (nextProgram) {
                                const nextStartTime = epgManager.formatTime(nextProgram.start);
                                const nextEndTime = nextProgram.stop ? epgManager.formatTime(nextProgram.stop) : '';
                                epgDescription += `\n\n⏭️ A SEGUIRE (${nextStartTime}${nextEndTime ? `-${nextEndTime}` : ''}): ${nextProgram.title}`;
                                if (nextProgram.description) {
                                    epgDescription += `\n${nextProgram.description}`;
                                }
                            }
                            
                            metaWithPrefix.description = epgDescription;
                            console.log(`✅ EPG aggiunto alla descrizione per ${channel.name}`);
                        } else {
                            console.log(`⚠️ Nessun programma trovato per ${channel.name}`);
                        }
                    } else {
                        console.log(`⚠️ Nessun EPG Channel ID trovato per ${channel.name}${epgChannelIds ? ` (IDs cercati: ${epgChannelIds.join(', ')})` : ''}`);
                    }
                } catch (epgError) {
                    console.error(`❌ Errore EPG per ${channel.name}:`, epgError);
                }
            } else {
                console.log(`⚠️ EPG Manager non disponibile per ${channel.name}`);
            }
            
            res.json({ meta: metaWithPrefix });
        } else {
            console.log(`❌ No meta found for channel ID: ${id} (cleaned: ${cleanId})`);
            res.status(404).json({ error: 'Not found' });
        }
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// Aggiungiamo anche l'endpoint specifico per TV come MammaMia
app.get('/:config/meta/tv/:id.json', (req: Request, res: Response) => {
    const configStr = req.params.config;
    const id = req.params.id;
    const config = parseConfigFromArgs(configStr);
    
    console.log(`📺 META TV REQUEST: id=${id}, config parsed:`, !!config);
    
    // CORREZIONE: Rimuovi prefisso tv: per trovare il canale
    const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
    console.log(`Clean ID for lookup: ${cleanId}`);
    
    const channel = tvChannels.find((c: any) => c.id === cleanId);
    if (channel) {
        console.log(`✅ Found meta for TV channel: ${channel.name} (original id: ${cleanId})`);
        // Mantieni l'ID originale con prefisso nella risposta
        const metaWithPrefix = {
            ...channel,
            id: `tv:${channel.id}`,
            posterShape: "landscape" // Imposta forma poster orizzontale per canali TV
        };
        res.json({ meta: metaWithPrefix });
    } else {
        console.log(`❌ No meta found for TV channel ID: ${id} (cleaned: ${cleanId})`);
        res.status(404).json({ error: 'Channel not found' });
    }
});

app.get('/:config/stream/:type/:id.json', async (req: Request, res: Response) => {
    const configStr = req.params.config;
    const type = req.params.type;
    const id = req.params.id;
    const config = parseConfigFromArgs(configStr);
    
    console.log(`🎬 STREAM REQUEST: type=${type}, id=${id}, config parsed:`, !!config);
    
    // Chiamata diretta alla logica di stream
    if (type === "tv") {
        console.log(`========= TV STREAM REQUEST (GENERAL ENDPOINT) =========`);
        console.log(`Channel ID: ${id}`);
        console.log(`Config received:`, JSON.stringify(config, null, 2));
        
        // CORREZIONE: Rimuovi prefisso tv: per trovare il canale
        const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
        console.log(`Clean ID for lookup: ${cleanId}`);
        
        const channel = tvChannels.find((c: any) => c.id === cleanId);
        if (!channel) {
            console.log(`❌ Channel ${id} (cleaned: ${cleanId}) not found in tvChannels`);
            res.status(404).json({ error: 'Channel not found' });
            return;
        }
        
        console.log(`✅ Found channel:`, JSON.stringify(channel, null, 2));
        
        const streams: { url: string; title: string }[] = [];
        const mfpUrl = config.mfpProxyUrl ? normalizeProxyUrl(config.mfpProxyUrl) : 
                     (config.mediaFlowProxyUrl ? normalizeProxyUrl(config.mediaFlowProxyUrl) : '');
        const mfpPsw = config.mfpProxyPassword || config.mediaFlowProxyPassword || '';
        const tvProxyUrl = config.tvProxyUrl ? normalizeProxyUrl(config.tvProxyUrl) : '';
        const staticUrl = (channel as any).staticUrl;

        console.log(`🔧 Configuration:`);
        console.log(`  - MFP URL: ${mfpUrl || 'NOT SET'}`);
        console.log(`  - MFP Password: ${mfpPsw ? 'SET' : 'NOT SET'}`);
        console.log(`  - TV Proxy URL: ${tvProxyUrl || 'NOT SET'}`);
        console.log(`  - Static URL: ${staticUrl || 'NOT SET'}`);

        // Controlla se il canale è in chiaro (da rai1 a rai4k)
        const isFreeToAir = isFreeToAirChannel(cleanId);
        console.log(`🔧 Channel ${cleanId} is free to air: ${isFreeToAir}`);

        // 1. Stream via staticUrl (MPD o HLS)
        if (staticUrl) {
          if (isFreeToAir) {
            // Per canali in chiaro, usa direttamente il staticUrl senza MFP
            streams.push({
              url: staticUrl,
              title: `${(channel as any).name} (MPD)`
            });
            console.log(`✅ Added direct staticUrl for free-to-air channel: ${staticUrl}`);
          } else if (mfpUrl && mfpPsw) {
            // Per canali non in chiaro, usa MFP proxy
            let proxyUrl: string;
            if (staticUrl.includes('.mpd')) {
              // Per file MPD usiamo il proxy MPD
              proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl}`;
            } else {
              // Per altri stream usiamo il proxy stream normale
              proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl}`;
            }
            streams.push({
              url: proxyUrl,
              title: `${(channel as any).name} (MPD)`
            });
            console.log(`✅ Added MFP proxy stream: ${proxyUrl}`);
          } else {
            console.log(`❌ Cannot create stream: staticUrl=${!!staticUrl}, mfpUrl=${!!mfpUrl}, mfpPsw=${!!mfpPsw}`);
          }
        } else {
          console.log(`❌ No staticUrl available for channel ${cleanId}`);
        }

        // 2. Stream via staticUrl2 (seconda URL statica)
        const staticUrl2 = (channel as any).staticUrl2;
        if (staticUrl2) {
          if (isFreeToAir) {
            // Per canali in chiaro, usa direttamente il staticUrl2 senza MFP
            streams.push({
              url: staticUrl2,
              title: `${(channel as any).name} (MPD)`
            });
            console.log(`✅ Added direct staticUrl2 for free-to-air channel: ${staticUrl2}`);
          } else if (mfpUrl && mfpPsw) {
            // Per canali non in chiaro, usa MFP proxy
            let proxyUrl: string;
            if (staticUrl2.includes('.mpd')) {
              // Per file MPD usiamo il proxy MPD
              proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl2}`;
            } else {
              // Per altri stream usiamo il proxy stream normale
              proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl2}`;
            }
            streams.push({
              url: proxyUrl,
              title: `${(channel as any).name} (MPD)`
            });
            console.log(`✅ Added MFP proxy stream for staticUrl2: ${proxyUrl}`);
          } else {
            console.log(`❌ Cannot create stream for staticUrl2: staticUrl2=${!!staticUrl2}, mfpUrl=${!!mfpUrl}, mfpPsw=${!!mfpPsw}`);
          }
        }

        // 3. Stream Vavoo dinamico (ottieni link originale per proxy) - SOLO per canali NON in chiaro
        if (!isFreeToAir && tvProxyUrl && (channel as any).vavooNames && Array.isArray((channel as any).vavooNames)) {
          try {
            console.log(`[TV] Trying Vavoo original link for ${id} (non-free-to-air channel)`);
            console.log(`[TV] Vavoo names available:`, (channel as any).vavooNames);
            console.log(`[TV] TV Proxy URL:`, tvProxyUrl);
            
            // Prova tutti i nomi Vavoo per questo canale
            let vavooResolved = false;
            for (const vavooName of (channel as any).vavooNames) {
              if (vavooResolved) break; // Esce al primo successo
              
              console.log(`[TV] Trying to get Vavoo original link: ${vavooName}`);
              try {
                const originalLink = await getVavooOriginalLink(vavooName);
                console.log(`[TV] Vavoo original link result for ${vavooName}:`, originalLink);
                
                if (originalLink && originalLink !== 'NOT_FOUND' && originalLink !== 'NO_URL' && originalLink !== 'RESOLVE_FAIL' && originalLink !== 'ERROR') {
                  // Passa il link Vavoo originale al proxy (NON quello risolto)
                  const vavooUrl = `${tvProxyUrl}/proxy/m3u?url=${encodeURIComponent(originalLink)}`;
                  streams.push({
                    url: vavooUrl,
                    title: `${(channel as any).name} (V)`
                  });
                  console.log(`[TV] ✅ Added Vavoo stream for ${id} with name ${vavooName}: ${vavooUrl}`);
                  vavooResolved = true;
                } else {
                  console.log(`[TV] ❌ Failed to get Vavoo original link: ${vavooName} (result: ${originalLink})`);
                }
              } catch (vavooError) {
                console.error(`[TV] ❌ Error resolving Vavoo name ${vavooName}:`, vavooError);
              }
            }
            
            if (!vavooResolved) {
              console.log(`[TV] ❌ No Vavoo streams found for ${id}`);
            }
          } catch (error) {
            console.error(`[TV] ❌ General error resolving Vavoo for ${id}:`, error);
          }
        } else if (isFreeToAir) {
          console.log(`[TV] ⏭️ Skipping Vavoo for free-to-air channel ${id} - using only direct streams`);
        } else {
          console.log(`[TV] ❌ Skipping Vavoo for ${id}: tvProxyUrl=${!!tvProxyUrl}, vavooNames=${(channel as any).vavooNames}`);
        }

          console.log(`🔍 Total streams generated: ${streams.length}`);
          streams.forEach((stream, index) => {
            console.log(`  Stream ${index + 1}: ${stream.title} -> ${stream.url.substring(0, 100)}...`);
          });
          
          console.log(`========= END TV STREAM REQUEST (GENERAL ENDPOINT) =========`);
          res.json({ streams });
    } else {
        // Per altri tipi (movies, series) usa il builder
        const builder = createBuilder(config);
        const addonInterface = builder.getInterface();
        
        addonInterface.get({ resource: 'stream', type, id })
            .then((result: any) => {
                console.log(`🎬 STREAM RESULT:`, result);
                res.json(result);
            })
            .catch((error: any) => {
                console.error(`❌ STREAM ERROR:`, error);
                res.status(404).json({ error: 'Not found' });
            });
    }
});

// Aggiungiamo anche l'endpoint specifico per TV stream come MammaMia
app.get('/:config/stream/tv/:id.json', async (req: Request, res: Response) => {
    const configStr = req.params.config;
    const id = req.params.id;
    const config = parseConfigFromArgs(configStr);
    
    console.log(`🎬 TV STREAM REQUEST: id=${id}, config parsed:`, !!config);
    
    console.log(`========= TV STREAM REQUEST (SPECIFIC) =========`);
    console.log(`Channel ID: ${id}`);
    console.log(`Config received:`, JSON.stringify(config, null, 2));
    
    // CORREZIONE: Rimuovi prefisso tv: per trovare il canale
    const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
    console.log(`Clean ID for lookup: ${cleanId}`);
    
    const channel = tvChannels.find((c: any) => c.id === cleanId);
    if (!channel) {
        console.log(`❌ Channel ${id} (cleaned: ${cleanId}) not found in tvChannels`);
        res.status(404).json({ error: 'Channel not found' });
        return;
    }
    
    console.log(`✅ Found channel:`, JSON.stringify(channel, null, 2));
    
    const streams: { url: string; title: string }[] = [];
    const mfpUrl = config.mfpProxyUrl ? normalizeProxyUrl(config.mfpProxyUrl) : 
                 (config.mediaFlowProxyUrl ? normalizeProxyUrl(config.mediaFlowProxyUrl) : '');
    const mfpPsw = config.mfpProxyPassword || config.mediaFlowProxyPassword || '';
    const tvProxyUrl = config.tvProxyUrl ? normalizeProxyUrl(config.tvProxyUrl) : '';
    const staticUrl = (channel as any).staticUrl;

    console.log(`🔧 Configuration:`);
    console.log(`  - MFP URL: ${mfpUrl || 'NOT SET'}`);
    console.log(`  - MFP Password: ${mfpPsw ? 'SET' : 'NOT SET'}`);
    console.log(`  - TV Proxy URL: ${tvProxyUrl || 'NOT SET'}`);
    console.log(`  - Static URL: ${staticUrl || 'NOT SET'}`);

    // Controlla se il canale è in chiaro (da rai1 a rai4k)
    const isFreeToAir = isFreeToAirChannel(cleanId);
    console.log(`🔧 Channel ${cleanId} is free to air: ${isFreeToAir}`);

    // 1. Stream via staticUrl (MPD o HLS)
    if (staticUrl) {
      if (isFreeToAir) {
        // Per canali in chiaro, usa direttamente il staticUrl senza MFP
        streams.push({
          url: staticUrl,
          title: `${(channel as any).name} (MPD)`
        });
        console.log(`✅ Added direct staticUrl for free-to-air channel: ${staticUrl}`);
      } else if (mfpUrl && mfpPsw) {
        // Per canali non in chiaro, usa MFP proxy
        let proxyUrl: string;
        if (staticUrl.includes('.mpd')) {
          // Per file MPD usiamo il proxy MPD
          proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl}`;
        } else {
          // Per altri stream usiamo il proxy stream normale
          proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl}`;
        }
        streams.push({
          url: proxyUrl,
          title: `${(channel as any).name} (MPD)`
        });
        console.log(`✅ Added MFP proxy stream: ${proxyUrl}`);
      } else {
        console.log(`❌ Cannot create stream: staticUrl=${!!staticUrl}, mfpUrl=${!!mfpUrl}, mfpPsw=${!!mfpPsw}`);
      }
    } else {
      console.log(`❌ No staticUrl available for channel ${cleanId}`);
    }

    // 2. Stream via staticUrl2 (seconda URL statica)
    const staticUrl2 = (channel as any).staticUrl2;
    if (staticUrl2) {
      if (isFreeToAir) {
        // Per canali in chiaro, usa direttamente il staticUrl2 senza MFP
        streams.push({
          url: staticUrl2,
          title: `${(channel as any).name} (MPD)`
        });
        console.log(`✅ Added direct staticUrl2 for free-to-air channel: ${staticUrl2}`);
      } else if (mfpUrl && mfpPsw) {
        // Per canali non in chiaro, usa MFP proxy
        let proxyUrl: string;
        if (staticUrl2.includes('.mpd')) {
          // Per file MPD usiamo il proxy MPD
          proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl2}`;
        } else {
          // Per altri stream usiamo il proxy stream normale
          proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${staticUrl2}`;
        }
        streams.push({
          url: proxyUrl,
          title: `${(channel as any).name} (MPD)`
        });
        console.log(`✅ Added MFP proxy stream for staticUrl2: ${proxyUrl}`);
      } else {
        console.log(`❌ Cannot create stream for staticUrl2: staticUrl2=${!!staticUrl2}, mfpUrl=${!!mfpUrl}, mfpPsw=${!!mfpPsw}`);
      }
    }

        // 3. Stream Vavoo dinamico (ottieni link originale per proxy) - SOLO per canali NON in chiaro
    if (!isFreeToAir && tvProxyUrl && (channel as any).vavooNames && Array.isArray((channel as any).vavooNames)) {
        try {
            console.log(`[TV] Trying Vavoo original link for ${id} (non-free-to-air channel)`);
            console.log(`[TV] Vavoo names available:`, (channel as any).vavooNames);
            console.log(`[TV] TV Proxy URL:`, tvProxyUrl);
            
            // Prova tutti i nomi Vavoo per questo canale
            let vavooResolved = false;
            for (const vavooName of (channel as any).vavooNames) {
                if (vavooResolved) break; // Esce al primo successo
                
                console.log(`[TV] Trying to get Vavoo original link: ${vavooName}`);
                try {
                  const originalLink = await getVavooOriginalLink(vavooName);
                  console.log(`[TV] Vavoo original link result for ${vavooName}:`, originalLink);
                  
                  if (originalLink && originalLink !== 'NOT_FOUND' && originalLink !== 'NO_URL' && originalLink !== 'RESOLVE_FAIL' && originalLink !== 'ERROR') {
                    // Passa il link Vavoo originale al proxy (NON quello risolto)
                    const vavooUrl = `${tvProxyUrl}/proxy/m3u?url=${encodeURIComponent(originalLink)}`;
                    streams.push({
                      url: vavooUrl,
                      title: `${(channel as any).name} (V)`
                    });
                    console.log(`[TV] ✅ Added Vavoo stream for ${id} with name ${vavooName}: ${vavooUrl}`);
                    vavooResolved = true;
                  } else {
                    console.log(`[TV] ❌ Failed to get Vavoo original link: ${vavooName} (result: ${originalLink})`);
                  }
                } catch (vavooError) {
                  console.error(`[TV] ❌ Error resolving Vavoo name ${vavooName}:`, vavooError);
                }
            }
            
            if (!vavooResolved) {
                console.log(`[TV] ❌ No Vavoo streams found for ${id}`);
            }
        } catch (error) {
            console.error(`[TV] ❌ General error resolving Vavoo for ${id}:`, error);
        }
    } else if (isFreeToAir) {
        console.log(`[TV] ⏭️ Skipping Vavoo for free-to-air channel ${id} - using only direct streams`);
    } else {
        console.log(`[TV] ❌ Skipping Vavoo for ${id}: tvProxyUrl=${!!tvProxyUrl}, vavooNames=${(channel as any).vavooNames}`);
    }

    console.log(`🔍 Total streams generated: ${streams.length}`);
    streams.forEach((stream, index) => {
        console.log(`  Stream ${index + 1}: ${stream.title} -> ${stream.url.substring(0, 100)}...`);
    });
    
    console.log(`========= END TV STREAM REQUEST (SPECIFIC) =========`);
    res.json({ streams });
});

// Endpoint per ottenere statistiche EPG (deve essere prima degli endpoint dinamici)
app.get('/epg/stats', (req: Request, res: Response) => {
    if (!epgManager) {
        res.status(503).json({ error: 'EPG not enabled' });
        return;
    }
    
    const stats = epgManager.getStats();
    const availableChannels = epgManager.getAvailableChannels();
    
    // Mappatura dei canali TV con EPG
    const channelMapping: any[] = [];
    for (const tvChannel of tvChannels) {
        const epgChannelIds = tvChannel.epgChannelIds || [];
        const epgChannelId = epgManager.findEPGChannelId(tvChannel.name, epgChannelIds);
        channelMapping.push({
            tvChannel: {
                id: tvChannel.id,
                name: tvChannel.name,
                epgChannelIds: epgChannelIds
            },
            epgChannel: epgChannelId ? availableChannels.find(c => c.id === epgChannelId) : null,
            mapped: !!epgChannelId
        });
    }
    
    res.json({
        ...stats,
        totalEPGChannels: availableChannels.length,
        mappedChannels: channelMapping.filter(m => m.mapped).length,
        unmappedChannels: channelMapping.filter(m => !m.mapped).length,
        channelMapping: channelMapping
    });
});

// Endpoint EPG per ottenere i programmi di un canale
app.get('/epg/:channelId', async (req: Request, res: Response) => {
    const channelId = req.params.channelId;
    const date = req.query.date ? new Date(req.query.date as string) : new Date();
    
    console.log(`📺 EPG REQUEST for channel: ${channelId}, date: ${date.toISOString()}`);
    
    if (!epgManager) {
        res.status(503).json({ error: 'EPG not enabled' });
        return;
    }
    
    try {
        // Trova il canale TV corrispondente
        const tvChannel = tvChannels.find((c: any) => c.id === channelId);
        if (!tvChannel) {
            res.status(404).json({ error: 'Channel not found' });
            return;
        }
        
        // Trova l'ID EPG
        const epgChannelIds = (tvChannel as any).epgChannelIds;
        const epgChannelId = epgManager.findEPGChannelId(tvChannel.name, epgChannelIds);
        if (!epgChannelId) {
            res.status(404).json({ error: 'EPG channel not found' });
            return;
        }
        
        // Ottieni i programmi
        const programs = await epgManager.getEPGForChannel(epgChannelId, date);
        
        res.json({
            channel: {
                id: channelId,
                name: tvChannel.name,
                epgId: epgChannelId
            },
            date: date.toISOString().split('T')[0],
            programs: programs.map(p => ({
                start: p.start,
                stop: p.stop,
                title: p.title,
                description: p.description,
                category: p.category,
                startTime: epgManager!.formatTime(p.start),
                endTime: p.stop ? epgManager!.formatTime(p.stop) : null
            }))
        });
    } catch (error) {
        console.error(`❌ EPG Error for ${channelId}:`, error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint per ottenere il programma corrente
app.get('/epg/:channelId/current', async (req: Request, res: Response) => {
    const channelId = req.params.channelId;
    
    if (!epgManager) {
        res.status(503).json({ error: 'EPG not enabled' });
        return;
    }
    
    try {
        const tvChannel = tvChannels.find((c: any) => c.id === channelId);
        if (!tvChannel) {
            res.status(404).json({ error: 'Channel not found' });
            return;
        }
        
        const epgChannelId = epgManager.findEPGChannelId(tvChannel.name);
        if (!epgChannelId) {
            res.status(404).json({ error: 'EPG channel not found' });
            return;
        }
        
        const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
        const nextProgram = await epgManager.getNextProgram(epgChannelId);
        
        res.json({
            channel: {
                id: channelId,
                name: tvChannel.name,
                epgId: epgChannelId
            },
            current: currentProgram ? {
                ...currentProgram,
                startTime: epgManager.formatTime(currentProgram.start),
                endTime: currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : null
            } : null,
            next: nextProgram ? {
                ...nextProgram,
                startTime: epgManager.formatTime(nextProgram.start),
                endTime: nextProgram.stop ? epgManager.formatTime(nextProgram.stop) : null
            } : null
        });
    } catch (error) {
        console.error(`❌ EPG Error for ${channelId}:`, error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint per aggiornare manualmente l'EPG
app.post('/epg/update', async (req: Request, res: Response) => {
    if (!epgManager) {
        res.status(503).json({ error: 'EPG not enabled' });
        return;
    }
    
    console.log(`🔄 Manual EPG update requested`);
    
    try {
        const success = await epgManager.updateEPG();
        if (success) {
            const stats = epgManager.getStats();
            res.json({
                success: true,
                message: 'EPG updated successfully',
                stats: stats
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'EPG update failed'
            });
        }
    } catch (error) {
        console.error(`❌ Manual EPG update error:`, error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Endpoint per generare URL di configurazione Base64 (per test)
app.get('/generate-config', (req: Request, res: Response) => {
    const exampleConfig: AddonConfig = {
        tmdbApiKey: req.query.tmdbApiKey as string || "",
        mediaFlowProxyUrl: req.query.mediaFlowProxyUrl as string || "",
        mediaFlowProxyPassword: req.query.mediaFlowProxyPassword as string || "",
        mfpProxyUrl: req.query.mfpProxyUrl as string || "https://mfpi.pizzapi.uk/",
        mfpProxyPassword: req.query.mfpProxyPassword as string || "mfp",
        tvProxyUrl: req.query.tvProxyUrl as string || "https://tvproxy.pizzapi.uk/"
    };
    
    const base64Config = encodeConfigToBase64(exampleConfig);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    const urls = {
        base64Config: base64Config,
        manifestUrl: `${baseUrl}/${base64Config}/manifest.json`,
        catalogUrl: `${baseUrl}/${base64Config}/catalog/tv/tv-channels.json`,
        testMetaUrl: `${baseUrl}/${base64Config}/meta/tv/tv:skynature.json`,
        testStreamUrl: `${baseUrl}/${base64Config}/stream/tv/tv:skynature.json`,
        stremioInstallUrl: `stremio://${req.get('host')}/${base64Config}/manifest.json`
    };
    
    console.log(`🔧 Generated Base64 URLs:`, urls);
    
    res.json({
        message: "Base64 Configuration URLs Generated",
        config: exampleConfig,
        ...urls
    });
});

// Fallback per qualsiasi pattern di meta che non è stato catturato
app.get('*/meta/*', (req: Request, res: Response) => {
    console.log(`🚨 FALLBACK META ENDPOINT HIT: ${req.url}`);
    console.log(`   Full URL: ${req.url}`);
    console.log(`   Path: ${req.path}`);
    console.log(`   Params:`, req.params);
    
    // Prova a estrarre il config, type e ID dall'URL manualmente
    const urlParts = req.path.split('/');
    console.log(`   URL Parts:`, urlParts);
    
    // Cerca pattern /meta/tv/ID.json o /meta/TYPE/ID.json
    const metaIndex = urlParts.findIndex((part: string) => part === 'meta');
    if (metaIndex >= 0 && metaIndex + 2 < urlParts.length) {
        const type = urlParts[metaIndex + 1];
        const idWithJson = urlParts[metaIndex + 2];
        const id = idWithJson.replace('.json', '');
        
        console.log(`   Extracted: type=${type}, id=${id}`);
        
        if (type === 'tv') {
            const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                console.log(`✅ Found channel via fallback: ${channel.name}`);
                const metaWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape" // Imposta forma poster orizzontale per canali TV
                };
                res.json({ meta: metaWithPrefix });
                return;
            }
        }
    }
    
    res.status(404).json({ error: 'Meta not found' });
});

// Fallback per qualsiasi pattern di stream che non è stato catturato
app.get('*/stream/*', async (req: Request, res: Response) => {
    console.log(`🚨 FALLBACK STREAM ENDPOINT HIT: ${req.url}`);
    console.log(`   Full URL: ${req.url}`);
    console.log(`   Path: ${req.path}`);
    console.log(`   Params:`, req.params);
    
    // Prova a estrarre il config, type e ID dall'URL manualmente
    const urlParts = req.path.split('/');
    console.log(`   URL Parts:`, urlParts);
    
    // Cerca pattern /stream/tv/ID.json o /stream/TYPE/ID.json
    const streamIndex = urlParts.findIndex((part: string) => part === 'stream');
    if (streamIndex >= 0 && streamIndex + 2 < urlParts.length) {
        const type = urlParts[streamIndex + 1];
        const idWithJson = urlParts[streamIndex + 2];
        const id = idWithJson.replace('.json', '');
        
        console.log(`   Extracted: type=${type}, id=${id}`);
        
        if (type === 'tv') {
            const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                console.log(`✅ Found channel via fallback: ${channel.name}`);
                
                // Prova a estrarre la config dalla URL (prima parte)
                let config: AddonConfig = {};
                try {
                    const configPart = urlParts[1]; // Dovrebbe essere la parte con la config
                    if (configPart && configPart !== 'stream') {
                        config = parseConfigFromArgs(decodeURIComponent(configPart));
                    }
                } catch (error) {
                    console.log(`❌ Cannot parse config from fallback, using empty config`);
                }
                
                console.log(`   Using config:`, config);
                
                const streams: { url: string; title: string }[] = [];
                const staticUrl = (channel as any).staticUrl;
                
                // Stream rimossi: "diretto" e "test" come richiesto - mantengo solo Vavoo se disponibile
                
                console.log(`✅ Returning ${streams.length} streams via fallback (only Vavoo if available)`);
                res.json({ streams });
                return;
            }
        }
    }
    
    res.status(404).json({ error: 'Stream not found' });
});

// Catch-all finale per vedere cosa non viene catturato
app.get('*', (req: Request, res: Response) => {
    console.log(`🚨 CATCH-ALL HIT: ${req.method} ${req.url}`);
    console.log(`   This request was not handled by any previous route`);
    res.status(404).json({ 
        error: 'Route not found',
        method: req.method,
        url: req.url,
        path: req.path
    });
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});
