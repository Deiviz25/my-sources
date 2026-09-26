// MangaDot.net — Harbor MangaProvider
//
// API pública utilizada:
//   GET /api/search?search=...&sortBy=relevance&page=N
//   GET /api/manga/{id}/chapters/list
//   GET /api/chapters/{chapter_id}/images
//
// La API devuelve manga_list/pagination y los capítulos directamente.
// Harbor solo necesita transformar esos datos a MangaProvider.
//
// MIT attribution:
// Adaptación para Harbor basada en la estructura pública de MangaDot.
// MangaDotnet-Scraper:
// https://github.com/jianmingyong/Mangadotnet-Scraper
//
// Copyright (c) 2026 jianmingyong
// Licensed under the MIT License.

const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 20;


// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function absoluteUrl(value) {
  if (!value) return undefined;

  try {
    return new URL(String(value), BASE_URL).toString();
  } catch (e) {
    return undefined;
  }
}


function text(value) {
  if (value === null || value === undefined) return undefined;

  const result = String(value).trim();

  return result || undefined;
}


function numberOrUndefined(value) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : undefined;
}


function normalizeStatus(value) {
  const s = String(value || "").toLowerCase();

  if (s.includes("ongoing")) return "ongoing";
  if (s.includes("completed")) return "completed";
  if (s.includes("complete")) return "completed";
  if (s.includes("hiatus")) return "hiatus";

  return text(value);
}


function normalizeChapter(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return String(value);
}


// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function httpText(url) {
  try {
    const res = await harbor.http(url, {
      responseType: "text",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        Referer: `${BASE_URL}/`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
      },
    });

    if (!res || !res.ok) {
      harbor.log("MangaDot HTTP error:", url, res ? res.status : "no response");
      return null;
    }

    return res.body;
  } catch (e) {
    harbor.log("MangaDot HTTP exception:", url, String(e));
    return null;
  }
}


async function httpJson(url) {
  try {
    const result = await harbor.http(url, {
      responseType: "json",
      headers: {
        Accept: "application/json,text/plain,*/*",
        Referer: `${BASE_URL}/`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36",
      },
    });

    if (result === null || result === undefined) {
      harbor.log("MangaDot JSON vacío:", url);
      return null;
    }

    return result;
  } catch (e) {
    harbor.log("MangaDot JSON exception:", url, String(e));
    return null;
  }
}


// ---------------------------------------------------------------------------
// Manga
// ---------------------------------------------------------------------------

function mangaToSummary(item) {
  if (!item || item.id === undefined || item.id === null) {
    return null;
  }

  const id = String(item.id);

  const title =
    text(item.title) ||
    text(item.name) ||
    `Manga ${id}`;

  const summary = {
    id,
    title,

    cover: absoluteUrl(
      item.photo ||
      item.cover ||
      item.cover_url ||
      item.thumbnail
    ),

    year: numberOrUndefined(item.year),

    status: normalizeStatus(item.status),

    contentRating: text(
      item.content_rating ||
      item.contentRating
    ),

    lastChapter:
      item.latest_chapter_number !== null &&
      item.latest_chapter_number !== undefined
        ? String(item.latest_chapter_number)
        : undefined,
  };

  return summary;
}


// ---------------------------------------------------------------------------
// Search / listado
// ---------------------------------------------------------------------------

async function searchApi(query, page, sortBy) {
  const params = new URLSearchParams();

  if (query) {
    params.set("search", query);
  }

  params.set("sortBy", sortBy || "relevance");
  params.set("page", String(page));

  const url =
    `${BASE_URL}/api/search?${params.toString()}`;

  harbor.log("MangaDot search:", url);

  return await httpJson(url);
}


function extractMangaList(json) {
  if (!json) return [];

  if (Array.isArray(json.manga_list)) {
    return json.manga_list;
  }

  if (
    json.data &&
    Array.isArray(json.data.manga_list)
  ) {
    return json.data.manga_list;
  }

  if (
    json.results &&
    Array.isArray(json.results)
  ) {
    return json.results;
  }

  return [];
}


function mapMangaList(json) {
  return extractMangaList(json)
    .map(mangaToSummary)
    .filter(Boolean);
}


// ---------------------------------------------------------------------------
// Detalle
// ---------------------------------------------------------------------------

async function getMangaDetail(id) {
  // Endpoint .data utilizado por MangaDot para MangaDetailPage.
  const url =
    `${BASE_URL}/manga/${encodeURIComponent(id)}.data` +
    `?_routes=pages/MangaDetailPage`;

  harbor.log("MangaDot detail:", url);

  const json = await httpJson(url);

  if (!json) {
    return null;
  }

  return json;
}


// ---------------------------------------------------------------------------
// Resolver pointer-table usada por las respuestas .data de MangaDot.
// ---------------------------------------------------------------------------

function resolvePointerTable(value) {
  if (!Array.isArray(value)) {
    return value;
  }

  const table = value;

  function resolve(index) {
    if (
      typeof index !== "number" ||
      index < 0 ||
      index >= table.length
    ) {
      return null;
    }

    const value = table[index];

    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== "object") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === "number") {
          return item >= 0 ? resolve(item) : null;
        }

        return item;
      });
    }

    const result = {};

    for (const [key, rawValue] of Object.entries(value)) {
      let outputKey = key;

      if (key.startsWith("_")) {
        const keyIndex = Number(key.slice(1));

        if (
          Number.isInteger(keyIndex) &&
          keyIndex >= 0 &&
          keyIndex < table.length
        ) {
          outputKey = String(table[keyIndex]);
        }
      }

      if (
        typeof rawValue === "number" &&
        rawValue >= 0
      ) {
        result[outputKey] = resolve(rawValue);
      } else {
        result[outputKey] = null;
      }
    }

    return result;
  }

  return resolve(0);
}


function extractDetailData(json) {
  if (!json) return null;

  // Algunas respuestas pueden venir ya resueltas.
  if (
    json["pages/MangaDetailPage"] &&
    json["pages/MangaDetailPage"].data
  ) {
    return json["pages/MangaDetailPage"].data;
  }

  // Pointer table.
  if (Array.isArray(json)) {
    const resolved = resolvePointerTable(json);

    if (
      resolved &&
      resolved["pages/MangaDetailPage"] &&
      resolved["pages/MangaDetailPage"].data
    ) {
      return resolved["pages/MangaDetailPage"].data;
    }

    return resolved;
  }

  return json;
}


function extractMangaFromDetail(data, id) {
  if (!data) return null;

  let manga = null;

  if (data.manga) {
    manga = data.manga;
  } else if (
    data.payload &&
    data.payload.manga
  ) {
    manga = data.payload.manga;
  } else if (
    data.payload &&
    data.payload.manga_detail
  ) {
    manga = data.payload.manga_detail;
  } else if (data.id) {
    manga = data;
  }

  if (!manga) {
    return null;
  }

  const item = {
    ...manga,
    id: manga.id !== undefined
      ? manga.id
      : id,
  };

  const summary = mangaToSummary(item);

  if (!summary) {
    return null;
  }

  const description =
    text(
      manga.description ||
      manga.synopsis ||
      manga.summary
    );

  const author =
    text(
      manga.author ||
      manga.author_name ||
      manga.authors
    );

  const altTitles = [];

  if (Array.isArray(manga.alt_titles)) {
    altTitles.push(
      ...manga.alt_titles
        .map(text)
        .filter(Boolean)
    );
  }

  if (Array.isArray(manga.alternative_titles)) {
    altTitles.push(
      ...manga.alternative_titles
        .map(text)
        .filter(Boolean)
    );
  }

  if (typeof manga.alt_title === "string") {
    altTitles.push(manga.alt_title);
  }

  if (typeof manga.alternative_title === "string") {
    altTitles.push(manga.alternative_title);
  }

  if (altTitles.length) {
    summary.altTitle = [
      ...new Set(altTitles),
    ].join(", ");
  }

  if (description) {
    summary.description = description;
  }

  if (author) {
    summary.author = Array.isArray(author)
      ? author.join(", ")
      : author;
  }

  return summary;
}


// ---------------------------------------------------------------------------
// Capítulos
// ---------------------------------------------------------------------------

async function getChaptersRaw(id) {
  const url =
    `${BASE_URL}/api/manga/${encodeURIComponent(id)}/chapters/list`;

  harbor.log("MangaDot chapters:", url);

  const json = await httpJson(url);

  if (!json) {
    return [];
  }

  if (Array.isArray(json)) {
    return json;
  }

  if (Array.isArray(json.chapters)) {
    return json.chapters;
  }

  if (
    json.data &&
    Array.isArray(json.data.chapters)
  ) {
    return json.data.chapters;
  }

  return [];
}


function chapterToHarbor(item) {
  if (!item) return null;

  const id =
    item.id !== undefined &&
    item.id !== null
      ? String(item.id)
      : null;

  if (!id) {
    return null;
  }

  const chapterNumber =
    item.chapter_number !== undefined
      ? item.chapter_number
      : item.chapter;

  const chapter = normalizeChapter(chapterNumber);

  const title =
    text(item.title) ||
    text(item.chapter_title) ||
    text(item.name);

  const language =
    text(item.language) ||
    text(item.lang) ||
    "en";

  const group =
    text(item.scanlator_name) ||
    text(item.group) ||
    text(item.scanlator);

  const publishAt =
    text(item.date_added) ||
    text(item.publish_at) ||
    text(item.published_at);

  const pages =
    numberOrUndefined(
      item.page_count ||
      item.pages
    ) || 0;

  return {
    id,
    chapter,
    title,
    volume:
      item.volume !== undefined &&
      item.volume !== null
        ? String(item.volume)
        : null,
    pages,
    language,
    group,
    publishAt,
  };
}


// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------

async function getChapterImages(chapterId) {
  const url =
    `${BASE_URL}/api/chapters/${encodeURIComponent(chapterId)}/images`;

  harbor.log("MangaDot pages:", url);

  const json = await httpJson(url);

  if (!json) {
    return [];
  }

  let images = [];

  if (Array.isArray(json.images)) {
    images = json.images;
  } else if (
    json.data &&
    Array.isArray(json.data.images)
  ) {
    images = json.data.images;
  } else if (Array.isArray(json)) {
    images = json;
  }

  return images
    .map((image) => {
      if (typeof image === "string") {
        return absoluteUrl(image);
      }

      if (!image || typeof image !== "object") {
        return undefined;
      }

      return absoluteUrl(
        image.url ||
        image.image ||
        image.src
      );
    })
    .filter(Boolean);
}


// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Fantasy",
  "Historical",
  "Horror",
  "Mystery",
  "Romance",
  "Sci-Fi",
  "School Life",
  "Shounen",
  "Shoujo",
  "Seinen",
  "Josei",
  "Slice of Life",
  "Sports",
  "Supernatural",
  "Thriller",
  "Psychological",
  "Isekai",
  "Martial Arts",
  "Demons",
  "Magic",
  "Mecha",
  "Military",
  "Music",
  "Gyaru",
  "Vampires",
  "Survival",
  "Tragedy",
  "Historical",
  "Boys' Love",
  "Girls' Love",
  "Hentai",
  "Adult",
];


function makeTags() {
  return GENRES.map((name) => ({
    id: name,
    name,
    group: "Genre",
  }));
}


// ---------------------------------------------------------------------------
// MangaProvider
// ---------------------------------------------------------------------------

const plugin = {
  id: "mangadotnet",
  name: "MangaDotNet",


  async popular(offset, tagId) {
    const page =
      Math.floor(
        Number(offset || 0) / PAGE_SIZE
      ) + 1;

    // Si Harbor solicita una etiqueta,
    // intentamos pasarla al buscador.
    if (tagId) {
      const url =
        `${BASE_URL}/api/search` +
        `?genres=${encodeURIComponent(tagId)}` +
        `&sortBy=views` +
        `&page=${page}`;

      const json = await httpJson(url);

      return mapMangaList(json);
    }

    // La API /search sin término devuelve el catálogo.
    const json = await searchApi(
      "",
      page,
      "views"
    );

    return mapMangaList(json);
  },


  async search(query, offset, tagId) {
    const page =
      Math.floor(
        Number(offset || 0) / PAGE_SIZE
      ) + 1;

    const json = await searchApi(
      query || "",
      page,
      "relevance"
    );

    let results = mapMangaList(json);

    // Si Harbor pide una etiqueta y la API no
    // la aplicó, filtramos localmente.
    if (tagId && results.length) {
      // No filtramos aquí porque manga_list puede
      // no contener genres en todas las respuestas.
    }

    return results;
  },


  async detail(id) {
    // Primero intentamos el endpoint .data.
    const json = await getMangaDetail(id);

    if (json) {
      const data = extractDetailData(json);

      const result =
        extractMangaFromDetail(data, id);

      if (result) {
        // Intentamos completar lastChapter si falta.
        if (!result.lastChapter) {
          const chapters =
            await getChaptersRaw(id);

          if (chapters.length) {
            let latest = null;

            for (const ch of chapters) {
              const value =
                ch.chapter_number !== undefined
                  ? Number(ch.chapter_number)
                  : Number(ch.chapter);

              if (
                Number.isFinite(value) &&
                (latest === null || value > latest)
              ) {
                latest = value;
              }
            }

            if (latest !== null) {
              result.lastChapter =
                String(latest);
            }
          }
        }

        return result;
      }
    }

    // Fallback: la búsqueda puede proporcionar
    // suficientes datos para construir una ficha.
    const searchResult =
      await searchApi(
        String(id),
        1,
        "relevance"
      );

    const list =
      extractMangaList(searchResult);

    const found =
      list.find(
        (item) =>
          String(item.id) === String(id)
      );

    return found
      ? mangaToSummary(found)
      : null;
  },


  async chapters(id) {
    const raw =
      await getChaptersRaw(id);

    const chapters =
      raw
        .map(chapterToHarbor)
        .filter(Boolean);

    // MangaDot puede devolver capítulos en orden
    // descendente. Ordenamos por número ascendente.
    chapters.sort((a, b) => {
      const na = Number(a.chapter);
      const nb = Number(b.chapter);

      if (
        Number.isFinite(na) &&
        Number.isFinite(nb)
      ) {
        return na - nb;
      }

      return String(a.chapter || "")
        .localeCompare(
          String(b.chapter || ""),
          undefined,
          {
            numeric: true,
            sensitivity: "base",
          }
        );
    });

    return chapters;
  },


  async pageUrls(chapterId) {
    return await getChapterImages(
      chapterId
    );
  },


  async tags() {
    return makeTags();
  },
};


// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

harbor.register(plugin);
