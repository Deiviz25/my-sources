// mangadot.net — Harbor MangaProvider plugin
// Compatible con la API de plugins de Harbor.
//
// El sitio usa React Router v7 con SSR/hidratación. Las rutas .data pueden
// devolver JSON o, según Cloudflare/CDN, HTML con el payload de hidratación.
// Este proveedor intenta primero JSON y después HTML/raw hydration.

const BASE_URL = "https://mangadot.net";
const API_URL = `${BASE_URL}/api`;

// Harbor documenta offsets de 48 elementos por página.
const PAGE_SIZE = 48;
const MAX_HYDRATION_SCAN = 64;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function httpText(url, timeoutMs) {
  try {
    const res = await harbor.http(url, {
      method: "GET",
      responseType: "text",
      timeoutMs,
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/json,text/plain,*/*",
      },
    });

    if (!res || !res.ok) {
      harbor.log(`HTTP ${res ? res.status : "?"} en ${url}`);
      return null;
    }

    return typeof res.body === "string" ? res.body : null;
  } catch (e) {
    harbor.log(`NETWORK ${url}: ${String(e).slice(0, 160)}`);
    return null;
  }
}

async function fetchJson(url, timeoutMs) {
  const body = await httpText(url, timeoutMs);
  if (body == null) return null;

  try {
    return JSON.parse(body);
  } catch (_) {
    harbor.log(`Respuesta no-JSON en ${url.split("?")[0]}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL/string helpers
// ---------------------------------------------------------------------------

function absoluteUrl(value) {
  if (value == null) return undefined;
  const path = String(value).trim();
  if (!path) return undefined;

  try {
    return new URL(path, BASE_URL).href;
  } catch (_) {
    return undefined;
  }
}

function buildParams(params) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) query.append(key, String(item));
      }
    } else if (value != null) {
      query.append(key, String(value));
    }
  }

  return query.toString();
}

function fixMojibake(value) {
  if (value == null) return value;
  const str = String(value);

  // Evita transformar texto normal. Solo intenta reparar el caso típico
  // UTF-8 interpretado como Latin-1 cuando aparecen caracteres sospechosos.
  if (!/[ÃÂâ]/.test(str)) return str;

  let binary = "";
  for (let i = 0; i < str.length; i++) {
    binary += String.fromCharCode(str.charCodeAt(i) & 0xff);
  }

  try {
    return decodeURIComponent(escape(binary));
  } catch (_) {
    return str;
  }
}

function firstDefined(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function asText(value) {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return undefined;
}

// ---------------------------------------------------------------------------
// React Router v7 hydration payload
// ---------------------------------------------------------------------------

// El HTML puede contener una o varias llamadas:
//   streamController.enqueue("...");
// Cada argumento es una cadena JS/JSON escapada. En lugar de usar una regex
// que se rompa en una comilla escapada, escaneamos el string carácter a carácter.
function extractEnqueuedStrings(html) {
  if (typeof html !== "string" || !html) return [];

  const marker = "streamController.enqueue(";
  const chunks = [];
  let from = 0;

  while (true) {
    const start = html.indexOf(marker, from);
    if (start < 0) break;

    let i = start + marker.length;
    while (i < html.length && /\s/.test(html[i])) i++;

    if (html[i] !== '"') {
      from = start + marker.length;
      continue;
    }

    const quoteStart = i;
    i++;
    let escaped = false;

    while (i < html.length) {
      const ch = html[i];
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        i++;
        continue;
      }
      if (ch === '"') break;
      i++;
    }

    if (i >= html.length) break;

    const literal = html.slice(quoteStart, i + 1);
    try {
      chunks.push(JSON.parse(literal));
    } catch (_) {
      // Si una llamada concreta no es JSON válido, seguimos buscando otras.
    }

    from = i + 1;
  }

  return chunks;
}

function extractHydrationPayloads(html) {
  const chunks = extractEnqueuedStrings(html);
  if (!chunks.length) return [];

  const payloads = [];
  for (const chunk of chunks) {
    const candidates = [chunk];

    // Algunos loaders entregan un JSON serializado dentro del chunk.
    if (typeof chunk === "string") {
      try {
        candidates.push(JSON.parse(chunk));
      } catch (_) {
        // texto normal, no hay problema
      }
    }

    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== null) payloads.push(candidate);
    }
  }

  // Si hay varios chunks que forman un array JSON consecutivo, intenta además
  // unir strings antes de abandonar el método.
  const stringChunks = chunks.filter((x) => typeof x === "string");
  if (stringChunks.length > 1) {
    const joined = stringChunks.join("");
    try {
      payloads.push(JSON.parse(joined));
    } catch (_) {
      // No todos los streams forman un único JSON.
    }
  }

  return payloads;
}

// React Router serializa referencias mediante índices dentro de una tabla.
function hydrate(rootIndex, table) {
  if (!Array.isArray(table) || rootIndex < 0 || rootIndex >= table.length) return null;

  const resolving = new Set();
  const cache = new Map();

  function resolve(value) {
    if (value === -5) return null;

    if (typeof value === "number" && table[value] !== undefined) {
      if (cache.has(value)) return cache.get(value);
      if (resolving.has(value)) return null;

      const entry = table[value];

      // React Router puede guardar arrays/objetos JSON como strings dentro de
      // la tabla. Recuperarlos aquí es importante para listas serializadas.
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if ((trimmed[0] === "[" && trimmed[trimmed.length - 1] === "]") ||
            (trimmed[0] === "{" && trimmed[trimmed.length - 1] === "}")) {
          try {
            const parsed = JSON.parse(trimmed);
            const resolvedJson = walk(parsed, value);
            cache.set(value, resolvedJson);
            return resolvedJson;
          } catch (_) {
            // Se trata como string normal.
          }
        }
      }

      const resolved = walk(entry, value);
      cache.set(value, resolved);
      return resolved;
    }

    return walk(value, null);
  }

  function walk(node, tableIndex) {
    if (node == null || typeof node !== "object") {
      if (typeof node === "number" && table[node] !== undefined) return resolve(node);
      return node;
    }

    if (tableIndex != null) resolving.add(tableIndex);

    let out;

    if (Array.isArray(node)) {
      out = node.map(resolve);
    } else {
      out = {};
      for (const [key, rawValue] of Object.entries(node)) {
        let realKey = key;
        if (key[0] === "_" && /^_\d+$/.test(key)) {
          const idx = Number(key.slice(1));
          if (table[idx] !== undefined && typeof table[idx] === "string") {
            realKey = table[idx];
          }
        }
        out[realKey] = resolve(rawValue);
      }
    }

    if (tableIndex != null) {
      resolving.delete(tableIndex);
      cache.set(tableIndex, out);
    }

    return out;
  }

  return resolve(rootIndex);
}

function recursivelyFindArray(root, keys, maxDepth) {
  const wanted = new Set(keys);
  const seen = new Set();

  function walk(node, depth) {
    if (node == null || depth < 0 || typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);

    if (!Array.isArray(node)) {
      for (const key of wanted) {
        if (Array.isArray(node[key]) && node[key].length) return node[key];
      }
    }

    if (depth === 0) return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth - 1);
        if (found) return found;
      }
    } else {
      for (const value of Object.values(node)) {
        const found = walk(value, depth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(root, maxDepth);
}

function recursivelyFindObject(root, predicate, maxDepth) {
  const seen = new Set();

  function walk(node, depth) {
    if (node == null || depth < 0 || typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);

    try {
      if (predicate(node)) return node;
    } catch (_) {}

    if (depth === 0) return null;

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth - 1);
        if (found) return found;
      }
    } else {
      for (const value of Object.values(node)) {
        const found = walk(value, depth - 1);
        if (found) return found;
      }
    }

    return null;
  }

  return walk(root, maxDepth);
}

function findMangaNode(root) {
  return recursivelyFindObject(
    root,
    (node) => node && node.id != null && node.title != null,
    8
  );
}

function findHydratedValue(payloads, keys) {
  for (const payload of payloads) {
    // Payload ya convertido directamente.
    if (payload && typeof payload === "object") {
      const direct = recursivelyFindArray(payload, keys, 8);
      if (direct) return direct;
    }

    // Tabla plana típica de React Router.
    if (Array.isArray(payload)) {
      const limit = Math.min(payload.length, MAX_HYDRATION_SCAN);
      for (let idx = 0; idx < limit; idx++) {
        let attempt;
        try {
          attempt = hydrate(idx, payload);
        } catch (_) {
          continue;
        }
        const found = recursivelyFindArray(attempt, keys, 7);
        if (found) return found;
      }
    }
  }

  return null;
}

function findHydratedManga(payloads) {
  for (const payload of payloads) {
    const direct = findMangaNode(payload);
    if (direct) return direct;

    if (Array.isArray(payload)) {
      const limit = Math.min(payload.length, MAX_HYDRATION_SCAN);
      for (let idx = limit - 1; idx >= 0; idx--) {
        let attempt;
        try {
          attempt = hydrate(idx, payload);
        } catch (_) {
          continue;
        }
        const found = findMangaNode(attempt);
        if (found) return found;
      }
    }
  }

  return null;
}

async function getHtmlPayloads(url) {
  const html = await httpText(url, 20000);
  if (!html) return [];

  const payloads = extractHydrationPayloads(html);
  harbor.log(`Hydration: ${payloads.length} payload(s) en ${url.split("?")[0]}`);
  return payloads;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const STATUS_MAP = {
  ongoing: "ongoing",
  Ongoing: "ongoing",
  completed: "completed",
  Completed: "completed",
  on_hiatus: "hiatus",
  hiatus: "hiatus",
  Hiatus: "hiatus",
  cancelled: "cancelled",
  canceled: "cancelled",
};

function mangaFromNode(manga) {
  if (!manga || manga.id == null || manga.title == null) return null;

  const hiatus = asText(manga.hiatus);
  const rawStatus = asText(manga.status);
  let status = STATUS_MAP[rawStatus] || rawStatus || "unknown";

  if (hiatus && hiatus.toLowerCase() !== "no" && hiatus.toLowerCase() !== "false") {
    status = "hiatus";
  }

  const genres = Array.isArray(manga.genres)
    ? manga.genres.map((g) => {
        if (typeof g === "string") return g;
        return asText(firstDefined(g, ["name", "title", "label", "genre"]));
      }).filter(Boolean)
    : undefined;

  const authors = Array.isArray(manga.authors)
    ? manga.authors.map((x) => typeof x === "string" ? x : asText(firstDefined(x, ["name", "title"]))).filter(Boolean)
    : [];

  const artists = Array.isArray(manga.artists)
    ? manga.artists.map((x) => typeof x === "string" ? x : asText(firstDefined(x, ["name", "title"]))).filter(Boolean)
    : [];

  const summary = {
    id: String(manga.id),
    title: fixMojibake(String(manga.title)),
    cover: absoluteUrl(firstDefined(manga, ["photo", "cover", "cover_url", "image", "thumbnail"])),
    description: fixMojibake(asText(firstDefined(manga, ["description", "summary", "synopsis"]))),
    status,
    genres: genres && genres.length ? genres : undefined,
    author: authors.length ? authors.join(" & ") : asText(firstDefined(manga, ["author", "writer"])),
    artist: artists.length ? artists.join(" & ") : asText(firstDefined(manga, ["artist", "illustrator"])),
    year: Number.isFinite(Number(firstDefined(manga, ["year", "release_year"])))
      ? Number(firstDefined(manga, ["year", "release_year"]))
      : undefined,
    altTitle: asText(firstDefined(manga, ["alt_title", "alternative_title", "other_title"])),
    contentRating: asText(firstDefined(manga, ["content_rating", "rating"])),
  };

  return summary;
}

function chapterFromNode(c) {
  if (!c || c.id == null) return null;

  let chapNum = firstDefined(c, [
    "chapter_number",
    "chapterNumber",
    "number",
    "chapter",
  ]);

  if (chapNum != null) chapNum = String(chapNum);
  else chapNum = null;

  const hasGroup = firstDefined(c, [
    "group_name",
    "scanlator_group",
    "translator_group",
    "group",
  ]);

  let title = asText(firstDefined(c, ["chapter_title", "title"]));
  if (!title) {
    if (firstDefined(c, ["volume_number", "volume"]) != null && chapNum != null) {
      title = `Volume ${firstDefined(c, ["volume_number", "volume"])} Chapter ${chapNum}`;
    } else if (chapNum != null) {
      title = `Chapter ${chapNum}`;
    } else {
      title = "Chapter";
    }
  }

  const rawLanguage = asText(firstDefined(c, ["language", "lang", "language_code"]));
  const language = rawLanguage ? rawLanguage.toLowerCase().slice(0, 10) : "en";

  const pageCount = Number(firstDefined(c, ["page_count", "pages", "image_count", "number_of_pages"]));

  const sourceSuffix = hasGroup ? "?source=user" : "";

  return {
    id: `${String(c.id)}${sourceSuffix}`,
    chapter: chapNum,
    title: fixMojibake(title),
    volume: firstDefined(c, ["volume_number", "volume"]) != null
      ? String(firstDefined(c, ["volume_number", "volume"]))
      : null,
    pages: Number.isFinite(pageCount) && pageCount >= 0 ? Math.floor(pageCount) : 0,
    language,
    publishAt: asText(firstDefined(c, ["date_added", "upload_date", "created_at", "published_at", "date"])),
    group: hasGroup != null ? String(hasGroup) : undefined,
  };
}

function imageUrlFromNode(img) {
  if (typeof img === "string") return absoluteUrl(img);
  if (!img || typeof img !== "object") return undefined;

  return absoluteUrl(firstDefined(img, [
    "url",
    "image",
    "src",
    "link",
    "image_url",
    "file_url",
  ]));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const plugin = {
  id: "mangadot",
  name: "Mangadot.net",

  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset, "tracked");

    const page = Math.floor(Math.max(0, Number(offset) || 0) / PAGE_SIZE) + 1;
    const url = `${BASE_URL}/view-all/most-tracked.data?adult=1&page=${page}&perPage=${PAGE_SIZE}&_routes=pages/ViewAllPage`;

    let json = await fetchJson(url, 20000);
    if (json) {
      const list = findHydratedValue([json], ["manga_list", "results"]);
      if (list) return list.map(mangaFromNode).filter(Boolean);
    }

    // Fallback: HTML de la vista.
    const payloads = await getHtmlPayloads(
      `${BASE_URL}/view-all/most-tracked?adult=1&page=${page}&perPage=${PAGE_SIZE}`
    );
    const list = findHydratedValue(payloads, ["manga_list", "results"]);
    return Array.isArray(list) ? list.map(mangaFromNode).filter(Boolean) : [];
  },

  async _byGenre(tagId, offset, sortBy) {
    const page = Math.floor(Math.max(0, Number(offset) || 0) / PAGE_SIZE) + 1;
    const params = {
      genre: [tagId],
      adult: 1,
      page,
      perPage: PAGE_SIZE,
      _routes: "pages/SearchPage",
    };
    if (sortBy) params.sortBy = sortBy;

    const qs = buildParams(params);
    let json = await fetchJson(`${BASE_URL}/search.data?${qs}`, 20000);

    if (json) {
      const list = findHydratedValue([json], ["results", "manga_list"]);
      if (list) return list.map(mangaFromNode).filter(Boolean);
    }

    const payloads = await getHtmlPayloads(`${BASE_URL}/search?${qs}`);
    const list = findHydratedValue(payloads, ["results", "manga_list"]);
    return Array.isArray(list) ? list.map(mangaFromNode).filter(Boolean) : [];
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);

    const page = Math.floor(Math.max(0, Number(offset) || 0) / PAGE_SIZE) + 1;
    const params = {
      adult: 1,
      page,
      perPage: PAGE_SIZE,
      _routes: "pages/SearchPage",
    };

    if (query) params.search = query;
    if (tagId) params.genre = [tagId];

    const qs = buildParams(params);
    let json = await fetchJson(`${BASE_URL}/search.data?${qs}`, 20000);

    if (json) {
      const list = findHydratedValue([json], ["results", "manga_list"]);
      if (list) return list.map(mangaFromNode).filter(Boolean);
    }

    const payloads = await getHtmlPayloads(`${BASE_URL}/search?${qs}`);
    const list = findHydratedValue(payloads, ["results", "manga_list"]);
    return Array.isArray(list) ? list.map(mangaFromNode).filter(Boolean) : [];
  },

  async detail(id) {
    const safeId = encodeURIComponent(String(id));
    const dataUrl = `${BASE_URL}/manga/${safeId}.data?_routes=pages/MangaDetailPage`;

    let json = await fetchJson(dataUrl, 20000);
    let mangaNode = null;

    if (json) {
      mangaNode = findHydratedManga([json]);
      // También soporta respuestas convencionales {data: {...}}, etc.
      if (!mangaNode && json && typeof json === "object") {
        mangaNode = findMangaNode(json.data || json.manga || json.result || json.content);
      }
    }

    if (!mangaNode) {
      const payloads = await getHtmlPayloads(`${BASE_URL}/manga/${safeId}`);
      mangaNode = findHydratedManga(payloads);
    }

    if (!mangaNode) {
      harbor.log(`No se encontró manga válido: ${id}`);
      return null;
    }

    const base = mangaFromNode(mangaNode);
    if (!base) return null;

    const chapters = await plugin.chapters(id);
    if (chapters.length) {
      const nums = chapters
        .map((c) => Number(c.chapter))
        .filter((n) => Number.isFinite(n));

      if (nums.length) base.lastChapter = String(Math.max(...nums));
      else base.lastChapter = chapters[chapters.length - 1].chapter || undefined;
    }

    return base;
  },

  async chapters(id) {
    const rawId = String(id);
    const url = `${API_URL}/manga/${encodeURIComponent(rawId)}/chapters/list`;

    let json = await fetchJson(url, 25000);
    let chaptersData = null;

    if (json) {
      if (Array.isArray(json)) chaptersData = json;
      else if (Array.isArray(json.data)) chaptersData = json.data;
      else if (Array.isArray(json.chapters)) chaptersData = json.chapters;
      else chaptersData = findHydratedValue([json], ["chapters", "results", "data"]);
    }

    // Fallback fuerte: página del manga.
    if (!Array.isArray(chaptersData) || !chaptersData.length) {
      const payloads = await getHtmlPayloads(`${BASE_URL}/manga/${encodeURIComponent(rawId)}`);
      chaptersData = findHydratedValue(payloads, ["chapters", "chapter_list", "results"]);
    }

    if (!Array.isArray(chaptersData)) return [];

    const chapters = chaptersData
      .map(chapterFromNode)
      .filter(Boolean);

    chapters.sort((a, b) => {
      const av = Number(a.chapter);
      const bv = Number(b.chapter);
      if (Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
      if (Number.isFinite(av)) return -1;
      if (Number.isFinite(bv)) return 1;
      return String(a.chapter || "").localeCompare(String(b.chapter || ""), undefined, { numeric: true });
    });

    return chapters;
  },

  async pageUrls(chapterId) {
    const original = String(chapterId);
    const isUserUpload = original.includes("?source=user");
    const rawId = isUserUpload ? original.split("?")[0] : original;

    const endpoints = isUserUpload
      ? [
          `${API_URL}/uploads/${encodeURIComponent(rawId)}/images`,
        ]
      : [
          `${API_URL}/chapters/${encodeURIComponent(rawId)}/images`,
        ];

    let images = null;

    for (const endpoint of endpoints) {
      const json = await fetchJson(endpoint, 30000);
      if (!json) continue;

      if (Array.isArray(json)) {
        images = json;
      } else if (Array.isArray(json.images)) {
        images = json.images;
      } else if (Array.isArray(json.pages)) {
        images = json.pages;
      } else if (Array.isArray(json.data)) {
        images = json.data;
      } else {
        images = findHydratedValue([json], ["images", "pages"]);
      }

      if (Array.isArray(images) && images.length) break;
    }

    // Fallback HTML del lector.
    if (!Array.isArray(images) || !images.length) {
      const payloads = await getHtmlPayloads(`${BASE_URL}/chapter/${encodeURIComponent(rawId)}`);
      images = findHydratedValue(payloads, ["images", "pages"]);
    }

    if (!Array.isArray(images)) return [];

    return images
      .map(imageUrlFromNode)
      .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  },

  async tags() {
    // Lista estable de géneros conocidos por el sitio. Se mantienen como IDs
    // de búsqueda, porque SearchPage acepta genre=<valor>.
    const GENRES = [
      "Academy", "Acting", "action", "Action", "Adeventure", "adult", "Adult",
      "adventure", "Adventure", "Aliens", "and slice-of-life", "Animals",
      "Anthology", "Avant Garde", "award_winning", "Award winning", "Award Winning",
      "Based on an Anime", "boys' love", "boys_love", "Boys Love", "Boys' Love", "Bully",
      "business", "child abuse", "child neglect", "comedy", "Comedy", "Comic", "Cooking",
      "Crime", "Crossdressing", "Delinquents", "Demons", "difficult childhood", "doujinshi",
      "Doujinshi", "drama", "Drama", "ecchi", "Ecchi", "erotica", "Erotica", "fantasy",
      "Fantasy", "female protagonist", "femdom", "Fight", "Fluff", "gender_bender",
      "Gender bender", "Gender Bender", "Genderswap", "Genius MC", "Ghosts", "girls_love",
      "Girls love", "Girls Love", "Girls' Love", "gore", "Gourmet", "Gyaru", "harem",
      "Harem", "hentai", "Hentai", "historical", "Historical", "horror", "Horror", "Hunters",
      "Idol", "Idols", "Incest", "Isekai", "josei", "Josei", "Loli", "Lolicon", "Mafia",
      "magic", "Magic", "Magical Girls", "mahou_shoujo", "Mahou Shoujo", "manga", "Manga",
      "Mangatoon", "manhua", "Manhua", "manhwa", "Manhwa", "martial arts", "martial_arts",
      "Martial arts", "Martial Arts", "mature", "Mature", "mecha", "Mecha", "Medical",
      "Medicaldrama", "medieval area", "military", "Military", "Monster Girls", "monsters",
      "Monsters", "music", "Music", "mystery", "Mystery", "myth", "naruto", "Ninja",
      "nobility", "office worker", "office workers", "Office Workers", "Official", "One Shot",
      "Otome", "Philosophical", "Police", "politics", "Post-Apocalyptic", "psychological",
      "Psychological", "red flag", "reincarnation", "Reincarnation", "Reverse Harem", "romance",
      "Romance", "royalty", "Samurai", "school_life", "School life", "School_life", "School Life",
      "sci-fi", "Sci-fi", "Sci-Fi", "seinen", "Seinen", "Shota", "Shotacon", "shoujo", "Shoujo",
      "shoujo_ai", "Shoujo Ai", "shounen", "Shounen", "shounen_ai", "Shounen Ai", "slice_of_life",
      "Slice of life", "Slice of Life", "smut", "Smut", "sports", "Sports", "Superhero",
      "supernatural", "Supernatural", "Survival", "suspense", "Suspense", "system", "System",
      "thriller", "Thriller", "Time Travel", "Traditional Games", "tragedy", "Tragedy", "Vampires",
      "Video Games", "Villainess", "Virtual Reality", "War", "webtoon", "Webtoon", "webtoons",
      "wuxia", "Wuxia", "yaoi", "Yaoi", "yuri", "Yuri", "Zombies",
    ];

    return GENRES.map((name) => ({ id: name, name }));
  },
};

harbor.register(plugin);
