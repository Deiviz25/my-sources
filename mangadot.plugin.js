/*
 * MangaDotNet Harbor Manga Source
 *
 * Portions of this implementation are adapted from:
 * Mangadotnet-Scraper
 * https://github.com/jianmingyong/Mangadotnet-Scraper
 *
 * Copyright (c) 2026 jianmingyong
 *
 * Licensed under the MIT License.
 * The original copyright notice and permission notice are retained.
 */

const BASE_URL = "https://mangadot.net";
const API_URL = BASE_URL + "/api";
const MANGA_PAGE = 48;

/* ---------------------------------------------------------
 * Helpers
 * --------------------------------------------------------- */

function absoluteUrl(value) {
  if (!value) return null;

  try {
    const url = String(value).trim();

    if (!url) return null;

    if (/^https?:\/\//i.test(url)) {
      return url;
    }

    return new URL(url, BASE_URL).href;
  } catch (_) {
    return null;
  }
}

function asString(value) {
  if (value === null || value === undefined) return null;

  const result = String(value).trim();

  return result || null;
}

function firstString(...values) {
  for (const value of values) {
    const result = asString(value);

    if (result !== null) {
      return result;
    }
  }

  return null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function pageFromOffset(offset) {
  return Math.floor(Math.max(0, offset || 0) / MANGA_PAGE) + 1;
}

/* ---------------------------------------------------------
 * MangaDot pointer-table decoder
 *
 * MangaDot's .data endpoints return a JSON pointer table.
 * This is the same basic mechanism used by the Python scraper.
 * --------------------------------------------------------- */

function resolvePointerTable(table, index, visited) {
  if (!Array.isArray(table)) {
    return table;
  }

  if (index < 0 || index >= table.length) {
    return null;
  }

  const seen = visited || new Set();

  if (seen.has(index)) {
    return null;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(index);

  const value = table[index];

  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    const result = [];

    for (const item of value) {
      if (typeof item === "number") {
        if (item < 0) {
          result.push(null);
        } else {
          result.push(
            resolvePointerTable(table, item, nextSeen)
          );
        }
      } else {
        result.push(item);
      }
    }

    return result;
  }

  if (typeof value === "object") {
    const result = {};

    for (const key of Object.keys(value)) {
      let outputKey = key;
      const rawValue = value[key];

      /*
       * MangaDot uses "_0", "_1", etc. for references
       * to property names in the pointer table.
       */
      if (/^_\d+$/.test(key)) {
        const keyIndex = Number(key.substring(1));
        const resolvedKey = resolvePointerTable(
          table,
          keyIndex,
          nextSeen
        );

        if (typeof resolvedKey === "string") {
          outputKey = resolvedKey;
        }
      }

      if (typeof rawValue === "number") {
        result[outputKey] =
          rawValue < 0
            ? null
            : resolvePointerTable(
                table,
                rawValue,
                nextSeen
              );
      } else {
        result[outputKey] = rawValue;
      }
    }

    return result;
  }

  return value;
}

function parsePointerTable(text) {
  if (!text) return null;

  let data;

  try {
    data = JSON.parse(text);
  } catch (_) {
    /*
     * Try to recover JSON if MangaDot adds surrounding data.
     */
    const arrayStart = text.indexOf("[");
    const objectStart = text.indexOf("{");

    let start = -1;

    if (arrayStart >= 0 && objectStart >= 0) {
      start = Math.min(arrayStart, objectStart);
    } else if (arrayStart >= 0) {
      start = arrayStart;
    } else {
      start = objectStart;
    }

    if (start < 0) {
      return null;
    }

    try {
      data = JSON.parse(text.substring(start));
    } catch (_) {
      return null;
    }
  }

  if (Array.isArray(data)) {
    return resolvePointerTable(data, 0);
  }

  return data;
}

/* ---------------------------------------------------------
 * HTTP
 * --------------------------------------------------------- */

async function getText(path, timeoutMs) {
  const url = path.startsWith("http")
    ? path
    : BASE_URL + path;

  const response = await harbor.http(url, {
    method: "GET",
    headers: {
      "Accept":
        "application/json, text/x-script, text/plain, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/140.0.0.0 Safari/537.36"
    },
    responseType: "text",
    timeoutMs: timeoutMs || 20000
  });

  if (!response || !response.ok) {
    if (response) {
      harbor.log(
        "MangaDot HTTP error:",
        response.status,
        path
      );
    }

    return null;
  }

  return response.body || "";
}

async function getJson(path, timeoutMs) {
  const text = await getText(path, timeoutMs);

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/* ---------------------------------------------------------
 * Search
 * --------------------------------------------------------- */

function extractSearchResults(data) {
  if (!data) return [];

  if (Array.isArray(data)) {
    return data;
  }

  const candidates = [
    data.manga_list,
    data.mangaList,
    data.results,
    data.items,

    data.payload &&
      data.payload.manga_list,

    data.payload &&
      data.payload.results,

    data.data &&
      data.data.manga_list,

    data.data &&
      data.data.results
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

async function searchManga(query, page) {
  /*
   * First try MangaDot's JSON API.
   */
  const params = new URLSearchParams();

  params.set("search", query);
  params.set("sortBy", "relevance");
  params.set("page", String(page));

  const api = await getJson(
    API_URL + "/search?" + params.toString(),
    18000
  );

  if (api) {
    return api;
  }

  /*
   * Fallback to the exact endpoint used by
   * Mangadotnet-Scraper.
   */
  const dataParams = new URLSearchParams();

  dataParams.set("search", query);
  dataParams.set(
    "_routes",
    "pages/SearchPage"
  );

  const raw = await getText(
    "/search.data?" + dataParams.toString(),
    18000
  );

  if (!raw) {
    return null;
  }

  return parsePointerTable(raw);
}

/* ---------------------------------------------------------
 * Summary
 * --------------------------------------------------------- */

function makeSummary(manga) {
  if (!manga || typeof manga !== "object") {
    return null;
  }

  const id = firstString(
    manga.id,
    manga.manga_id,
    manga.mangaId,
    manga.slug
  );

  const title = firstString(
    manga.title,
    manga.name
  );

  if (!id || !title) {
    return null;
  }

  let author = null;

  if (Array.isArray(manga.authors)) {
    author = manga.authors
      .map(author => {
        if (typeof author === "string") {
          return author;
        }

        if (
          author &&
          typeof author === "object"
        ) {
          return firstString(
            author.name,
            author.title
          );
        }

        return null;
      })
      .filter(Boolean)
      .join(", ");
  } else {
    author = firstString(
      manga.author,
      manga.authors,
      manga.author_name,
      manga.authorName
    );
  }

  const cover = absoluteUrl(
    firstString(
      manga.cover_url,
      manga.cover,
      manga.coverUrl,
      manga.thumbnail,
      manga.image,
      manga.poster
    )
  );

  const year = asNumber(
    manga.year ||
    manga.release_year ||
    manga.releaseYear
  );

  const result = {
    id: String(id),
    title: title
  };

  if (cover) {
    result.cover = cover;
  }

  if (year !== null) {
    result.year = year;
  }

  const altTitle = firstString(
    manga.alt_title,
    manga.altTitle,
    manga.alt_titles,
    manga.alternative_title
  );

  if (altTitle) {
    result.altTitle = altTitle;
  }

  const description = firstString(
    manga.description,
    manga.summary,
    manga.synopsis
  );

  if (description) {
    result.description = description;
  }

  const status = firstString(
    manga.status,
    manga.publication_status,
    manga.publicationStatus
  );

  if (status) {
    result.status =
      status.toLowerCase().includes("complete")
        ? "completed"
        : status.toLowerCase().includes("ongoing")
          ? "ongoing"
          : status;
  }

  const contentRating = firstString(
    manga.content_rating,
    manga.contentRating
  );

  if (contentRating) {
    result.contentRating = contentRating;
  }

  const lastChapter = firstString(
    manga.last_chapter,
    manga.lastChapter,
    manga.latest_chapter,
    manga.latestChapter
  );

  if (lastChapter) {
    result.lastChapter = lastChapter;
  }

  if (author) {
    result.author = author;
  }

  return result;
}

/* ---------------------------------------------------------
 * Detail
 * --------------------------------------------------------- */

function extractManga(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (
    data.mangaData &&
    data.mangaData.manga
  ) {
    return data.mangaData.manga;
  }

  if (data.manga) {
    return data.manga;
  }

  if (
    data.data &&
    data.data.mangaData &&
    data.data.mangaData.manga
  ) {
    return data.data.mangaData.manga;
  }

  if (
    data.data &&
    data.data.manga
  ) {
    return data.data.manga;
  }

  return data;
}

async function getManga(id) {
  /*
   * Try API first.
   */
  const api = await getJson(
    API_URL +
      "/manga/" +
      encodeURIComponent(id),
    20000
  );

  if (api) {
    return api;
  }

  /*
   * Exact .data endpoint from the scraper.
   */
  const params = new URLSearchParams();

  params.set(
    "_routes",
    "pages/MangaDetailPage"
  );

  const raw = await getText(
    "/manga/" +
      encodeURIComponent(id) +
      ".data?" +
      params.toString(),
    20000
  );

  if (!raw) {
    return null;
  }

  return parsePointerTable(raw);
}

/* ---------------------------------------------------------
 * Chapters
 * --------------------------------------------------------- */

async function getChapters(id) {
  const primary = await getJson(
    API_URL +
      "/manga/" +
      encodeURIComponent(id) +
      "/chapters/list",
    22000
  );

  if (Array.isArray(primary)) {
    return primary;
  }

  if (
    primary &&
    Array.isArray(primary.chapters)
  ) {
    return primary.chapters;
  }

  if (
    primary &&
    Array.isArray(primary.data)
  ) {
    return primary.data;
  }

  /*
   * Fallback used by older MangaDot implementations.
   */
  const fallback = await getJson(
    API_URL +
      "/manga/" +
      encodeURIComponent(id) +
      "/chapters",
    22000
  );

  if (Array.isArray(fallback)) {
    return fallback;
  }

  if (
    fallback &&
    Array.isArray(fallback.chapters)
  ) {
    return fallback.chapters;
  }

  return [];
}

function makeChapter(chapter) {
  if (!chapter || typeof chapter !== "object") {
    return null;
  }

  const id = firstString(
    chapter.id,
    chapter.chapter_id,
    chapter.chapterId
  );

  if (!id) {
    return null;
  }

  const chapterNumber =
    chapter.chapter_number !== undefined
      ? chapter.chapter_number
      : chapter.chapterNumber;

  const volumeNumber =
    chapter.volume_number !== undefined
      ? chapter.volume_number
      : chapter.volumeNumber;

  const result = {
    id: String(id),
    chapter:
      chapterNumber === null ||
      chapterNumber === undefined ||
      chapterNumber === ""
        ? null
        : String(chapterNumber),

    pages: 0,

    language:
      firstString(
        chapter.language,
        chapter.lang
      ) || "en"
  };

  const title = firstString(
    chapter.chapter_title,
    chapter.chapterTitle,
    chapter.title,
    chapter.name
  );

  if (title) {
    result.title = title;
  }

  if (
    volumeNumber !== null &&
    volumeNumber !== undefined &&
    volumeNumber !== ""
  ) {
    result.volume = String(volumeNumber);
  }

  const group = firstString(
    chapter.scanlator_name,
    chapter.scanlatorName,
    chapter.group_name,
    chapter.groupName
  );

  if (group) {
    result.group = group;
  }

  const date = firstString(
    chapter.date_added,
    chapter.dateAdded,
    chapter.publish_at,
    chapter.publishAt,
    chapter.published_at
  );

  if (date) {
    result.publishAt = date;
  }

  const pageCount = asNumber(
    chapter.page_count !== undefined
      ? chapter.page_count
      : chapter.pageCount !== undefined
        ? chapter.pageCount
        : chapter.pages
  );

  if (pageCount !== null) {
    result.pages = Math.max(
      0,
      Math.floor(pageCount)
    );
  }

  return result;
}

/* ---------------------------------------------------------
 * Chapter pages
 * --------------------------------------------------------- */

async function getPages(chapterId) {
  const data = await getJson(
    API_URL +
      "/chapters/" +
      encodeURIComponent(chapterId) +
      "/images",
    28000
  );

  if (!data) {
    return [];
  }

  let images = [];

  if (Array.isArray(data)) {
    images = data;
  } else if (
    Array.isArray(data.images)
  ) {
    images = data.images;
  } else if (
    data.data &&
    Array.isArray(data.data.images)
  ) {
    images = data.data.images;
  }

  const pages = [];

  for (const image of images) {
    let url = null;

    if (typeof image === "string") {
      url = image;
    } else if (
      image &&
      typeof image === "object"
    ) {
      url = firstString(
        image.url,
        image.src,
        image.image_url,
        image.imageUrl
      );
    }

    const absolute = absoluteUrl(url);

    if (
      absolute &&
      /^https?:\/\//i.test(absolute)
    ) {
      pages.push(absolute);
    }
  }

  return pages;
}

/* ---------------------------------------------------------
 * Harbor provider
 * --------------------------------------------------------- */

const plugin = {
  id: "mangadotnet",

  name: "MangaDotNet",

  async popular(offset, tagId) {
    const page = pageFromOffset(offset);

    const data = await searchManga("", page);

    return extractSearchResults(data)
      .map(makeSummary)
      .filter(Boolean)
      .slice(0, MANGA_PAGE);
  },

  async search(query, offset, tagId) {
    const search = String(query || "").trim();

    if (!search) {
      return [];
    }

    const page = pageFromOffset(offset);

    const data = await searchManga(
      search,
      page
    );

    const results = extractSearchResults(data);

    return results
      .map(makeSummary)
      .filter(Boolean)
      .slice(0, MANGA_PAGE);
  },

  async detail(id) {
    if (!id) {
      return null;
    }

    const data = await getManga(
      String(id)
    );

    if (!data) {
      return null;
    }

    const manga = extractManga(data);

    if (!manga) {
      return null;
    }

    /*
     * Keep Harbor's original ID stable.
     */
    const copy = {
      ...manga,
      id:
        manga.id !== undefined
          ? manga.id
          : id
    };

    return makeSummary(copy);
  },

  async chapters(id) {
    if (!id) {
      return [];
    }

    const chapters = await getChapters(
      String(id)
    );

    return chapters
      .map(makeChapter)
      .filter(Boolean)
      .slice(0, 5000);
  },

  async pageUrls(chapterId) {
    if (!chapterId) {
      return [];
    }

    const pages = await getPages(
      String(chapterId)
    );

    return pages
      .filter(url =>
        /^https?:\/\//i.test(url)
      )
      .slice(0, 2000);
  }
};

harbor.register(plugin);
