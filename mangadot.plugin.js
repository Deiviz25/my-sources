// MangaDot.net — Harbor MangaProvider
//
// API pública utilizada:
//   GET /api/search?search=...&sortBy=...&page=N[&genres=...]
//   GET /manga/{id}.data?_routes=pages/MangaDetailPage   (ficha, formato pointer-table)
//   GET /api/manga/{id}/chapters/list
//   GET /api/chapters/{chapter_id}/images
//
// MIT attribution:
// Adaptación para Harbor basada en la estructura pública de MangaDot.
// MangaDotnet-Scraper: https://github.com/jianmingyong/Mangadotnet-Scraper
// Copyright (c) 2026 jianmingyong — Licensed under the MIT License.

const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 20;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function absoluteUrl(value) {
  if (!value) return undefined;
  try {
    return new URL(String(value), BASE_URL).toString();
  } catch {
    return undefined;
  }
}

function text(value) {
  if (value === null || value === undefined) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function numberOrUndefined(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeStatus(value) {
  const s = String(value || "").toLowerCase();
  if (s.includes("ongoing")) return "ongoing";
  if (s.includes("complet")) return "completed";
  if (s.includes("hiatus")) return "hiatus";
  return text(value);
}

// ---------------------------------------------------------------------------
// HTTP (harbor.http). Harbor elimina el encabezado Referer, así que no se envía.
// ---------------------------------------------------------------------------

async function httpJson(url) {
  try {
    const result = await harbor.http(url, {
      responseType: "json",
      headers: {
        Accept: "application/json,text/plain,*/*",
        "user-agent": UA,
      },
    });

    if (result === null || result === undefined) {
      harbor.log(`MangaDot JSON vacío: ${url}`);
      return null;
    }

    return result;
  } catch (e) {
    harbor.log(`MangaDot JSON error: ${url} ${String(e)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manga
// ---------------------------------------------------------------------------

/* Devuelve null si no hay título real: Harbor descartaría la fila de todos
 * modos, y así evitamos mostrar nombres genéricos como "Manga 123". */
function mangaToSummary(item) {
  if (!item || item.id === undefined || item.id === null) return null;

  const title = text(item.title) || text(item.name);
  if (!title) {
    harbor.log(`MangaDot: manga ${item.id} sin título, se omite`);
    return null;
  }

  return {
    id: String(item.id),
    title,
    cover: absoluteUrl(item.photo || item.cover || item.cover_url || item.thumbnail),
    year: numberOrUndefined(item.year),
    status: normalizeStatus(item.status),
    contentRating: text(item.content_rating || item.contentRating),
    lastChapter:
      item.latest_chapter_number !== null && item.latest_chapter_number !== undefined
        ? String(item.latest_chapter_number)
        : undefined,
  };
}

function extractMangaList(json) {
  if (!json) return [];
  if (Array.isArray(json.manga_list)) return json.manga_list;
  if (json.data && Array.isArray(json.data.manga_list)) return json.data.manga_list;
  if (Array.isArray(json.results)) return json.results;
  return [];
}

function mapMangaList(json) {
  return extractMangaList(json).map(mangaToSummary).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Listado y búsqueda
// ---------------------------------------------------------------------------

async function searchApi({ query = "", page = 1, sortBy = "relevance", genre }) {
  const params = new URLSearchParams();
  if (query) params.set("search", query);
  if (genre) params.set("genres", genre);
  params.set("sortBy", sortBy);
  params.set("page", String(page));

  return httpJson(`${BASE_URL}/api/search?${params.toString()}`);
}

function pageFromOffset(offset) {
  return Math.floor(Number(offset || 0) / PAGE_SIZE) + 1;
}

// ---------------------------------------------------------------------------
// Detalle: respuesta .data de Remix (pointer-table)
// ---------------------------------------------------------------------------

/* En el formato pointer-table, cada valor del array es un índice a otra
 * posición, las claves "_N" apuntan a nombres en la tabla, y los números
 * negativos son valores especiales (undefined, NaN…) que se tratan como null.
 * Se memoiza y se corta si aparece un ciclo. */
function resolvePointerTable(table) {
  if (!Array.isArray(table)) return table;

  const memo = new Map();
  const inProgress = new Set();

  function resolveKey(key) {
    if (key.startsWith("_")) {
      const idx = Number(key.slice(1));
      if (Number.isInteger(idx) && idx >= 0 && idx < table.length) {
        return String(table[idx]);
      }
    }
    return key;
  }

  function resolve(index) {
    if (!Number.isInteger(index) || index < 0 || index >= table.length) return null;
    if (memo.has(index)) return memo.get(index);
    if (inProgress.has(index)) return null; // ciclo

    inProgress.add(index);
    const raw = table[index];
    let out;

    if (raw === null || typeof raw !== "object") {
      out = raw;
    } else if (Array.isArray(raw)) {
      out = raw.map((item) => (typeof item === "number" ? resolve(item) : item));
    } else {
      out = {};
      for (const [key, val] of Object.entries(raw)) {
        out[resolveKey(key)] = typeof val === "number" ? resolve(val) : val;
      }
    }

    inProgress.delete(index);
    memo.set(index, out);
    return out;
  }

  return resolve(0);
}

function extractDetailData(json) {
  if (!json) return null;

  if (Array.isArray(json)) {
    const resolved = resolvePointerTable(json);
    return resolved?.["pages/MangaDetailPage"]?.data ?? resolved;
  }

  return json["pages/MangaDetailPage"]?.data ?? json;
}

function extractMangaFromDetail(data, id) {
  if (!data) return null;

  const manga = data.manga || data.payload?.manga || data.payload?.manga_detail || (data.id ? data : null);
  if (!manga) return null;

  const summary = mangaToSummary({ ...manga, id: manga.id ?? id });
  if (!summary) return null;

  const description = text(manga.description || manga.synopsis || manga.summary);
  if (description) summary.description = description;

  const rawAuthor = manga.author ?? manga.author_name ?? manga.authors;
  const author = Array.isArray(rawAuthor)
    ? rawAuthor.map(text).filter(Boolean).join(", ")
    : text(rawAuthor);
  if (author) summary.author = author;

  const altTitles = [];
  for (const source of [manga.alt_titles, manga.alternative_titles]) {
    if (Array.isArray(source)) altTitles.push(...source.map(text).filter(Boolean));
  }
  for (const single of [manga.alt_title, manga.alternative_title]) {
    if (typeof single === "string" && text(single)) altTitles.push(text(single));
  }
  if (altTitles.length) summary.altTitle = [...new Set(altTitles)].join(", ");

  return summary;
}

async function getMangaDetail(id) {
  const url =
    `${BASE_URL}/manga/${encodeURIComponent(id)}.data` +
    `?_routes=pages/MangaDetailPage`;
  return httpJson(url);
}

// ---------------------------------------------------------------------------
// Capítulos
// ---------------------------------------------------------------------------

async function getChaptersRaw(id) {
  const json = await httpJson(
    `${BASE_URL}/api/manga/${encodeURIComponent(id)}/chapters/list`
  );
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.chapters)) return json.chapters;
  if (Array.isArray(json.data?.chapters)) return json.data.chapters;
  return [];
}

function chapterToHarbor(item) {
  if (!item || item.id === undefined || item.id === null) return null;

  const chapterNumber = item.chapter_number !== undefined ? item.chapter_number : item.chapter;

  return {
    id: String(item.id),
    chapter:
      chapterNumber === null || chapterNumber === undefined ? null : String(chapterNumber),
    title: text(item.title) || text(item.chapter_title) || text(item.name),
    volume:
      item.volume !== undefined && item.volume !== null ? String(item.volume) : null,
    pages: numberOrUndefined(item.page_count || item.pages) || 0,
    language: text(item.language) || text(item.lang) || "en",
    group: text(item.scanlator_name) || text(item.group) || text(item.scanlator),
    publishAt: text(item.date_added) || text(item.publish_at) || text(item.published_at),
  };
}

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------

async function getChapterImages(chapterId) {
  const json = await httpJson(
    `${BASE_URL}/api/chapters/${encodeURIComponent(chapterId)}/images`
  );
  if (!json) return [];

  let images = [];
  if (Array.isArray(json.images)) images = json.images;
  else if (Array.isArray(json.data?.images)) images = json.data.images;
  else if (Array.isArray(json)) images = json;

  return images
    .map((image) => {
      if (typeof image === "string") return absoluteUrl(image);
      if (!image || typeof image !== "object") return undefined;
      return absoluteUrl(image.url || image.image || image.src);
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Géneros. Se omiten las etiquetas adultas porque el repo declara nsfw: false.
// ---------------------------------------------------------------------------

const GENRES = [
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Historical", "Horror",
  "Mystery", "Romance", "Sci-Fi", "School Life", "Shounen", "Shoujo", "Seinen",
  "Josei", "Slice of Life", "Sports", "Supernatural", "Thriller", "Psychological",
  "Isekai", "Martial Arts", "Demons", "Magic", "Mecha", "Military", "Music",
  "Gyaru", "Vampires", "Survival", "Tragedy", "Boys' Love", "Girls' Love",
];

// ---------------------------------------------------------------------------
// MangaProvider
// ---------------------------------------------------------------------------

const plugin = {
  id: "mangadotnet",
  name: "MangaDotNet",

  async popular(offset, tagId) {
    const json = await searchApi({
      page: pageFromOffset(offset),
      sortBy: "views",
      genre: tagId,
    });
    return mapMangaList(json).slice(0, PAGE_SIZE);
  },

  async search(query, offset /*, tagId */) {
    // La búsqueda de MangaDot no combina bien término y género,
    // así que tagId se ignora aquí.
    const json = await searchApi({
      query: String(query || "").trim(),
      page: pageFromOffset(offset),
      sortBy: "relevance",
    });
    return mapMangaList(json).slice(0, PAGE_SIZE);
  },

  async detail(id) {
    // Ficha y capítulos en paralelo para no superar el límite de 20 s.
    const [detailJson, chaptersRaw] = await Promise.all([
      getMangaDetail(id),
      getChaptersRaw(id),
    ]);

    const data = extractDetailData(detailJson);
    const result = extractMangaFromDetail(data, id);

    if (!result) {
      harbor.log(`MangaDot detail: no se pudo leer la ficha ${id}`);
      return null;
    }

    if (!result.lastChapter) {
      let latest = null;
      for (const ch of chaptersRaw) {
        const value = Number(ch.chapter_number ?? ch.chapter);
        if (Number.isFinite(value) && (latest === null || value > latest)) latest = value;
      }
      if (latest !== null) result.lastChapter = String(latest);
    }

    return result;
  },

  async chapters(id) {
    const chapters = (await getChaptersRaw(id)).map(chapterToHarbor).filter(Boolean);

    chapters.sort((a, b) => {
      const na = Number(a.chapter);
      const nb = Number(b.chapter);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a.chapter || "").localeCompare(String(b.chapter || ""), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

    return chapters;
  },

  async pageUrls(chapterId) {
    return getChapterImages(chapterId);
  },

  async tags() {
    return GENRES.map((name) => ({ id: name, name, group: "Genre" }));
  },
};

harbor.register(plugin);
