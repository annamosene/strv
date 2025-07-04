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
import type { IncomingMessage, ServerResponse } from 'http';

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
    idPrefixes: ["tt", "kitsu"],
    catalogs: [
        {
            type: "tv",
            id: "tv-channels",
            name: "Canali TV",
            extra: []
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

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};
    
    if (typeof args === 'string') {
        try {
            const decoded = decodeURIComponent(args);
            const parsed = JSON.parse(decoded);
            return parsed;
        } catch (error) {
            return {};
        }
    }
    
    if (typeof args === 'object' && args !== null) {
        return args;
    }
    
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
const { execFile } = require('child_process');
function resolveVavooChannelByName(channelName: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile('python3', ['vavoo_resolver.py', channelName], { timeout: 20000 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error || !stdout) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

// Carica canali TV e domini da file esterni (per HuggingFace/Docker)
const tvChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
const domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));

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
    builder.defineCatalogHandler(({ type, id }: { type: string; id: string }) => {
      if (type === "tv" && id === "tv-channels") {
        return Promise.resolve({ metas: tvChannels });
      }
      return Promise.resolve({ metas: [] });
    });

    // === HANDLER META TV ===
    builder.defineMetaHandler(({ type, id }: { type: string; id: string }) => {
      if (type === "tv") {
        const channel = tvChannels.find((c: any) => c.id === id);
        if (channel) return Promise.resolve({ meta: channel });
      }
      return Promise.resolve({ meta: null });
    });

    // === HANDLER STREAM TV ===
    builder.defineStreamHandler(async ({ type, id }: { type: string; id: string }) => {
      if (type === "tv") {
        const channel = tvChannels.find((c: any) => c.id === id);
        if (!channel) return { streams: [] };
        const streams: { url: string; title: string }[] = [];
        // Normalizza i proxy URL
        const mfpUrl = config.mfpProxyUrl ? normalizeProxyUrl(config.mfpProxyUrl) : '';
        const tvProxyUrl = config.tvProxyUrl ? normalizeProxyUrl(config.tvProxyUrl) : '';
        // Statico (MFP)
        if ((channel as any).staticUrl && mfpUrl && config.mfpProxyPassword) {
          streams.push({
            url: `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(config.mfpProxyPassword)}&d=${encodeURIComponent((channel as any).staticUrl)}`,
            title: "Statico (MFP)"
          });
        }
        // Vavoo (TV Proxy)
        if (tvProxyUrl) {
          const resolved = await resolveVavooChannelByName((channel as any).name);
          if (resolved) {
            streams.push({
              url: `${tvProxyUrl}/proxy/m3u?url=${encodeURIComponent(resolved)}`,
              title: "Live (Vavoo)"
            });
          }
        }
        return { streams };
      }
      // ... existing code ...
    });

    builder.defineStreamHandler(
        async ({
            id,
            type,
        }: {  // ✅ CORRETTO: Annotazioni di tipo esplicite
            id: string;
            type: string;
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                console.log(`🔍 Stream request: ${type}/${id}`);
                
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
        }
    );

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

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// ✅ CORRETTO: Annotazioni di tipo esplicite per Express
app.get('/', (_: Request, res: Response) => {
    const manifest = loadCustomConfig();
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

app.use((req: Request, res: Response, next: NextFunction) => {
    const configString = req.path.split('/')[1];
    const config = parseConfigFromArgs(configString);
    const builder = createBuilder(config);
    
    const addonInterface = builder.getInterface();
    const router = getRouter(addonInterface);
    
    router(req, res, next);
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});
