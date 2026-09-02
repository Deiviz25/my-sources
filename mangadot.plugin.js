// mangadot.net — Harbor MangaProvider plugin
//
// Portado directamente del código fuente real de la extensión Mangayomi/Tachiyomi
// para mangadot.net (que el usuario proporcionó descompilada del .apk). Todos los
// endpoints, parámetros y la lógica de "hydrate" vienen confirmados de ese código,
// no son heurísticas inventadas.
//
// El sitio es una app React Router v7 (SSR). Las páginas normales devuelven HTML,
// pero añadiendo ".data" a la ruta (y el query param _routes) el servidor devuelve
// el payload de hidratación en un formato compacto: un array plano donde muchos
// valores son índices que apuntan a otras posiciones del mismo array (para
// deduplicar objetos repetidos). hydrate() reconstruye el árbol real a partir de
// ese formato — es el mismo mecanismo que produce los <script>...streamController
// .enqueue(...)</script> que se ven en el HTML normal, solo que en .data viene ya
// aislado y sin el resto de la página.
//
// Endpoints confirmados:
//   - Populares:   GET {baseUrl}/view-all/most-tracked.data?adult=1&page=N&_routes=pages/ViewAllPage
//   - Recientes:   GET {baseUrl}/view-all/latest-updates.data?adult=1&page=N&_routes=pages/ViewAllPage
//   - Búsqueda:    GET {baseUrl}/search.data?search=...&adult=1&page=N&perPage=100&_routes=pages/SearchPage
//   - Ficha:       GET {baseUrl}/manga/{id}.data?_routes=pages/MangaDetailPage
//   - Capítulos:   GET {baseUrl}/api/manga/{id}/chapters/list
//   - Páginas:     GET {baseUrl}/api/chapters/{chapterId}/images
//                  (o /api/uploads/{chapterId}/images si el capítulo tiene group_name,
//                   es decir viene marcado con "?source=user" en la URL original)
//
// ⚠️ El manifiesto original marca "hasCloudflare": true y trae de fábrica un
// "proxy-use" activado por defecto (para saltar un challenge de Cloudflare vía un
// proxy externo). Aquí se hacen peticiones directas con harbor.http; si el sitio
// devuelve un challenge/captcha en vez de JSON, ese es el motivo — no hay forma de
// resolverlo sin un proxy o navegador headless externo.

const BASE_URL = "https://mangadot.net";
const API_URL = `${BASE_URL}/api`;
const PAGE_SIZE = 100; // "perPage" usado por la extensión original (this.total = 100)

// --- helpers -----------------------------------------------------------

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function fetchJson(url) {
  // Nota: harbor.http elimina "referer" aunque lo mandemos, así que no lo incluimos.
  // "user-agent" es la única cabecera de camuflaje de navegador que sí se respeta.
  try {
    const res = await harbor.http(url, {
      responseType: "text",
      headers: {
        "user-agent": BROWSER_UA,
        accept: "application/json, text/plain, */*",
      },
    });
    if (!res.ok) {
      harbor.log(`mangadot: HTTP ${res.status} en ${url} — body:`, String(res.body).slice(0, 300));
      return null;
    }
    try {
      return JSON.parse(res.body);
    } catch (e) {
      // No era JSON — casi seguro un challenge de Cloudflare u otra página HTML.
      harbor.log("mangadot: respuesta no-JSON en", url, "— body:", String(res.body).slice(0, 300));
      return null;
    }
  } catch (e) {
    harbor.log("mangadot: excepción de red en", url, "—", String(e));
    return null;
  }
}

function absoluteUrl(path) {
  if (!path) return undefined;
  return path.startsWith("http") ? path : `${BASE_URL}${path}`;
}

// El sitio mete UTF-8 mal decodificado como Latin-1 en algunos campos (títulos con
// caracteres no-ASCII). Esto revierte ese doble-encoding, tal cual lo hace la
// extensión original.
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

// Reconstruye el árbol real a partir del payload de hidratación de React Router.
// Copiado tal cual de la extensión original.
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
          // no era JSON, se trata como string normal más abajo
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

// --- MangaProvider -------------------------------------------------------

const plugin = {
  id: "mangadot",
  name: "Mangadotnet",

  // offset se traduce a página (1-based) usando PAGE_SIZE como tamaño de página,
  // igual que hace la extensión original con this.total = 100.
  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset, "tracked");

    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const json = await fetchJson(
      `${BASE_URL}/view-all/most-tracked.data?adult=1&page=${page}&_routes=pages/ViewAllPage`,
    );
    if (!json) return [];

    // 7 = {manga_list, pagination} — índice confirmado en el código fuente original.
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

    // 4 = {allGenres,displayMode,filters,page,pagination,query,results}
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
    const json = await fetchJson(
      `${BASE_URL}/manga/${encodeURIComponent(id)}.data?_routes=pages/MangaDetailPage`,
    );
    if (!json) return null;

    // 8 es el índice del nodo "manga" dentro del payload de MangaDetailPage,
    // confirmado en el código fuente original (getDetail -> hydrate(8, ...)).
    const mangaNode = hydrate(8, json);
    if (!mangaNode) return null;

    const base = mangaFromNode(mangaNode);
    const chapters = await plugin.chapters(id);
    base.lastChapter = chapters.length ? chapters[chapters.length - 1].chapter : undefined;
    return base;
  },

  // El endpoint ya devuelve el array completo y ordenado por fecha (no hay
  // paginación en la extensión original: hace una sola petición y ya está).
  async chapters(id) {
    const json = await fetchJson(`${API_URL}/manga/${encodeURIComponent(id)}/chapters/list`);
    if (!Array.isArray(json)) return [];

    const chapters = json
      .map((c) => {
        if (c == null || c.id == null) return null;
        const chapNum = c.chapter_number != null ? String(c.chapter_number) : "0";
        const hasGroup = c.group_name && String(c.group_name).length;
        const title =
          c.chapter_title && String(c.chapter_title).length
            ? fixMojibake(c.chapter_title)
            : `${c.volume_number ? "Volume " + c.volume_number + " " : ""}Chapter ${chapNum}`;

        return {
          // El sufijo "?source=user" indica que las páginas viven bajo /api/uploads/
          // en vez de /api/chapters/ — lo codificamos en el propio id para que
          // pageUrls() sepa qué endpoint usar sin peticiones extra.
          id: hasGroup ? `${c.id}?source=user` : String(c.id),
          chapter: chapNum,
          title,
          pages: 0,
          language: "en",
          publishAt: c.date_added || undefined,
          scanlator: hasGroup ? String(c.group_name) : "Official",
        };
      })
      .filter(Boolean);

    chapters.sort((a, b) => parseFloat(a.chapter) - parseFloat(b.chapter));
    return chapters;
  },

  async pageUrls(chapterId) {
    const isUserUpload = chapterId.includes("?source=user");
    const rawId = isUserUpload ? chapterId.split("?")[0] : chapterId;
    const endpoint = isUserUpload
      ? `${API_URL}/uploads/${encodeURIComponent(rawId)}/images`
      : `${API_URL}/chapters/${encodeURIComponent(rawId)}/images`;

    const json = await fetchJson(endpoint);
    if (!json || !Array.isArray(json.images)) return [];

    return json.images.map((img) => absoluteUrl(img.url)).filter(Boolean);
  },

  // Lista de géneros confirmada del getFilterList() original (GenreFilter).
  // El sitio trae duplicados con distinta capitalización (p.ej. "action"/"Action")
  // como valores de filtro independientes — se preservan tal cual, ya que son
  // valores de query reales y no un error de scraping.
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
