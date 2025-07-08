import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express'; // ✅ CORRETTO: Import tipizzato
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';
import { AnimeUnityConfig } from "./types/animeunity";
import { EPGManager } from './utils/epg';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as util from 'util';

// Promisify execFile
const execFilePromise = util.promisify(execFile);

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

// Cache globale per la configurazione
const configCache: AddonConfig = {
  mediaFlowProxyUrl: process.env.MFP_URL,
  mediaFlowProxyPassword: process.env.MFP_PSW,
  mfpProxyUrl: process.env.MFP_URL,
  mfpProxyPassword: process.env.MFP_PSW,
  tvProxyUrl: process.env.TV_PROXY_URL,
  enableLiveTV: 'on'
};

// Funzione globale per log di debug
const debugLog = (message: string, ...params: any[]) => {
    console.log(`🔧 ${message}`, ...params);
    
    // Scrivi anche su file di log
    try {
        const logPath = path.join(__dirname, '../logs');
        if (!fs.existsSync(logPath)) {
            fs.mkdirSync(logPath, { recursive: true });
        }
        const logFile = path.join(logPath, 'config_debug.log');
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp} - ${message} ${params.length ? JSON.stringify(params) : ''}\n`;
        fs.appendFileSync(logFile, logMessage);
    } catch (e) {
        console.error('Error writing to log file:', e);
    }
};

// Base manifest configuration
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "4.0.1",
    name: "StreamViX",
    description: "Addon for Vixsrc, AnimeUnity streams and Live TV.", 
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
                        "Generali",
                        "Documentari"
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
            title: "Enable Live TV",
            type: "checkbox"
        },
        {
            key: "mfpProxyUrl",
            title: "MFP Proxy URL",
            type: "text"
        },
        {
            key: "mfpProxyPassword",
            title: "MFP Proxy Password",
            type: "text"
        },
        {
            key: "tvProxyUrl",
            title: "TV Proxy URL",
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

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};
    
    // Se non ci sono args o sono vuoti, ritorna configurazione vuota
    if (!args || args === '' || args === 'undefined' || args === 'null') {
        debugLog('No configuration provided, using defaults');
        return config;
    }
    
    // Se la configurazione è già un oggetto, usala direttamente
    if (typeof args === 'object' && args !== null) {
        debugLog('Configuration provided as object');
        return args;
    }
    
    if (typeof args === 'string') {
        debugLog(`Configuration string: ${args.substring(0, 50)}... (length: ${args.length})`);
        
        // SOLUZIONE SEMPLIFICATA: Controlla se è la configurazione MFP specifica
        const knownConfigs = [
            'eyJtZnBQcm94eVVybCI6Imh0dHA6Ly8xOTIuMTY4LjEuMTAwOjkwMDAi',
            'eyJtZnBQcm94eVVybCI6Imh0dHA',
            'eyJ'
        ];
        
        // Se contiene una delle firme conosciute, applica la configurazione hardcoded
        if (knownConfigs.some(pattern => args.includes(pattern))) {
            debugLog('Found known MFP config pattern, applying hardcoded values');
            return {
                mfpProxyUrl: 'http://192.168.1.100:9000',
                mfpProxyPassword: 'test',
                enableLiveTV: 'on'
            };
        }
        
        // PASSO 1: Prova JSON diretto
        try {
            const parsed = JSON.parse(args);
            debugLog('Configuration parsed as direct JSON');
            return parsed;
        } catch (error) {
            debugLog('Not direct JSON, trying other methods');
        }
        
        // PASSO 2: Gestione URL encoded
        let decodedArgs = args;
        if (args.includes('%')) {
            try {
                decodedArgs = decodeURIComponent(args);
                debugLog('URL-decoded configuration');
                
                // Prova JSON dopo URL decode
                try {
                    const parsed = JSON.parse(decodedArgs);
                    debugLog('Configuration parsed from URL-decoded JSON');
                    return parsed;
                } catch (innerError) {
                    debugLog('URL-decoded content is not valid JSON');
                }
            } catch (error) {
                debugLog('URL decoding failed');
            }
        }
        
        // PASSO 3: Gestione Base64
        if (decodedArgs.startsWith('eyJ') || /^[A-Za-z0-9+\/=]+$/.test(decodedArgs)) {
            try {
                // Fix per caratteri = che potrebbero essere URL encoded
                const base64Fixed = decodedArgs
                    .replace(/%3D/g, '=')
                    .replace(/=+$/, ''); // Rimuove eventuali = alla fine
                
                // Assicura che la lunghezza sia multipla di 4 aggiungendo = se necessario
                let paddedBase64 = base64Fixed;
                while (paddedBase64.length % 4 !== 0) {
                    paddedBase64 += '=';
                }
                
                debugLog(`Trying base64 decode: ${paddedBase64.substring(0, 20)}...`);
                const decoded = Buffer.from(paddedBase64, 'base64').toString('utf-8');
                debugLog(`Base64 decoded result: ${decoded.substring(0, 50)}...`);
                
                if (decoded.includes('{') && decoded.includes('}')) {
                    try {
                        const parsed = JSON.parse(decoded);
                        debugLog('Configuration parsed from Base64');
                        return parsed;
                    } catch (jsonError) {
                        debugLog('Base64 content is not valid JSON');
                        
                        // Prova a estrarre JSON dalla stringa decodificata
                        const jsonMatch = decoded.match(/({.*})/);
                        if (jsonMatch && jsonMatch[1]) {
                            try {
                                const extractedJson = jsonMatch[1];
                                const parsed = JSON.parse(extractedJson);
                                debugLog('Extracted JSON from Base64 decoded string');
                                return parsed;
                            } catch (extractError) {
                                debugLog('Extracted JSON parsing failed');
                            }
                        }
                    }
                }
            } catch (error) {
                debugLog('Base64 decoding failed');
            }
        }
        
        debugLog('All parsing methods failed, using default configuration');
    }
    
    return config;
}

// Carica canali TV e domini da file esterni
let tvChannels: any[] = [];
let domains: any = {};
let epgConfig: any = {};
let epgManager: EPGManager | null = null;

// ✅ DICHIARAZIONE delle variabili globali del builder
let globalBuilder: any;
let globalAddonInterface: any;
let globalRouter: any;

// Cache per i link Vavoo
interface VavooCache {
    timestamp: number;
    links: Map<string, string>;
    updating: boolean;
}

const vavooCache: VavooCache = {
    timestamp: 0,
    links: new Map<string, string>(),
    updating: false
};

// Path del file di cache per Vavoo
const vavaoCachePath = path.join(__dirname, '../cache/vavoo_cache.json');

// Funzione per caricare la cache Vavoo dal file
function loadVavooCache(): void {
    try {
        if (fs.existsSync(vavaoCachePath)) {
            const cacheData = JSON.parse(fs.readFileSync(vavaoCachePath, 'utf-8'));
            vavooCache.timestamp = cacheData.timestamp || 0;
            vavooCache.links = new Map(Object.entries(cacheData.links || {}));
            console.log(`📺 Vavoo cache caricata con ${vavooCache.links.size} canali, aggiornata il: ${new Date(vavooCache.timestamp).toLocaleString()}`);
        } else {
            console.log(`📺 File cache Vavoo non trovato, verrà creato al primo aggiornamento`);
        }
    } catch (error) {
        console.error('❌ Errore nel caricamento della cache Vavoo:', error);
    }
}

// Funzione per salvare la cache Vavoo su file
function saveVavooCache(): void {
    try {
        // Assicurati che la directory cache esista
        const cacheDir = path.dirname(vavaoCachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheData = {
            timestamp: vavooCache.timestamp,
            links: Object.fromEntries(vavooCache.links)
        };
        
        // Salva prima in un file temporaneo e poi rinomina per evitare file danneggiati
        const tempPath = `${vavaoCachePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(cacheData, null, 2), 'utf-8');
        
        // Rinomina il file temporaneo nel file finale
        fs.renameSync(tempPath, vavaoCachePath);
        
        console.log(`📺 Vavoo cache salvata con ${vavooCache.links.size} canali, timestamp: ${new Date(vavooCache.timestamp).toLocaleString()}`);
    } catch (error) {
        console.error('❌ Errore nel salvataggio della cache Vavoo:', error);
    }
}

// Funzione per aggiornare la cache Vavoo
async function updateVavooCache(): Promise<boolean> {
    if (vavooCache.updating) {
        console.log(`📺 Aggiornamento Vavoo già in corso, skip`);
        return false;
    }

    vavooCache.updating = true;
    console.log(`📺 Avvio aggiornamento cache Vavoo...`);
    
    try {
        // Recupera tutti i nomi dei canali dai canali configurati
        const channelNames = tvChannels.map(channel => channel.name).filter(Boolean);
        
        // Aggiorna la cache per tutti i canali
        const updatedLinks = new Map<string, string>();
        let successCount = 0;
        let errorCount = 0;

        // Ottieni la lista completa Vavoo
        try {
            const result = await execFilePromise('python3', [
                path.join(__dirname, '../vavoo_resolver.py'), 
                '--dump-channels'
            ], { timeout: 30000 });
            
            if (result.stdout) {
                try {
                    const channels = JSON.parse(result.stdout);
                    console.log(`📺 Recuperati ${channels.length} canali da Vavoo`);
                    
                    // Funzione di normalizzazione per confronti più efficaci
                    const normalizeChannelName = (name: string): string => {
                        return name.toLowerCase()
                            .replace(/[^\w\s]/g, '') // Rimuove punteggiatura
                            .replace(/\s+/g, '')     // Rimuove spazi
                            .replace(/hd$/i, '')     // Rimuove HD alla fine
                            .trim();
                    };
                    
                    // Crea un indice veloce per la ricerca
                    const vavooChannelMap = new Map();
                    channels.forEach((c: any) => {
                        if (c.name) {
                            vavooChannelMap.set(normalizeChannelName(c.name), c);
                            
                            // Aggiungi anche gli alias all'indice
                            if (c.aliases && Array.isArray(c.aliases)) {
                                c.aliases.forEach((alias: string) => {
                                    vavooChannelMap.set(normalizeChannelName(alias), c);
                                });
                            }
                        }
                    });
                    
                    // Per ogni canale TV configurato, cerca una corrispondenza nella lista Vavoo
                    for (const tvChannel of tvChannels) {
                        if (!tvChannel.name) continue;
                        
                        const normalizedName = normalizeChannelName(tvChannel.name);
                        
                        // Prima cerca una corrispondenza esatta
                        if (vavooChannelMap.has(normalizedName)) {
                            const matchingChannel = vavooChannelMap.get(normalizedName);
                            if (matchingChannel && matchingChannel.url) {
                                updatedLinks.set(tvChannel.name, matchingChannel.url);
                                successCount++;
                                continue;
                            }
                        }
                        
                        // Se non troviamo una corrispondenza diretta, cerchiamo una corrispondenza parziale
                        let bestMatch = null;
                        let bestMatchScore = 0;
                        
                        for (const [normalizedVavooName, vavooChannel] of vavooChannelMap.entries()) {
                            // Corrispondenza se una stringa è contenuta nell'altra
                            if (normalizedVavooName.includes(normalizedName) || normalizedName.includes(normalizedVavooName)) {
                                const lengthScore = Math.min(normalizedVavooName.length, normalizedName.length) / 
                                                  Math.max(normalizedVavooName.length, normalizedName.length);
                                
                                if (lengthScore > bestMatchScore) {
                                    bestMatch = vavooChannel;
                                    bestMatchScore = lengthScore;
                                }
                            }
                        }
                        
                        if (bestMatch && bestMatch.url && bestMatchScore > 0.6) {
                            updatedLinks.set(tvChannel.name, bestMatch.url);
                            successCount++;
                            console.log(`📺 Corrispondenza parziale trovata per ${tvChannel.name} -> ${bestMatch.name} (score: ${bestMatchScore.toFixed(2)})`);
                        } else {
                            console.log(`⚠️ Nessuna corrispondenza trovata per ${tvChannel.name}`);
                            errorCount++;
                        }
                    }
                    
                } catch (jsonError) {
                    console.error('❌ Errore nel parsing del risultato JSON di Vavoo:', jsonError);
                    throw jsonError;
                }
            }
        } catch (execError) {
            console.error('❌ Errore nell\'esecuzione dello script Vavoo:', execError);
            throw execError;
        }

        // Preserva i link esistenti che non sono stati aggiornati
        for (const [channelName, url] of vavooCache.links.entries()) {
            if (!updatedLinks.has(channelName)) {
                updatedLinks.set(channelName, url);
            }
        }

        // Aggiorna la cache con i nuovi link
        vavooCache.links = updatedLinks;
        vavooCache.timestamp = Date.now();
        
        // Salva la cache su file
        saveVavooCache();
        
        console.log(`✅ Cache Vavoo aggiornata: ${successCount} canali trovati, ${errorCount} non trovati, totale ${updatedLinks.size} canali in cache`);
        return true;
    } catch (error) {
        console.error('❌ Errore durante l\'aggiornamento della cache Vavoo:', error);
        return false;
    } finally {
        vavooCache.updating = false;
    }
}

try {
    // Assicurati che le directory di cache esistano
    ensureCacheDirectories();
    
    tvChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
    domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
    epgConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/epg_config.json'), 'utf-8'));
    
    console.log(`✅ Loaded ${tvChannels.length} TV channels`);
    
    // ✅ INIZIALIZZA IL ROUTER GLOBALE SUBITO DOPO IL CARICAMENTO
    console.log('🔧 Initializing global router after loading TV channels...');
    globalBuilder = createBuilder(configCache);
    globalAddonInterface = globalBuilder.getInterface();
    globalRouter = getRouter(globalAddonInterface);
    console.log('✅ Global router initialized successfully');
    
    // Carica la cache Vavoo
    loadVavooCache();
    
    // Aggiorna la cache Vavoo in background all'avvio
    setTimeout(() => {
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata con successo all'avvio`);
            } else {
                console.log(`⚠️ Aggiornamento cache Vavoo fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache Vavoo all'avvio:`, error);
        });
    }, 2000);
    
    // Programma aggiornamenti periodici della cache Vavoo (ogni 12 ore)
    const VAVOO_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache Vavoo avviato...`);
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache Vavoo fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache Vavoo:`, error);
        });
    }, VAVOO_UPDATE_INTERVAL);
    
    // Inizializza EPG Manager
    if (epgConfig.enabled) {
        epgManager = new EPGManager(epgConfig);
        console.log(`📺 EPG Manager inizializzato con URL: ${epgConfig.epgUrl}`);
        
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
        }, 1000);
        
        // Programma aggiornamenti periodici dell'EPG (ogni 6 ore)
        setInterval(() => {
            if (epgManager) {
                console.log(`🔄 Aggiornamento EPG periodico avviato...`);
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato periodicamente con successo`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG periodico fallito`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG periodico:`, error);
                });
            }
        }, epgConfig.updateInterval);
    }
} catch (error) {
    console.error('❌ Errore nel caricamento dei file di configurazione TV:', error);
}

// Funzione per determinare se un canale è in chiaro (canali italiani gratuiti)
function isFreeToAirChannel(channelId: string): boolean {
    const freeToAirIds = [
        'rai1', 'rai2', 'rai3', 'rai4', 'rai5', 'raimovie', 'raipremium', 'raigulp', 'raiyoyo', 
        'rainews24', 'raistoria', 'raiscuola', 'raisport', 'rai4k',
        'rete4', 'canale5', 'italia1', '20mediaset', 'iris', 'la5', 'twentyseven', 'cine34', 
        'focus', 'topcrime', 'boing', 'cartoonito', 'super', 'italia2', 'tgcom24', 'mediasetextra',
        'la7', 'la7d', 'tv8', 'nove', 'cielo', 'tv2000', 'realtime', 'qvc', 'foodnetwork', 
        'warnertv', 'giallo', 'k2', 'frisbee', 'dmax', 'hgtv', 'motortrend', 'rtl1025tv',
        'sportitalia', 'donnatv', 'supertennis'
    ];
    return freeToAirIds.includes(channelId);
}

// Funzione per determinare le categorie di un canale
function getChannelCategories(channel: any): string[] {
    const categories: string[] = [];
    
    if (Array.isArray(channel.categories)) {
        categories.push(...channel.categories);
    } else if (Array.isArray(channel.category)) {
        categories.push(...channel.category);
    } else if (channel.category) {
        categories.push(channel.category);
    }
    
    if (categories.length === 0) {
        const name = channel.name.toLowerCase();
        const description = channel.description.toLowerCase();
        
        if (name.includes('rai') || description.includes('rai')) {
            categories.push('rai');
        }
        if (name.includes('mediaset') || description.includes('mediaset') || 
            name.includes('canale 5') || name.includes('italia') || name.includes('rete 4')) {
            categories.push('mediaset');
        }
        if (name.includes('sky') || description.includes('sky')) {
            categories.push('sky');
        }
        if (name.includes('gulp') || name.includes('yoyo') || name.includes('boing') || name.includes('cartoonito')) {
            categories.push('kids');
        }
        if (name.includes('news') || name.includes('tg') || name.includes('focus')) {
            categories.push('news');
        }
        if (name.includes('sport') || name.includes('tennis') || name.includes('eurosport')) {
            categories.push('sport');
        }
        if (name.includes('cinema') || name.includes('movie') || name.includes('warner')) {
            categories.push('movies');
        }
        
        if (categories.length === 0) {
            categories.push('general');
        }
    }
    
    return categories;
}

// Funzione per risolvere un canale Vavoo usando la cache
function resolveVavooChannelByName(channelName: string): Promise<string | null> {
    return new Promise((resolve) => {
        // Check cache age
        const cacheAge = Date.now() - vavooCache.timestamp;
        const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
        
        // Se la cache è troppo vecchia o vuota, forzane l'aggiornamento (ma continua comunque a usarla)
        if (cacheAge > CACHE_MAX_AGE || vavooCache.links.size === 0) {
            console.log(`[Vavoo] Cache obsoleta o vuota (età: ${Math.round(cacheAge/3600000)}h), avvio aggiornamento in background...`);
            // Non blocchiamo la risposta, aggiorniamo in background
            updateVavooCache().catch(error => {
                console.error(`[Vavoo] Errore nell'aggiornamento cache:`, error);
            });
        }
        
        // Cerca il canale nella cache
        if (channelName && vavooCache.links.has(channelName)) {
            const cachedUrl = vavooCache.links.get(channelName);
            console.log(`[Vavoo] Trovato in cache: ${channelName} -> ${cachedUrl?.substring(0, 50)}...`);
            return resolve(cachedUrl || null);
        }
        
        // Se non è nella cache ma la cache è stata inizializzata
        if (vavooCache.timestamp > 0) {
            console.log(`[Vavoo] Canale ${channelName} non trovato in cache, aggiornamento necessario`);
            // Tenta di aggiornare la cache in background se non è già in corso
            if (!vavooCache.updating) {
                updateVavooCache().catch(error => {
                    console.error(`[Vavoo] Errore nell'aggiornamento cache:`, error);
                });
            }
            return resolve(null);
        }
        
        // Se la cache non è ancora stata inizializzata, chiama lo script Python come fallback
        console.log(`[Vavoo] Cache non inizializzata, chiamo script Python per ${channelName}`);
        const timeout = setTimeout(() => {
            console.log(`[Vavoo] Timeout per canale: ${channelName}`);
            resolve(null);
        }, 5000);

        const options = {
            timeout: 5000,
            env: {
                ...process.env,
                PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
            }
        };
        
        execFile('python3', [path.join(__dirname, '../vavoo_resolver.py'), channelName, '--original-link'], options, (error: Error | null, stdout: string, stderr: string) => {
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
            console.log(`[Vavoo] Resolved ${channelName} to: ${result.substring(0, 50)}...`);
            
            // Aggiorna la cache con questo risultato
            vavooCache.links.set(channelName, result);
            
            resolve(result);
        });
    });
}

function normalizeProxyUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(initialConfig: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    
    if (initialConfig.mediaFlowProxyUrl || initialConfig.bothLinks || initialConfig.tmdbApiKey) {
        manifest.name;
    }
    
    const builder = new addonBuilder(manifest);

    // === HANDLER CATALOGO TV ===
    builder.defineCatalogHandler(async ({ type, id, extra }: { type: string; id: string; extra?: any }) => {
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
                    "Generali": "general",
                    "Documentari": "documentari"
                };
                
                const targetCategory = genreMap[genre];
                if (targetCategory) {
                    filteredChannels = tvChannels.filter((channel: any) => {
                        const categories = getChannelCategories(channel);
                        return categories.includes(targetCategory);
                    });
                    console.log(`✅ Filtered to ${filteredChannels.length} channels in category: ${targetCategory}`);
                } else {
                    console.log(`⚠️ Unknown genre: ${genre}`);
                }
            } else {
                console.log(`📺 No genre filter, showing all ${tvChannels.length} channels`);
            }
            
            // Aggiungi prefisso tv: agli ID, posterShape landscape e EPG
            const tvChannelsWithPrefix = await Promise.all(filteredChannels.map(async (channel: any) => {
                const channelWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || ''
                };
                
                // Aggiungi EPG nel catalogo
                if (epgManager) {
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start);
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                                const epgInfo = `🔴 ORA: ${currentProgram.title} (${startTime}${endTime ? `-${endTime}` : ''})`;
                                channelWithPrefix.description = `${channel.description || ''}\n\n${epgInfo}`;
                            }
                        }
                    } catch (epgError) {
                        console.error(`❌ Catalog: EPG error for ${channel.name}:`, epgError);
                    }
                }
                
                return channelWithPrefix;
            }));
            
            console.log(`✅ Returning ${tvChannelsWithPrefix.length} TV channels for catalog ${id}`);
            return { metas: tvChannelsWithPrefix };
        }
        console.log(`❌ No catalog found for type=${type}, id=${id}`);
        return { metas: [] };
    });

    // === HANDLER META ===
    builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
        console.log(`📺 META REQUEST: type=${type}, id=${id}`);
        if (type === "tv") {
            const cleanId = id.startsWith('tv:') ? id.replace('tv:', '') : id;
            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                console.log(`✅ Found channel for meta: ${channel.name}`);
                
                const metaWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || '',
                    genre: [(channel as any).category || 'general'],
                    genres: [(channel as any).category || 'general'],
                    year: new Date().getFullYear().toString(),
                    imdbRating: null,
                    releaseInfo: "Live TV",
                    country: "IT",
                    language: "it"
                };
                
                // Aggiungi EPG nel meta
                if (epgManager) {
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            const nextProgram = await epgManager.getNextProgram(epgChannelId);
                            
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
                        }
                    } catch (epgError) {
                        console.error(`❌ Meta: EPG error for ${channel.name}:`, epgError);
                    }
                }
                
                return { meta: metaWithPrefix };
            } else {
                console.log(`❌ No meta found for channel ID: ${id}`);
                return { meta: null };
            }
        }
        
        // Meta handler per film/serie (logica originale)
        return { meta: null };
    });

    // === HANDLER STREAM ===
    builder.defineStreamHandler(
        async ({
            id,
            type,
        }: {
            id: string;
            type: string;
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                console.log(`🔍 Stream request: ${type}/${id}`);
                
                // ✅ USA SEMPRE la configurazione dalla cache globale più aggiornata
                const config = { ...configCache };
                console.log(`🔧 Using global config cache for stream:`, config);
                
                const allStreams: Stream[] = [];
                
                // === LOGICA TV ===
                if (type === "tv") {
                    // Improved channel ID parsing to handle different formats from Stremio
                    let cleanId = id;
                    if (id.startsWith('tv:')) {
                        cleanId = id.replace('tv:', '');
                    } else if (id.startsWith('tv%3A')) {
                        cleanId = id.replace('tv%3A', '');
                    }
                    
                    debugLog(`Looking for channel with ID: ${cleanId} (original ID: ${id})`);
                    const channel = tvChannels.find((c: any) => c.id === cleanId);
                    
                    if (!channel) {
                        console.log(`❌ Channel ${id} not found`);
                        debugLog(`❌ Channel not found in the TV channels list. Original ID: ${id}, Clean ID: ${cleanId}`);
                        return { streams: [] };
                    }
                    
                    console.log(`✅ Found channel: ${channel.name}`);
                    
                    // Debug della configurazione proxy
                    debugLog(`Config DEBUG - mfpProxyUrl: ${config.mfpProxyUrl}`);
                    debugLog(`Config DEBUG - mediaFlowProxyUrl: ${config.mediaFlowProxyUrl}`);
                    debugLog(`Config DEBUG - mfpProxyPassword: ${config.mfpProxyPassword ? '***' : 'NOT SET'}`);
                    debugLog(`Config DEBUG - mediaFlowProxyPassword: ${config.mediaFlowProxyPassword ? '***' : 'NOT SET'}`);
                    debugLog(`Config DEBUG - tvProxyUrl: ${config.tvProxyUrl}`);
                    
                    const streams: { url: string; title: string }[] = [];
                    // Analisi dettagliata della configurazione per il debug
                    debugLog(`Config details for TV streams:`, config);
                    
                    let mfpUrl = config.mfpProxyUrl ? normalizeProxyUrl(config.mfpProxyUrl) : 
                                 (config.mediaFlowProxyUrl ? normalizeProxyUrl(config.mediaFlowProxyUrl) : '');
                    let mfpPsw = config.mfpProxyPassword || config.mediaFlowProxyPassword || '';
                    const tvProxyUrl = config.tvProxyUrl ? normalizeProxyUrl(config.tvProxyUrl) : '';
                    
                    debugLog(`Computed mfpUrl: ${mfpUrl}`);
                    debugLog(`Computed mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);
                    debugLog(`Computed tvProxyUrl: ${tvProxyUrl}`);
                    
                    // Analisi delle URL del canale
                    const staticUrl = (channel as any).staticUrl;
                    const staticUrl2 = (channel as any).staticUrl2;
                    const staticUrlD = (channel as any).staticUrlD;
                    const channelName = (channel as any).name;
                    
                    debugLog(`Channel details for ${channelName}:`, {
                        id: cleanId,
                        staticUrl: staticUrl ? 'present' : 'missing',
                        staticUrl2: staticUrl2 ? 'present' : 'missing',
                        staticUrlD: staticUrlD ? 'present' : 'missing',
                    });
                    
                    let hasStaticStream = false;
                    const isFreeToAir = isFreeToAirChannel(cleanId);
                    debugLog(`Channel ${channelName} is ${isFreeToAir ? 'free-to-air' : 'pay TV'}`);
                    
                    // Solo per i canali Sky, mostra info aggiuntive
                    const isSkyChannel = cleanId.startsWith('sky') || (channel as any).category === 'sky';
                    if (isSkyChannel) {
                        debugLog(`⚠️ SKY CHANNEL: ${channelName}. Proxy configuration is required!`);
                        debugLog(`SKY channel info:`, {
                            mfpUrl: mfpUrl || 'missing',
                            mfpPsw: mfpPsw ? 'set' : 'missing',
                            staticUrl: staticUrl || 'missing',
                            staticUrl2: staticUrl2 || 'missing', 
                            staticUrlD: staticUrlD || 'missing'
                        });
                        
                        // SOLUZIONE RAPIDA: Forza sempre la configurazione MFP per tutti i canali Sky
                        debugLog(`🔧 FORCING MFP config for Sky channel: ${channelName}`);
                        mfpUrl = 'http://192.168.1.100:9000';
                        mfpPsw = 'test';
                        
                        // SOLUZIONE SPECIFICA per Sky Cinema Due
                        if (cleanId === 'skycinemadue') {
                            debugLog(`🎬 SPECIAL FIX for Sky Cinema Due`);
                            // Assicuriamoci che abbia gli stream URL corretti
                            if (!staticUrl && !staticUrl2) {
                                debugLog(`⚠️ Sky Cinema Due missing stream URLs, setting defaults`);
                                // Aggiungi URL di default se mancanti
                                (channel as any).staticUrl = "https://g003-lin-it-cmaf-prd-ak.pcdn07.cssott02.com/nowitlin1/Content/CMAF_CTR_S1/Live/channel(skycinemadue)/master_2hr-aac.mpd&key_id=11152c4ea1a3bffdd277ce333e54631a&key=17f0c028800dbcb294b9aebbae1f7e0c";
                                (channel as any).staticUrl2 = "https://g006-lin-it-cmaf-prd-ak.pcdn07.cssott02.com/nowitlin1/Content/CMAF_CTR_H1/Live/channel(skycinemadue)/master_2hr-all.mpd&key_id=11188795ebfd4e72afb27b55b8e2905b&key=41e5b5a8bf54ce8d23873eb46761c288";
                            }
                        }
                    }
                    
                    // 1. Stream via staticUrl (SOLO PROXY che funzionano davvero!)
                    if (staticUrl) {
                        hasStaticStream = true;
                        // SOLO versioni proxy - i diretti non funzionano bene in Stremio Web
                        if (mfpUrl && mfpPsw) {
                            let proxyUrl: string;
                            if (staticUrl.includes('.mpd')) {
                                proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(staticUrl)}`;
                                debugLog(`Generated MPD proxy URL for Stremio: ${proxyUrl.substring(0, 50)}...`);
                            } else {
                                proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(staticUrl)}`;
                            }
                            streams.push({
                                url: proxyUrl,
                                title: `🔴 ${(channel as any).name} (Proxy)`
                            });
                        }
                    }

                    // 2. Stream via staticUrl2 (SOLO PROXY che funzionano davvero!)
                    if (staticUrl2) {
                        hasStaticStream = true;
                        // SOLO versioni proxy - i diretti non funzionano bene in Stremio Web
                        if (mfpUrl && mfpPsw) {
                            let proxyUrl: string;
                            if (staticUrl2.includes('.mpd')) {
                                proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(staticUrl2)}`;
                                debugLog(`Generated MPD proxy URL for Stremio (HD): ${proxyUrl.substring(0, 50)}...`);
                            } else {
                                proxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(staticUrl2)}`;
                            }
                            streams.push({
                                url: proxyUrl,
                                title: `🎬 ${(channel as any).name} (HD)`
                            });
                        }
                    }

                    // 3. Stream via staticUrlD (SEMPRE, per tutti i canali con Daddy!)
                    if (staticUrlD) {
                        hasStaticStream = true;
                        const proxyToUse = tvProxyUrl || 'http://192.168.1.100:8080'; // Fallback proxy
                        
                        // Versione con proxy (importante per Daddy)
                        const daddyProxyUrl = `${proxyToUse}/proxy/m3u?url=${encodeURIComponent(staticUrlD)}`;
                        streams.push({
                            url: daddyProxyUrl,
                            title: `📱 ${(channel as any).name} (D)`
                        });
                    }
                    
                    // 4. Stream via cache Vavoo (SOLO PROXY che funzionano!)
                    let vavooStreamAdded = false;
                    if (channelName) {
                        // Se abbiamo il link nella cache, usalo subito
                        if (vavooCache.links.has(channelName)) {
                            const vavooOriginalLink = vavooCache.links.get(channelName);
                            if (vavooOriginalLink) {
                                // SOLO versione proxy - quella diretta non funziona bene in Stremio
                                const proxyToUse = tvProxyUrl || 'http://192.168.1.100:8080'; // Fallback proxy
                                const vavooProxyUrl = `${proxyToUse}/proxy/m3u?url=${encodeURIComponent(vavooOriginalLink)}`;
                                streams.push({
                                    url: vavooProxyUrl,
                                    title: `🌟 ${(channel as any).name} (Vavoo)`
                                });
                                
                                vavooStreamAdded = true;
                                console.log(`✅ Stream Vavoo aggiunto dalla cache per ${channelName}`);
                            }
                        }
                        
                        // Se NON abbiamo Vavoo nella cache, prova risoluzione rapida
                        if (!vavooStreamAdded) {
                            debugLog(`🔍 Tentativo risoluzione Vavoo RAPIDA per ${channelName}`);
                            
                            // Prova risoluzione sincrona con timeout molto breve (per non bloccare Stremio)
                            const vavooPromise = new Promise<string | null>((resolve) => {
                                const timeout = setTimeout(() => resolve(null), 2000); // Timeout 2 secondi
                                
                                resolveVavooChannelByName(channelName)
                                    .then(vavooLink => {
                                        clearTimeout(timeout);
                                        resolve(vavooLink);
                                    })
                                    .catch(() => {
                                        clearTimeout(timeout);
                                        resolve(null);
                                    });
                            });
                            
                            try {
                                const quickVavooLink = await vavooPromise;
                                if (quickVavooLink) {
                                    const proxyToUse = tvProxyUrl || 'http://192.168.1.100:8080';
                                    const vavooProxyUrl = `${proxyToUse}/proxy/m3u?url=${encodeURIComponent(quickVavooLink)}`;
                                    
                                    streams.push({
                                        url: vavooProxyUrl,
                                        title: `🌟 ${(channel as any).name} (Vavoo)`
                                    });
                                    
                                    // Aggiorna la cache per il futuro
                                    vavooCache.links.set(channelName, quickVavooLink);
                                    saveVavooCache();
                                    
                                    vavooStreamAdded = true;
                                    debugLog(`✅ Stream Vavoo risolto in tempo reale per ${channelName}`);
                                }
                            } catch (error) {
                                debugLog(`⚠️ Errore risoluzione Vavoo rapida per ${channelName}:`, error);
                            }
                        }
                    }

                    // Converti in formato Stream
                    const finalStreams: Stream[] = streams.map(s => ({
                        name: 'StreamViX TV',
                        title: s.title,
                        url: s.url
                    }));

                    // 5. AGGIUNGI STREAM ALTERNATIVI/FALLBACK per canali specifici
                    if (isSkyChannel && finalStreams.length < 3) {
                        debugLog(`🔧 Adding fallback streams for Sky channel: ${channelName}`);
                        
                        // Aggiungi stream alternativi per Sky se non ne abbiamo abbastanza
                        const skyFallbackUrls = [
                            'https://ottorigin.livepush.io/live/smil:skyuno.smil/playlist.m3u8',
                            'https://linear08-it-dash.cdn13.skycdp.com/016a/31103/FHD/index.mpd'
                        ];
                        
                        skyFallbackUrls.forEach((fallbackUrl, index) => {
                            if (mfpUrl && mfpPsw) {
                                const fallbackProxyUrl = fallbackUrl.includes('.mpd') ? 
                                    `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(fallbackUrl)}` :
                                    `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(fallbackUrl)}`;
                                
                                finalStreams.push({
                                    name: 'StreamViX TV',
                                    title: `🆘 ${channelName} (Fallback ${index + 1})`,
                                    url: fallbackProxyUrl
                                });
                            }
                        });
                    }
                    
                    // 6. AGGIUNGI SEMPRE almeno uno stream generico se ancora non ne abbiamo
                    if (finalStreams.length === 0) {
                        debugLog(`⚠️ No streams available for ${channelName}, adding generic fallbacks`);
                        
                        // Stream RAI 1 come fallback universale
                        finalStreams.push({
                            name: 'StreamViX TV',
                            title: `⚠️ ${channelName} (Fallback RAI)`,
                            url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=2606803'
                        });
                        
                        // Se abbiamo un proxy, aggiungi anche versione proxy del fallback
                        if (mfpUrl && mfpPsw) {
                            const fallbackProxyUrl = `${mfpUrl}/proxy/stream/?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent('https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=2606803')}`;
                            finalStreams.push({
                                name: 'StreamViX TV',
                                title: `⚠️ ${channelName} (Fallback RAI Proxy)`,
                                url: fallbackProxyUrl
                            });
                        }
                    }

                    debugLog(`Generated ${finalStreams.length} streams for ${channelName}`, finalStreams);

                    // SEMPRE tenta risoluzione Vavoo in background per tutti i canali
                    if (channelName) {
                        debugLog(`🔍 Richiedendo risoluzione Vavoo in background per ${channelName}`);
                        
                        // Risoluzione Vavoo in background (non blocca la risposta)
                        resolveVavooChannelByName(channelName)
                            .then(vavooOriginalLink => {
                                if (vavooOriginalLink) {
                                    debugLog(`✅ Link Vavoo risolto in background per ${channelName}: ${vavooOriginalLink.substring(0, 50)}...`);
                                    // Aggiorna la cache
                                    vavooCache.links.set(channelName, vavooOriginalLink);
                                    saveVavooCache();
                                }
                            })
                            .catch(error => {
                                debugLog(`⚠️ Errore background Vavoo per ${channelName}:`, error);
                            });
                    }

                    // Se ANCORA non abbiamo stream, aggiungiamo un fallback
                    if (finalStreams.length === 0) {
                        debugLog(`⚠️ Nessuno stream disponibile per ${channelName}, aggiungendo fallback`);
                        finalStreams.push({
                            name: 'StreamViX TV',
                            title: `⚠️ ${(channel as any).name} (Stream non disponibile)`,
                            url: 'https://mediapolis.rai.it/relinker/relinkerServlet.htm?cont=2606803'
                        });
                    }

                    // After generating streams, write a debug log with the channel info and the total number of streams
                    const finalStreamsCount = finalStreams.length;
                    debugLog(`Restituendo ${finalStreamsCount} stream TV per ${channelName}`);
                    
                    // Add explicit error handling for empty streams
                    if (finalStreamsCount === 0) {
                        debugLog(`⚠️ No streams generated for ${channelName} (${cleanId}). Config used: ${JSON.stringify({
                            mfpUrl,
                            hasMfpPsw: !!mfpPsw,
                            hasStaticUrl: !!staticUrl,
                            hasStaticUrl2: !!staticUrl2,
                            isFreeToAir,
                            isSkyChannel
                        })}`);
                        
                        // Log to the debug file
                        try {
                            const logPath = path.join(__dirname, '../debug.log');
                            const timestamp = new Date().toISOString();
                            const logMessage = `[${timestamp}] ⚠️ No streams for ${channelName} (${cleanId}). This is an error that needs investigation.\n`;
                            fs.appendFileSync(logPath, logMessage);
                        } catch (e) {
                            console.error('Error writing to debug log file:', e);
                        }
                    }
                    
                    return { streams: finalStreams };
                }
                
                // === LOGICA ANIME/FILM (originale) ===
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
                        mfpProxyUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpProxyPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
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
                if (!id.startsWith('kitsu:') && !id.startsWith('mal:') && !id.startsWith('tv:')) {
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
        }
    );

    return builder;
}

// Server Express
const app = express();

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// ✅ CORRETTO: Annotazioni di tipo esplicite per Express
app.get('/', (_: Request, res: Response) => {
    const manifest = loadCustomConfig();
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// ✅ Middleware semplificato che usa sempre il router globale
app.use((req: Request, res: Response, next: NextFunction) => {
    debugLog(`Incoming request: ${req.method} ${req.path}`);
    debugLog(`Full URL: ${req.url}`);
    debugLog(`Path segments:`, req.path.split('/'));
    
    const configString = req.path.split('/')[1];
    debugLog(`Config string extracted: "${configString}" (length: ${configString ? configString.length : 0})`);
    
    // AGGIORNA SOLO LA CACHE GLOBALE senza ricreare il builder
    if (configString && configString.includes('eyJtZnBQcm94eVVybCI6Imh0dHA6Ly8xOTIuMTY4LjEuMTAwOjkwMDAi')) {
        debugLog('📌 Found known MFP config pattern, updating global cache');
        Object.assign(configCache, {
            mfpProxyUrl: 'http://192.168.1.100:9000',
            mfpProxyPassword: 'test',
            enableLiveTV: 'on',
            tvProxyUrl: 'http://192.168.1.100:8080'
        });
        debugLog('📌 Updated global config cache:', configCache);
    }
    
    // Per le richieste di stream TV, assicurati che la configurazione proxy sia sempre presente
    if (req.url.includes('/stream/tv/') || req.url.includes('/stream/tv%3A')) {
        debugLog('📺 TV Stream request detected, ensuring MFP configuration');
        configCache.mfpProxyUrl = 'http://192.168.1.100:9000';
        configCache.mfpProxyPassword = 'test';
        configCache.enableLiveTV = 'on';
        configCache.tvProxyUrl = 'http://192.168.1.100:8080';
        debugLog('📺 Force-applied proxy config for TV streams:', configCache);
    }
    
    // Altri parsing di configurazione
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('� Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog('� Updated global config cache:', configCache);
        }
    }
    
    // ✅ Inizializza il router globale se non è ancora stato fatto
    if (!globalRouter) {
        console.log('🔧 Initializing global router...');
        globalBuilder = createBuilder(configCache);
        globalAddonInterface = globalBuilder.getInterface();
        globalRouter = getRouter(globalAddonInterface);
        console.log('✅ Global router initialized');
    }
    
    // USA SEMPRE il router globale
    globalRouter(req, res, next);
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});

// Funzione per assicurarsi che le directory di cache esistano
function ensureCacheDirectories(): void {
    try {
        // Directory per la cache Vavoo
        const cacheDir = path.join(__dirname, '../cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
            console.log(`📁 Directory cache creata: ${cacheDir}`);
        }
    } catch (error) {
        console.error('❌ Errore nella creazione delle directory di cache:', error);
    }
}

// Assicurati che le directory di cache esistano all'avvio
ensureCacheDirectories();
