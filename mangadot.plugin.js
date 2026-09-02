// mangadot.net — Harbor MangaProvider plugin
//
// ATENCIÓN: El sitio usa React Router v7 con hidratación SSR. 
// Los endpoints `/api/` pueden no devolver JSON debido a Cloudflare.
// Alternativa: parsear el HTML de las páginas y extraer datos del React hydration payload.

const BASE_URL = "https://mangadot.net";
const API_URL = `${BASE_URL}/api`;
const PAGE_SIZE = 100;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// --- Helpers ---

async function fetchJson(url) {
  try {
    const res = await harbor.http(url, {
      responseType: "text",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      harbor.log(`❌ HTTP ${res.status} en ${url}`);
      return null;
    }
    try {
      const parsed = JSON.parse(res.body);
      harbor.log(`✓ JSON ok desde ${url.split("?")[0]}`);
      return parsed;
    } catch (e) {
      harbor.log(`❌ NO-JSON en ${url} — intentando parsear HTML...`);
      return null;
    }
  } catch (e) {
    harbor.log(`❌ NETWORK error: ${String(e).slice(0, 100)}`);
    return null;
  }
}

async function fetchHtml(url) {
  try {
    const res = await harbor.http(url, {
      responseType: "text",
      headers: {
        "user-agent": BROWSER_UA,
      },
    });
    if (!res.ok) {
      harbor.log(`❌ HTML HTTP ${res.status} en ${url}`);
      return null;
    }
    return res.body;
  } catch (e) {
    harbor.log(`❌ HTML NETWORK: ${String(e).slice(0, 100)}`);
    return null;
  }
}

// Extrae el payload React hydration del HTML
// Busca: window.__reactRouterContext.streamController.enqueue("[{...}]")
function extractHydrationPayload(html) {
  const match = html.match(/streamController\.enqueue\("(.+?)"\);/);
  if (!match) {
    harbor.log("❌ No se encontró hydration payload en HTML");
    return null;
  }
  try {
    const payload = JSON.parse(match[1]);
    harbor.log("✓ Hydration payload extraído del HTML");
    return payload;
  } catch (e) {
    harbor.log("❌ No se pudo parsear hydration payload:", String(e).slice(0, 100));
    return null;
  }
}

function absoluteUrl(path) {
  if (!path) return undefined;
  return path.startsWith("http") ? path : `${BASE_URL}${path}`;
}

function fixMojibake(str) {
  if (!str) return str;
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) & 0xff);
  }
  try {
    return decodeURIComponent(escape(out));
  } catch (e) {
    return str;
  }
}

function hydrate(rootIndex, table) {
  const seen = new Map();
  function resolve(value) {
    if (value === -5) return null;
    if (typeof value === "number" && typeof table[value] === "string") {
      const s = table[value].trim();
      if (s[0] === "[" && s[s.length - 1] === "]") {
        try {
          return JSON.parse(s);
        } catch (e) {
          // no era JSON
        }
      }
    }
    if (typeof value === "number" && table[value] !== undefined) {
      return walk(table[value]);
    }
    return walk(value);
  }
  function walk(node) {
    if (node == null) return node;
    if (seen.has(node)) return seen.get(node);
    if (Array.isArray(node)) {
      return node.map(resolve);
    }
    if (typeof node === "object") {
      const out = {};
      seen.set(node, out);
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("_")) {
          const realKey = table[Number(k.slice(1))];
          out[realKey] = resolve(v);
        } else {
          out[k] = resolve(v);
        }
      }
      return out;
    }
    return node;
  }
  return resolve(rootIndex);
}

function buildParams(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    const k = encodeURIComponent(key);
    if (Array.isArray(value)) {
      for (const v of value) parts.push(`${k}=${encodeURIComponent(v)}`);
    } else if (value != null) {
      parts.push(`${k}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

const STATUS_MAP = {
  Ongoing: "ongoing",
  Completed: "completed",
  on_hiatus: "hiatus",
  unknown: "unknown",
};

function mangaFromNode(manga) {
  const status =
    manga.hiatus && manga.hiatus !== "No"
      ? STATUS_MAP.on_hiatus
      : STATUS_MAP[manga.status] || STATUS_MAP.unknown;

  return {
    id: String(manga.id),
    title: fixMojibake(manga.title),
    cover: absoluteUrl(manga.photo),
    description: fixMojibake(manga.description),
    status,
    genres: manga.genres || undefined,
    author: manga.authors && manga.authors.length ? manga.authors.join(" & ") : undefined,
    artist: manga.artists && manga.artists.length ? manga.artists.join(" & ") : undefined,
  };
}

function findMangaInHydrated(hydrated) {
  if (!hydrated) return null;
  if (hydrated.id && hydrated.title) {
    return hydrated;
  }
  if (typeof hydrated === "object" && !Array.isArray(hydrated)) {
    if (hydrated.manga && hydrated.manga.id && hydrated.manga.title) {
      return hydrated.manga;
    }
    if (hydrated.data && hydrated.data.id && hydrated.data.title) {
      return hydrated.data;
    }
    if (hydrated.content && hydrated.content.id && hydrated.content.title) {
      return hydrated.content;
    }
    if (hydrated.result && hydrated.result.id && hydrated.result.title) {
      return hydrated.result;
    }
  }
  return null;
}

// --- MangaProvider ---

const plugin = {
  id: "mangadot",
  name: "Mangadotnet",

  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset, "tracked");

    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const json = await fetchJson(
      `${BASE_URL}/view-all/most-tracked.data?adult=1&page=${page}&_routes=pages/ViewAllPage`,
    );
    if (!json) return [];

    const hydrated = hydrate(7, json);
    if (!hydrated || !hydrated.manga_list) return [];

    return hydrated.manga_list.map(mangaFromNode);
  },

  async _byGenre(tagId, offset, sortBy) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const params = {
      genre: [tagId],
      adult: 1,
      page,
      perPage: PAGE_SIZE,
      _routes: "pages/SearchPage",
    };
    if (sortBy) params.sortBy = sortBy;

    const json = await fetchJson(`${BASE_URL}/search.data?${buildParams(params)}`);
    if (!json) return [];

    const hydrated = hydrate(4, json);
    if (!hydrated || !hydrated.results) return [];

    return hydrated.results.map(mangaFromNode);
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);

    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const params = {
      adult: 1,
      page,
      perPage: PAGE_SIZE,
      _routes: "pages/SearchPage",
    };
    if (query) params.search = query;
    if (tagId) params.genre = [tagId];

    const json = await fetchJson(`${BASE_URL}/search.data?${buildParams(params)}`);
    if (!json) return [];

    const hydrated = hydrate(4, json);
    if (!hydrated || !hydrated.results) return [];

    return hydrated.results.map(mangaFromNode);
  },

  async detail(id) {
    const url = `${BASE_URL}/manga/${encodeURIComponent(id)}.data?_routes=pages/MangaDetailPage`;
    let json = await fetchJson(url);
    
    // Si .data falla, intentar parsear HTML de la página normal
    if (!json) {
      harbor.log("→ Intentando parsear HTML de página normal...");
      const htmlUrl = `${BASE_URL}/manga/${encodeURIComponent(id)}`;
      const html = await fetchHtml(htmlUrl);
      if (html) {
        json = extractHydrationPayload(html);
      }
    }

    if (!json) return null;

    let mangaNode = null;
    const tableCopy = Array.isArray(json) ? json : [];
    
    for (let idx = 20; idx >= 0; idx--) {
      try {
        const attempt = hydrate(idx, tableCopy);
        const found = findMangaInHydrated(attempt);
        if (found) {
          mangaNode = found;
          harbor.log(`✓ Manga encontrado en índice ${idx}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!mangaNode) {
      harbor.log("❌ No se encontró manga válido");
      return null;
    }

    const base = mangaFromNode(mangaNode);
    const chapters = await plugin.chapters(id);
    base.lastChapter = chapters.length ? chapters[chapters.length - 1].chapter : undefined;
    return base;
  },

  async chapters(id) {
    // Intentar API directo primero
    const url = `${API_URL}/manga/${encodeURIComponent(id)}/chapters/list`;
    harbor.log(`→ Solicitando capítulos desde ${url}`);
    
    let json = await fetchJson(url);
    
    // Si falla, parsear HTML de la página del manga
    if (!json) {
      harbor.log("→ API falló, intentando parsear HTML...");
      const htmlUrl = `${BASE_URL}/manga/${encodeURIComponent(id)}`;
      const html = await fetchHtml(htmlUrl);
      if (html) {
        json = extractHydrationPayload(html);
        if (json) {
          // Buscar chapters en el payload hidratado
          const table = Array.isArray(json) ? json : [];
          for (let idx = 0; idx < Math.min(20, table.length); idx++) {
            const attempt = hydrate(idx, table);
            if (attempt && Array.isArray(attempt.chapters)) {
              json = { data: attempt.chapters };
              break;
            }
          }
        }
      }
    }

    if (!json) {
      harbor.log("❌ Capítulos: no se obtuvieron datos");
      return [];
    }

    let chaptersData = [];
    if (Array.isArray(json)) {
      chaptersData = json;
      harbor.log(`✓ Array directo: ${json.length} capítulos`);
    } else if (json.data && Array.isArray(json.data)) {
      chaptersData = json.data;
      harbor.log(`✓ json.data: ${json.data.length} capítulos`);
    } else if (json.chapters && Array.isArray(json.chapters)) {
      chaptersData = json.chapters;
      harbor.log(`✓ json.chapters: ${json.chapters.length} capítulos`);
    } else {
      harbor.log(`❌ Formato inesperado: ${Object.keys(json || {}).slice(0, 5)}`);
      return [];
    }

    const chapters = chaptersData
      .map((c) => {
        if (c == null || c.id == null) return null;

        let chapNum = "0";
        if (c.chapter_number != null) {
          chapNum = String(c.chapter_number);
        } else if (c.number != null) {
          chapNum = String(c.number);
        } else if (c.chapterNumber != null) {
          chapNum = String(c.chapterNumber);
        }

        const hasGroup = c.group_name || c.scanlator_group || c.translator_group || c.group;

        let title = `Chapter ${chapNum}`;
        if (c.chapter_title && String(c.chapter_title).length) {
          title = fixMojibake(c.chapter_title);
        } else if (c.title && String(c.title).length) {
          title = fixMojibake(c.title);
        } else if (c.volume_number || c.volume) {
          const vol = c.volume_number || c.volume;
          title = `Volume ${vol} Chapter ${chapNum}`;
        }

        return {
          id: hasGroup ? `${c.id}?source=user` : String(c.id),
          chapter: chapNum,
          title,
          pages: c.page_count || c.pages || 0,
          language: c.language || "en",
          publishAt: c.date_added || c.upload_date || c.created_at || c.date || undefined,
          group: hasGroup ? String(hasGroup) : undefined,
        };
      })
      .filter(Boolean);

    chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter));
    harbor.log(`✓ Retornando ${chapters.length} capítulos`);
    return chapters;
  },

  async pageUrls(chapterId) {
    const isUserUpload = chapterId.includes("?source=user");
    const rawId = isUserUpload ? chapterId.split("?")[0] : chapterId;
    const endpoint = isUserUpload
      ? `${API_URL}/uploads/${encodeURIComponent(rawId)}/images`
      : `${API_URL}/chapters/${encodeURIComponent(rawId)}/images`;

    harbor.log(`→ Solicitando imágenes desde ${endpoint}`);
    let json = await fetchJson(endpoint);

    // Si falla, parsear HTML del capítulo
    if (!json) {
      harbor.log("→ API falló, intentando parsear HTML del capítulo...");
      const htmlUrl = `${BASE_URL}/chapter/${encodeURIComponent(chapterId.split("?")[0])}`;
      const html = await fetchHtml(htmlUrl);
      if (html) {
        json = extractHydrationPayload(html);
        if (json) {
          const table = Array.isArray(json) ? json : [];
          for (let idx = 0; idx < Math.min(20, table.length); idx++) {
            const attempt = hydrate(idx, table);
            if (attempt && Array.isArray(attempt.images)) {
              json = { images: attempt.images };
              break;
            } else if (attempt && Array.isArray(attempt.pages)) {
              json = { images: attempt.pages };
              break;
            }
          }
        }
      }
    }

    if (!json) {
      harbor.log("❌ Imágenes: no se obtuvieron datos");
      return [];
    }

    let images = [];
    if (Array.isArray(json)) {
      images = json;
      harbor.log(`✓ Array directo: ${json.length} imágenes`);
    } else if (json.images && Array.isArray(json.images)) {
      images = json.images;
      harbor.log(`✓ json.images: ${json.images.length} imágenes`);
    } else if (json.data && Array.isArray(json.data)) {
      images = json.data;
      harbor.log(`✓ json.data: ${json.data.length} imágenes`);
    } else if (json.pages && Array.isArray(json.pages)) {
      images = json.pages;
      harbor.log(`✓ json.pages: ${json.pages.length} imágenes`);
    } else {
      harbor.log(`❌ Formato inesperado: ${Object.keys(json || {}).slice(0, 5)}`);
      return [];
    }

    const result = images
      .map((img) => {
        let url = null;
        if (typeof img === "string") {
          url = img;
        } else if (typeof img === "object" && img !== null) {
          url = img.url || img.image || img.src || img.link;
        }
        return absoluteUrl(url);
      })
      .filter(Boolean);

    harbor.log(`✓ Retornando ${result.length} URLs válidas`);
    return result;
  },

  async tags() {
    const GENRES = [
      "Academy", "Acting", "action", "Action", "Adeventure", "adult", "Adult",
      "adventure", "Adventure", "Aliens", "and slice-of-life", "Animals",
      "Anthology", "Avant Garde", "award_winning", "Award winning",
      "Award Winning", "Based on an Anime", "boys' love", "boys_love",
      "Boys Love", "Boys' Love", "Bully", "business", "child abuse",
      "child neglect", "comedy", "Comedy", "Comic", "Cooking", "Crime",
      "Crossdressing", "Delinquents", "Demons", "difficult childhood",
      "doujinshi", "Doujinshi", "drama", "Drama", "ecchi", "Ecchi", "erotica",
      "Erotica", "fantasy", "Fantasy", "female protagonist", "femdom",
      "Fight", "Fluff", "gender_bender", "Gender bender", "Gender Bender",
      "Genderswap", "Genius MC", "Ghosts", "girls_love", "Girls love",
      "Girls Love", "Girls' Love", "gore", "Gourmet", "Gyaru", "harem",
      "Harem", "hentai", "Hentai", "historical", "Historical", "horror",
      "Horror", "Hunters", "Idol", "Idols", "Incest", "Isekai", "josei",
      "Josei", "Loli", "Lolicon", "Mafia", "magic", "Magic", "Magical Girls",
      "mahou_shoujo", "Mahou Shoujo", "manga", "Manga", "Mangatoon", "manhua",
      "Manhua", "manhwa", "Manhwa", "martial arts", "martial_arts",
      "Martial arts", "Martial Arts", "mature", "Mature", "mecha", "Mecha",
      "Medical", "Medicaldrama", "medieval area", "military", "Military",
      "Monster Girls", "monsters", "Monsters", "music", "Music", "mystery",
      "Mystery", "myth", "naruto", "Ninja", "nobility", "office worker",
      "office workers", "Office Workers", "Official", "One Shot", "Otome",
      "Philosophical", "Police", "politics", "Post-Apocalyptic",
      "psychological", "Psychological", "red flag", "reincarnation",
      "Reincarnation", "Reverse Harem", "romance", "Romance", "royalty",
      "Samurai", "school_life", "School life", "School_life", "School Life",
      "sci-fi", "Sci-fi", "Sci-Fi", "seinen", "Seinen", "Shota", "Shotacon",
      "shoujo", "Shoujo", "shoujo_ai", "Shoujo Ai", "shounen", "Shounen",
      "shounen_ai", "Shounen Ai", "slice_of_life", "Slice of life",
      "Slice of Life", "smut", "Smut", "sports", "Sports", "Superhero",
      "supernatural", "Supernatural", "Survival", "suspense", "Suspense",
      "system", "System", "thriller", "Thriller", "Time Travel",
      "Traditional Games", "tragedy", "Tragedy", "Vampires", "Video Games",
      "Villainess", "Virtual Reality", "War", "webtoon", "Webtoon",
      "webtoons", "wuxia", "Wuxia", "yaoi", "Yaoi", "yuri", "Yuri", "Zombies",
    ];

    return GENRES.map((g) => ({ id: g, name: g }));
  },
};

harbor.register(plugin);
