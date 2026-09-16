/ mangadot.net — Harbor MangaProvider
// Rebuilt from real MangaDot SSR data + documented JSON endpoints.
// Harbor API: harbor.http / harbor.register only; no fetch/window/document.
//
// Confirmed from supplied MangaDot pages:
// - Home SSR: loaderData -> pages/HomePage -> sectionsData.sections
//   sections: most_tracked, top_rated, latest_updates, recently_added.
// - Manga detail SSR: loaderData -> pages/MangaDetailPage -> mangaData.manga.
// - Chapter reader SSR: pages/ChapterReaderPage contains chapter + manga metadata.
// - Manga URLs: /manga/{id}
// - Chapter URLs: /chapter/{id}[?source=user]
//
// Confirmed endpoint structure from independent recon:
// - GET /api/search?search=...&sortBy=relevance&page=N -> {manga_list,pagination,...}
// - GET /api/manga/{id}/chapters/list -> chapter array
// - GET /api/chapters/{chapter_id}/images -> {chapter,images:[{url,w,h},...]}

const BASE_URL = "https://mangadot.net";
const API_URL = `${BASE_URL}/api`;
const PAGE_SIZE = 48;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// -----------------------------------------------------------------------------
// Network
// -----------------------------------------------------------------------------

async function fetchText(pathOrUrl) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${BASE_URL}${pathOrUrl}`;

  try {
    const res = await harbor.http(url, {
      responseType: "text",
      timeoutMs: 20000,
      headers: {
        "user-agent": BROWSER_UA,
        accept: "text/html,application/xhtml+xml,text/plain,*/*",
      },
    });

    if (!res || !res.ok) {
      harbor.log(`HTTP ${res?.status ?? "?"} en ${url}`);
      return null;
    }

    return typeof res.body === "string" ? res.body : null;
  } catch (e) {
    harbor.log(`NETWORK ${url}: ${String(e).slice(0, 160)}`);
    return null;
  }
}

async function fetchJson(urlOrPath) {
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : `${BASE_URL}${urlOrPath}`;

  try {
    // With responseType=json Harbor returns the parsed JSON directly (or null).
    const json = await harbor.http(url, {
      responseType: "json",
      timeoutMs: 25000,
      headers: {
        "user-agent": BROWSER_UA,
        accept: "application/json,text/plain,*/*",
      },
    });

    return json == null ? null : json;
  } catch (e) {
    harbor.log(`JSON NETWORK ${url}: ${String(e).slice(0, 160)}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

function absoluteUrl(url) {
  if (!url) return undefined;
  try {
    return new URL(String(url), BASE_URL).toString();
  } catch {
    return undefined;
  }
}

function cleanText(value) {
  if (value == null) return undefined;
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function statusMap(raw, hiatus) {
  const s = String(raw || "").toLowerCase();
  if (hiatus && String(hiatus).toLowerCase() !== "no") return "hiatus";
  if (s.includes("complete") || s.includes("finish") || s.includes("final")) {
    return "completed";
  }
  if (s.includes("ongoing") || s.includes("progress")) return "ongoing";
  if (s.includes("hiatus")) return "hiatus";
  return "unknown";
}

function buildParams(params) {
  const parts = [];

  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }

  return parts.join("&");
}

// -----------------------------------------------------------------------------
// React Router SSR hydration
// -----------------------------------------------------------------------------

function extractHydrationPayload(html) {
  if (!html) return null;

  const re =
    /streamController\.enqueue\("((?:\\.|[^"\\])*)"\);/g;

  const chunks = [];
  let m;

  while ((m = re.exec(html)) !== null) {
    try {
      // The argument is a normal JavaScript string literal.
      // In the real page keys are "_123", so JSON decoding is sufficient.
      const decoded = JSON.parse(`"${m[1]}"`);
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) chunks.push(parsed);
    } catch {
      // Ignore malformed/auxiliary chunks and try the next one.
    }
  }

  if (!chunks.length) {
    harbor.log("Hydration: no usable streamController.enqueue payload");
    return null;
  }

  // Current MangaDot pages place the full flat table in one chunk.
  // If several are present, prefer the largest table.
  chunks.sort((a, b) => b.length - a.length);
  return chunks[0];
}

function hydrate(rootIndex, table) {
  const seen = new Map();

  function resolve(value) {
    if (value === -5) return null;

    if (typeof value === "number" && typeof table[value] === "string") {
      const s = table[value].trim();

      if (s.startsWith("[") && s.endsWith("]")) {
        try {
          return JSON.parse(s);
        } catch {
          // Fall through to normal reference resolution.
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

    if (typeof node === "object") {
      if (seen.has(node)) return seen.get(node);

      if (Array.isArray(node)) {
        const out = [];
        seen.set(node, out);
        for (const value of node) out.push(resolve(value));
        return out;
      }

      const out = {};
      seen.set(node, out);

      for (const [key, value] of Object.entries(node)) {
        const realKey = key.startsWith("_")
          ? table[Number(key.slice(1))]
          : key;

        if (realKey == null) continue;
        out[realKey] = resolve(value);
      }

      return out;
    }

    return node;
  }

  return resolve(rootIndex);
}

function hydrateRoots(table, maxRoots = 50) {
  if (!Array.isArray(table)) return [];

  const roots = [];
  const max = Math.min(maxRoots, table.length);

  for (let i = 0; i < max; i++) {
    try {
      const value = hydrate(i, table);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        roots.push({ index: i, value });
      }
    } catch {
      // Continue scanning other possible roots.
    }
  }

  return roots;
}

function findObjectByKeys(value, predicate, seen = new Set()) {
  if (value == null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (predicate(value)) return value;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectByKeys(item, predicate, seen);
      if (found) return found;
    }
    return null;
  }

  for (const child of Object.values(value)) {
    const found = findObjectByKeys(child, predicate, seen);
    if (found) return found;
  }

  return null;
}

function findMangaNode(hydrated) {
  return findObjectByKeys(
    hydrated,
    (x) =>
      x &&
      typeof x === "object" &&
      x.id != null &&
      x.title != null &&
      (x.photo != null || x.description != null) &&
      !Array.isArray(x)
  );
}

function findMangaData(hydrated) {
  const data = findObjectByKeys(
    hydrated,
    (x) =>
      x &&
      typeof x === "object" &&
      x.manga &&
      x.total_chapters != null
  );
  return data || null;
}

function findHomeSections(hydrated) {
  const sectionsData = findObjectByKeys(
    hydrated,
    (x) =>
      x &&
      typeof x === "object" &&
      x.sections &&
      typeof x.sections === "object" &&
      x.sections.most_tracked
  );

  return sectionsData?.sections || null;
}

// -----------------------------------------------------------------------------
// Manga mapping
// -----------------------------------------------------------------------------

function mangaFromNode(manga) {
  if (!manga || manga.id == null || manga.title == null) return null;

  const result = {
    id: String(manga.id),
    title: cleanText(manga.title) || String(manga.id),
    cover: absoluteUrl(manga.photo),
    description: cleanText(manga.description),
    status: statusMap(manga.status, manga.hiatus),
    genres: Array.isArray(manga.genres) ? manga.genres : undefined,
    author: Array.isArray(manga.authors) && manga.authors.length
      ? manga.authors.join(" & ")
      : undefined,
    artist: Array.isArray(manga.artists) && manga.artists.length
      ? manga.artists.join(" & ")
      : undefined,
    year: Number.isFinite(Number(manga.year))
      ? Number(manga.year)
      : undefined,
    contentRating: manga.content_rating
      ? String(manga.content_rating)
      : undefined,
    lastChapter:
      manga.latest_chapter_number != null
        ? String(manga.latest_chapter_number)
        : undefined,
  };

  return result;
}

function mapSearchItem(item) {
  if (!item || item.id == null || !item.title) return null;

  return {
    id: String(item.id),
    title: cleanText(item.title) || String(item.id),
    cover: absoluteUrl(item.photo),
    description: cleanText(item.description),
    status: statusMap(item.status, item.hiatus),
    genres: Array.isArray(item.genres) ? item.genres : undefined,
    author: Array.isArray(item.authors) && item.authors.length
      ? item.authors.join(" & ")
      : undefined,
    artist: Array.isArray(item.artists) && item.artists.length
      ? item.artists.join(" & ")
      : undefined,
    lastChapter:
      item.latest_chapter_number != null
        ? String(item.latest_chapter_number)
        : undefined,
  };
}

// -----------------------------------------------------------------------------
// JSON search / lists
// -----------------------------------------------------------------------------

function extractMangaArray(json) {
  if (!json || typeof json !== "object") return [];

  const candidates = [
    json.manga_list,
    json.results,
    json.items,
    json.data,
    json.manga,
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

async function searchApi(query, offset, sortBy, tagId) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  const params = {
    search: query || undefined,
    sortBy: sortBy || "relevance",
    page,
    perPage: PAGE_SIZE,
    per_page: PAGE_SIZE,
  };

  // Keep both commonly-used spellings as a graceful compatibility fallback.
  if (tagId) params.genre = tagId;

  const url = `${API_URL}/search?${buildParams(params)}`;
  const json = await fetchJson(url);

  if (!json) return [];

  const items = extractMangaArray(json);
  if (!items.length) return [];

  return items.map(mapSearchItem).filter(Boolean);
}

async function searchDataFallback(query, offset, tagId) {
  const page = Math.floor(offset / PAGE_SIZE) + 1;

  const params = {
    adult: 1,
    page,
    perPage: PAGE_SIZE,
    _routes: "pages/SearchPage",
  };

  if (query) params.search = query;
  if (tagId) params.genre = [tagId];

  const json = await fetchJson(
    `${BASE_URL}/search.data?${buildParams(params)}`
  );

  if (!json) return [];

  const table = Array.isArray(json) ? json : null;

  if (table) {
    const roots = hydrateRoots(table);
    for (const root of roots) {
      const list = findObjectByKeys(
        root.value,
        (x) =>
          x &&
          typeof x === "object" &&
          (Array.isArray(x.results) || Array.isArray(x.manga_list))
      );

      const raw = list?.results || list?.manga_list;
      if (Array.isArray(raw)) {
        return raw.map(mapSearchItem).filter(Boolean);
      }
    }
  }

  return extractMangaArray(json).map(mapSearchItem).filter(Boolean);
}

// -----------------------------------------------------------------------------
// Home SSR
// -----------------------------------------------------------------------------

async function homeItems(sectionName) {
  const html = await fetchText("/");
  if (!html) return [];

  const table = extractHydrationPayload(html);
  if (!table) return [];

  const roots = hydrateRoots(table);

  for (const root of roots) {
    const sections = findHomeSections(root.value);
    if (!sections) continue;

    const section = sections[sectionName];
    if (!section || !Array.isArray(section.items)) continue;

    return section.items.map(mapSearchItem).filter(Boolean);
  }

  return [];
}

// -----------------------------------------------------------------------------
// MangaProvider
// -----------------------------------------------------------------------------

const plugin = {
  id: "mangadot",
  name: "MangaDot",

  async popular(offset, tagId) {
    if (tagId) {
      let items = await searchApi("", offset, "tracked", tagId);

      if (!items.length) {
        items = await searchDataFallback("", offset, tagId);
      }

      return items;
    }

    // The real home SSR exposes 21-item sections. Use it for the first page.
    if (offset === 0) {
      const sections = [
        "most_tracked",
        "top_rated",
        "latest_updates",
        "recently_added",
      ];

      const out = [];
      const seen = new Set();

      for (const section of sections) {
        const items = await homeItems(section);

        for (const item of items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          out.push(item);

          if (out.length >= PAGE_SIZE) {
            return out;
          }
        }
      }

      if (out.length) return out;
    }

    // Subsequent pages use the clean JSON search endpoint.
    let items = await searchApi("", offset, "tracked", null);

    if (!items.length) {
      items = await searchDataFallback("", offset, null);
    }

    return items;
  },

  async search(query, offset, tagId) {
    if (!query && tagId) {
      let items = await searchApi("", offset, "relevance", tagId);
      if (!items.length) items = await searchDataFallback("", offset, tagId);
      return items;
    }

    if (!query) return [];

    let items = await searchApi(query, offset, "relevance", tagId);

    if (!items.length) {
      items = await searchDataFallback(query, offset, tagId);
    }

    return items;
  },

  async detail(id) {
    const encodedId = encodeURIComponent(String(id));

    // Clean JSON endpoint first.
    let json = await fetchJson(`${API_URL}/manga/${encodedId}`);

    if (json) {
      const direct = findMangaNode(json);
      if (direct) {
        const base = mangaFromNode(direct);
        if (base) {
          const mangaData = findMangaData(json);
          if (mangaData?.latest_chapter_number != null) {
            base.lastChapter = String(mangaData.latest_chapter_number);
          }
          return base;
        }
      }
    }

    // SSR HTML fallback.
    const html = await fetchText(`${BASE_URL}/manga/${encodedId}`);
    if (!html) return null;

    const table = extractHydrationPayload(html);

    if (table) {
      const roots = hydrateRoots(table);

      for (const root of roots) {
        const mangaData = findMangaData(root.value);
        const manga = mangaData?.manga || findMangaNode(root.value);

        if (!manga) continue;

        const result = mangaFromNode(manga);
        if (!result) continue;

        if (mangaData?.latest_chapter_number != null) {
          result.lastChapter = String(mangaData.latest_chapter_number);
        }

        return result;
      }
    }

    return null;
  },

  async chapters(id) {
    const mangaId = encodeURIComponent(String(id));

    // Confirmed API shape:
    // [{id, chapter_number, language, page_count, scanlator_name,
    //   date_added, source, ...}]
    const endpoints = [
      `${API_URL}/manga/${mangaId}/chapters/list`,
      `${API_URL}/manga/${mangaId}/chapters`,
    ];

    let data = null;

    for (const endpoint of endpoints) {
      data = await fetchJson(endpoint);
      if (Array.isArray(data)) break;
      if (data && Array.isArray(data.chapters)) {
        data = data.chapters;
        break;
      }
      if (data && Array.isArray(data.data)) {
        data = data.data;
        break;
      }
      data = null;
    }

    if (!Array.isArray(data)) {
      harbor.log(`No se obtuvieron capítulos para manga ${id}`);
      return [];
    }

    const chapters = data
      .map((c) => {
        if (!c || c.id == null) return null;

        const number =
          c.chapter_number ??
          c.number ??
          c.chapterNumber ??
          null;

        const source = c.source ? String(c.source) : "";

        // Reader URL proven in the supplied chapter:
        // /chapter/{id}?source=user
        const readerId =
          source === "user"
            ? `${c.id}?source=user`
            : String(c.id);

        return {
          id: readerId,
          chapter: number == null ? null : String(number),
          title:
            c.chapter_title ||
            c.title ||
            (number != null ? `Chapter ${number}` : `Chapter ${c.id}`),
          volume:
            c.volume_number != null
              ? String(c.volume_number)
              : c.volume != null
                ? String(c.volume)
                : null,
          pages: Number.isFinite(Number(c.page_count))
            ? Number(c.page_count)
            : Number.isFinite(Number(c.pages))
              ? Number(c.pages)
              : 0,
          language: c.language ? String(c.language) : "en",
          group:
            c.scanlator_name ||
            c.group_name ||
            c.scanlator_group ||
            c.group ||
            undefined,
          publishAt:
            c.date_added ||
            c.upload_date ||
            c.created_at ||
            c.date ||
            undefined,
        };
      })
      .filter(Boolean);

    // Harbor expects a stable, ascending chapter sequence.
    chapters.sort((a, b) => {
      const an = parseFloat(a.chapter);
      const bn = parseFloat(b.chapter);

      if (Number.isFinite(an) && Number.isFinite(bn)) {
        if (an !== bn) return an - bn;
      } else if (Number.isFinite(an)) {
        return -1;
      } else if (Number.isFinite(bn)) {
        return 1;
      }

      return String(a.id).localeCompare(String(b.id));
    });

    return chapters;
  },

  async pageUrls(chapterId) {
    const textId = String(chapterId);
    const rawId = textId.split("?")[0];
    const encoded = encodeURIComponent(rawId);

    // The clean manifest endpoint is confirmed for MangaDot.
    const endpoints = [
      `${API_URL}/chapters/${encoded}/images`,
      `${API_URL}/uploads/${encoded}/images`,
    ];

    let json = null;

    for (const endpoint of endpoints) {
      json = await fetchJson(endpoint);
      if (json) break;
    }

    if (!json) {
      // Last fallback: reader HTML can still be useful for a future markup
      // variation, although current MangaDot exposes the manifest through API.
      const html = await fetchText(
        `${BASE_URL}/chapter/${encodeURIComponent(rawId)}`
      );

      if (html) {
        const candidates = [];
        const re =
          /(?:src|data-src|data-original)=["'](https?:\/\/[^"']+|\/chapters\/[^"']+\.(?:webp|jpg|jpeg|png))["']/gi;

        let m;
        while ((m = re.exec(html)) !== null) {
          const url = absoluteUrl(m[1]);
          if (url) candidates.push(url);
        }

        return [...new Set(candidates)];
      }

      return [];
    }

    const images = Array.isArray(json)
      ? json
      : Array.isArray(json.images)
        ? json.images
        : Array.isArray(json.data)
          ? json.data
          : [];

    const result = [];

    for (const image of images) {
      let url;

      if (typeof image === "string") {
        url = image;
      } else if (image && typeof image === "object") {
        url = image.url || image.src || image.image || image.link;
      }

      const absolute = absoluteUrl(url);
      if (absolute) result.push(absolute);
    }

    return [...new Set(result)];
  },

  async tags() {
    // MangaDot's taxonomy includes these genre labels. Keeping them stable
    // makes Harbor's tag filter usable without depending on visited titles.
    const genres = [
      "action", "Action", "adventure", "Adventure", "Aliens",
      "Anthology", "award_winning", "Award Winning",
      "boys' love", "Boys Love", "Boys' Love",
      "comedy", "Comedy", "Comic", "Cooking", "Crime",
      "Crossdressing", "Delinquents", "Demons", "drama", "Drama",
      "ecchi", "Ecchi", "erotica", "Erotica", "fantasy", "Fantasy",
      "female protagonist", "Fight", "gender_bender", "Gender Bender",
      "Ghosts", "girls_love", "Girls love", "Girls Love",
      "gore", "Gourmet", "Gyaru", "harem", "Harem",
      "hentai", "Hentai", "historical", "Historical", "horror", "Horror",
      "Isekai", "josei", "Josei", "Loli", "Lolicon", "Mafia",
      "magic", "Magic", "Magical Girls", "Mahou Shoujo",
      "manga", "Manga", "manhua", "Manhua", "manhwa", "Manhwa",
      "martial arts", "Martial Arts", "Medical", "military", "Military",
      "mecha", "Mecha", "Monster Girls", "Mystery", "music", "Music",
      "Ninja", "office worker", "Office Workers", "Otome",
      "Police", "Post-Apocalyptic", "psychological", "Psychological",
      "reincarnation", "Reincarnation", "Reverse Harem",
      "romance", "Romance", "royalty", "Samurai", "school_life",
      "School life", "sci-fi", "Sci-fi", "seinen", "Seinen",
      "shoujo", "Shoujo", "shoujo_ai", "Shoujo Ai",
      "shounen", "Shounen", "slice_of_life", "Slice of life",
      "sports", "Sports", "Supernatural", "Survival",
      "suspense", "Suspense", "thriller", "Thriller",
      "Time Travel", "tragedy", "Tragedy", "Vampires",
      "Video Games", "Villainess", "Virtual Reality",
      "War", "webtoon", "Webtoon", "webtoons", "wuxia", "Wuxia",
      "yaoi", "Yaoi", "yuri", "Yuri", "Zombies",
    ];

    return genres.map((name) => ({ id: name, name }));
  },
};

harbor.register(plugin);
