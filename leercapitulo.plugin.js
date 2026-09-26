const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48;
const CACHE_TTL = 1000 * 60 * 60; // 1 hora

// ============================================================
// Helpers
// ============================================================

async function fetchText(path) {
  try {
    const url = path.startsWith("http")
      ? path
      : `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

    const res = await harbor.http(url, {
      responseType: "text",
      timeoutMs: 15000, // Timeout más agresivo
    });

    if (!res || !res.ok) {
      harbor.log(`LeerCapitulo HTTP error: ${url}`);
      return "";
    }

    return res.body || "";
  } catch (e) {
    harbor.log(`LeerCapitulo fetchText error: ${e}`);
    return "";
  }
}

async function fetchJson(path) {
  try {
    const url = path.startsWith("http")
      ? path
      : `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;

    return await harbor.http(url, {
      responseType: "json",
      timeoutMs: 15000,
    });
  } catch (e) {
    harbor.log(`LeerCapitulo fetchJson error: ${e}`);
    return null;
  }
}

function absoluteUrl(url) {
  if (!url) return undefined;

  const value = String(url).trim();

  if (!value) return undefined;

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (value.startsWith("/")) {
    return `${BASE_URL}${value}`;
  }

  return `${BASE_URL}/${value}`;
}

function decodeEntities(text) {
  if (!text) return "";

  return String(text)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try {
        return String.fromCharCode(parseInt(n, 16));
      } catch {
        return _;
      }
    });
}

function cleanText(text) {
  if (!text) return "";

  return decodeEntities(
    String(text)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function slugFromMangaHref(href) {
  if (!href) return null;

  const match = String(href).match(/\/manga\/([^/?#]+)/i);

  return match ? match[1] : null;
}

function normalizeId(id) {
  if (!id) return "";

  return absoluteUrl(id);
}

// ============================================================
// Caché mejorado con expiración
// ============================================================

class ExpiringCache {
  constructor(ttl = CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
  }

  set(key, value) {
    this.cache.set(key, {
      value,
      expiredAt: Date.now() + this.ttl,
    });
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiredAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  clear() {
    this.cache.clear();
  }
}

const summaryCache = new ExpiringCache();

// ============================================================
// Array data
// ============================================================

const K2_TO_K1 = new Map([
  ["0", "w"],
  ["1", "j"],
  ["2", "H"],
  ["3", "A"],
  ["4", "V"],
  ["5", "Q"],
  ["6", "P"],
  ["7", "3"],
  ["8", "L"],
  ["9", "Y"],
  ["A", "m"],
  ["B", "t"],
  ["C", "R"],
  ["D", "o"],
  ["E", "B"],
  ["F", "x"],
  ["G", "T"],
  ["H", "C"],
  ["I", "N"],
  ["J", "0"],
  ["K", "S"],
  ["L", "D"],
  ["M", "f"],
  ["N", "F"],
  ["O", "y"],
  ["P", "h"],
  ["Q", "7"],
  ["R", "c"],
  ["S", "s"],
  ["T", "d"],
  ["U", "9"],
  ["V", "e"],
  ["W", "J"],
  ["X", "z"],
  ["Y", "X"],
  ["Z", "b"],
  ["a", "a"],
  ["b", "I"],
  ["c", "q"],
  ["d", "G"],
  ["e", "n"],
  ["f", "2"],
  ["g", "Z"],
  ["h", "M"],
  ["i", "5"],
  ["j", "6"],
  ["k", "u"],
  ["l", "O"],
  ["m", "i"],
  ["n", "l"],
  ["o", "g"],
  ["p", "r"],
  ["q", "K"],
  ["r", "v"],
  ["s", "p"],
  ["t", "8"],
  ["u", "4"],
  ["v", "U"],
  ["w", "W"],
  ["x", "E"],
  ["y", "1"],
  ["z", "k"],
]);

function decodeArrayData(arrayData) {
  if (!arrayData) return [];

  const replaced = String(arrayData).replace(
    /[A-Za-z0-9]/g,
    (ch) => K2_TO_K1.get(ch) || ch,
  );

  let decoded;

  try {
    decoded = atob(replaced);
  } catch {
    return [];
  }

  return decoded
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ============================================================
// Parseo de tarjetas (optimizado)
// ============================================================

function parseHotMangaBlocks(html) {
  if (!html) return [];

  const results = [];
  const regex =
    /<[^>]*class=["'][^"']*hot-manga[^"']*["'][^>]*>[\s\S]*?<\/(?:div|article|li)>/gi;

  const blocks = html.match(regex) || [];

  for (const block of blocks) {
    const hrefMatch = block.match(/href=["']([^"']*\/manga\/[^"']*)["']/i);

    if (!hrefMatch) continue;

    const id = absoluteUrl(hrefMatch[1]);
    const slug = slugFromMangaHref(hrefMatch[1]);

    if (!id || !slug) continue;

    const titleMatch =
      block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
      block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i) ||
      block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);

    const imgMatch =
      block.match(/data-src=["']([^"']+)["']/i) ||
      block.match(/src=["']([^"']+)["']/i);

    results.push({
      id,
      slug,
      title: cleanText(titleMatch?.[1]) || slug,
      cover: absoluteUrl(imgMatch?.[1]),
    });
  }

  return results;
}

function parseMainpageMangaBlocks(html) {
  if (!html) return [];

  const results = [];
  const regex =
    /<[^>]*class=["'][^"']*(?:media-left|cover-manga)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|article|li)>/gi;

  const blocks = html.match(regex) || [];

  for (const block of blocks) {
    const hrefMatch = block.match(/href=["']([^"']*\/manga\/[^"']*)["']/i);

    if (!hrefMatch) continue;

    const id = absoluteUrl(hrefMatch[1]);
    const slug = slugFromMangaHref(hrefMatch[1]);

    if (!id || !slug) continue;

    const titleMatch =
      block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i) ||
      block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) ||
      block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);

    const imgMatch =
      block.match(/data-src=["']([^"']+)["']/i) ||
      block.match(/src=["']([^"']+)["']/i);

    results.push({
      id,
      slug,
      title: cleanText(titleMatch?.[1]) || slug,
      cover: absoluteUrl(imgMatch?.[1]),
    });
  }

  return results;
}

async function parseCatalogCardsGeneric(html) {
  if (!html) return [];

  let doc;

  try {
    doc = await harbor.parseHtml(html);
  } catch (e) {
    harbor.log(`LeerCapitulo parseHtml error: ${e}`);
    return [];
  }

  if (!doc) return [];

  const anchors = doc.querySelectorAll('a[href*="/manga/"]');
  const results = [];
  const seen = new Set();

  for (const a of anchors) {
    const href = a.attr("href");

    if (!href) continue;

    const slug = slugFromMangaHref(href);

    if (!slug || seen.has(slug)) continue;

    let title = cleanText(a.text());
    let cover;

    try {
      const img = a.querySelector("img");

      if (img) {
        cover =
          img.attr("data-src") ||
          img.attr("data-lazy-src") ||
          img.attr("src") ||
          undefined;
      }
    } catch {}

    if (!cover) {
      try {
        const parent = a.parent();

        if (parent) {
          const img = parent.querySelector("img");

          if (img) {
            cover =
              img.attr("data-src") ||
              img.attr("data-lazy-src") ||
              img.attr("src") ||
              undefined;
          }
        }
      } catch {}
    }

    if (!title) {
      try {
        const parent = a.parent();
        if (parent) title = cleanText(parent.text());
      } catch {}
    }

    if (!title) title = slug;

    const id = absoluteUrl(href);

    seen.add(slug);

    results.push({
      id,
      slug,
      title,
      cover: absoluteUrl(cover),
    });
  }

  return results;
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const result = [];

  for (const card of cards) {
    if (!card || !card.slug) continue;

    if (seen.has(card.slug)) continue;

    seen.add(card.slug);
    result.push(card);
  }

  return result;
}

function cardsToResults(cards) {
  return cards.map((card) => {
    const result = {
      id: card.id,
      title: card.title || card.slug,
      cover: card.cover,
    };

    summaryCache.set(result.id, result);

    return result;
  });
}

// ============================================================
// Catálogo
// ============================================================

function catalogPath({ tagId, page } = {}) {
  let path = "/manga/?";

  if (tagId) {
    if (tagId.startsWith("genre:")) {
      path += `genre=${encodeURIComponent(tagId.slice(6))}`;
    } else if (tagId.startsWith("theme:")) {
      path += `theme=${encodeURIComponent(tagId.slice(6))}`;
    }
  }

  const separator = path.endsWith("?") ? "" : "&";

  path += `${separator}page=${page || 1}`;

  return path;
}

// ============================================================
// Detail (Optimizado)
// ============================================================

function extractMeta(html, property) {
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}["'][^>]+content=["']([^"']*)["'][^>]*>`,
    "i",
  );

  return regex.exec(html)?.[1] || undefined;
}

function extractFirstImage(html) {
  if (!html) return undefined;

  const preferredPatterns = [
    /<img[^>]+class=["'][^"']*(?:cover|manga)[^"']*["'][^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i,
    /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]+class=["'][^"']*(?:cover|manga)[^"']*["']/i,
    /<div[^>]+class=["'][^"']*(?:cover-detail|cover-manga)[^"']*["'][^>]*>[\s\S]*?<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i,
  ];

  for (const regex of preferredPatterns) {
    const match = html.match(regex);

    if (match?.[1]) {
      return absoluteUrl(match[1]);
    }
  }

  const ogImage =
    extractMeta(html, "og:image") ||
    extractMeta(html, "twitter:image");

  if (ogImage) {
    return absoluteUrl(ogImage);
  }

  const images = [
    ...html.matchAll(
      /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi,
    ),
  ];

  for (const match of images) {
    const url = match[1];

    if (!url) continue;

    const lower = url.toLowerCase();

    if (
      lower.includes("logo") ||
      lower.includes("icon") ||
      lower.includes("avatar") ||
      lower.includes("favicon") ||
      lower.includes("ads")
    ) {
      continue;
    }

    return absoluteUrl(url);
  }

  return undefined;
}

function extractTitle(html, fallback) {
  if (!html) return fallback;

  const patterns = [
    /<h1[^>]*class=["'][^"']*title-manga[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*class=["'][^"']*manga-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
  ];

  for (const regex of patterns) {
    const match = html.match(regex);

    if (match?.[1]) {
      const title = cleanText(match[1]);

      if (
        title &&
        title.toLowerCase() !== "untitled" &&
        title.toLowerCase() !== "undefined"
      ) {
        return title;
      }
    }
  }

  const ogTitle =
    extractMeta(html, "og:title") ||
    extractMeta(html, "twitter:title");

  if (ogTitle) {
    const title = cleanText(ogTitle);

    if (
      title &&
      title.toLowerCase() !== "untitled" &&
      title.toLowerCase() !== "undefined"
    ) {
      return title;
    }
  }

  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

  if (titleTag?.[1]) {
    let title = cleanText(titleTag[1]);

    title = title
      .replace(/\s*[|–—-]\s*LeerCapitulo.*$/i, "")
      .replace(/\s*[|–—-]\s*Leer Capitulo.*$/i, "")
      .trim();

    if (
      title &&
      title.toLowerCase() !== "untitled" &&
      title.toLowerCase() !== "undefined"
    ) {
      return title;
    }
  }

  return fallback;
}

function extractDescription(html) {
  const patterns = [
    /<p[^>]+id=["']example2["'][^>]*>([\s\S]*?)<\/p>/i,
    /<p[^>]+class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i,
    /<div[^>]+class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  for (const regex of patterns) {
    const match = html.match(regex);

    if (match?.[1]) {
      const value = cleanText(match[1]);

      if (value) return value;
    }
  }

  const metaDescription =
    extractMeta(html, "description") ||
    extractMeta(html, "og:description");

  return metaDescription ? cleanText(metaDescription) : undefined;
}

function extractAlternateTitles(html) {
  if (!html) return undefined;

  const match = html.match(
    /Títulos\s+Alternativos\s*:\s*<\/span>\s*([\s\S]*?)(?:<br\s*\/?>|<\/p>)/i,
  );

  if (!match) return undefined;

  const value = cleanText(match[1]);

  return value || undefined;
}

function extractGenres(html) {
  if (!html) return [];

  const match = html.match(
    /Géneros\s*:\s*<\/span>\s*([\s\S]*?)(?:<br\s*\/?>|<\/p>)/i,
  );

  if (!match) return [];

  return [
    ...match[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi),
  ]
    .map((m) => cleanText(m[1]))
    .filter(Boolean);
}

function extractStatus(html) {
  if (!html) return undefined;

  const match = html.match(
    /Estado\s*:\s*<\/span>\s*([^<]+)(?:<br\s*\/?>|<\/p>)/i,
  );

  if (!match) return undefined;

  const value = cleanText(match[1]);

  return value ? value.toLowerCase() : undefined;
}

// ============================================================
// Capítulos
// ============================================================

function chapterNumberFromUrl(url) {
  if (!url) return null;

  const parts = String(url)
    .split("/")
    .filter(Boolean);

  if (!parts.length) return null;

  return parts[parts.length - 1] || null;
}

function cleanChapterTitle(text, number) {
  let title = cleanText(text);

  if (!title) {
    return number ? `Capítulo ${number}` : "";
  }

  title = title
    .replace(
      /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
      "",
    )
    .replace(
      /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g,
      "",
    )
    .replace(
      /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
      "",
    );

  title = title
    .replace(
      /\b(?:publicado|publicada|actualizado|actualizada|fecha)\s*:?\s*/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!title) {
    return number ? `Capítulo ${number}` : "";
  }

  if (/^#?\s*\d+(?:\.\d+)?$/.test(title)) {
    return `Capítulo ${title.replace(/^#/, "").trim()}`;
  }

  if (
    /^cap(?:ítulo|itulo)?\s*\.?\s*\d+/i.test(title) ||
    /^chapter\s+\d+/i.test(title)
  ) {
    return title;
  }

  return title;
}

function extractChapterFromAnchor(a) {
  if (!a) return null;

  const href = a.attr("href");

  if (!href) return null;

  if (!/\/leer\//i.test(href)) return null;

  const id = absoluteUrl(href);

  if (!id) return null;

  const number = chapterNumberFromUrl(href);

  let title = "";

  const selectors = [
    ".chapter-title",
    ".chapter-name",
    ".chapter-link-title",
    ".title",
    ".name",
    "span",
    "strong",
    "b",
  ];

  for (const selector of selectors) {
    try {
      const node = a.querySelector(selector);

      if (node) {
        const value = cleanText(node.text());

        if (value) {
          title = value;
          break;
        }
      }
    } catch {}
  }

  if (!title) {
    title = cleanText(a.text());
  }

  title = cleanChapterTitle(title, number);

  return {
    id,
    chapter: number,
    title,
    pages: 0,
    language: "es",
  };
}

async function parseChaptersFromHtml(html) {
  if (!html) {
    return {
      chapters: [],
      nextUrls: [],
    };
  }

  let doc;

  try {
    doc = await harbor.parseHtml(html);
  } catch {
    doc = null;
  }

  const chapters = [];
  const seen = new Set();
  const nextUrls = [];

  if (doc) {
    const anchors = doc.querySelectorAll('a[href*="/leer/"]');

    for (const a of anchors) {
      const chapter = extractChapterFromAnchor(a);

      if (!chapter) continue;

      if (seen.has(chapter.id)) continue;

      seen.add(chapter.id);
      chapters.push(chapter);
    }

    const paginationSelectors = [
      'a[href*="before="]',
      'a[href*="page="]',
      'a[rel="next"]',
      'a.next',
      'a.more',
      'a.load-more',
    ];

    for (const selector of paginationSelectors) {
      try {
        const links = doc.querySelectorAll(selector);

        for (const link of links) {
          const href = link.attr("href");

          if (!href) continue;

          const text = cleanText(link.text()).toLowerCase();

          if (
            href.includes("before=") ||
            href.includes("page=") ||
            link.attr("rel") === "next" ||
            /siguiente|más|mas|anteriores|cargar/.test(text)
          ) {
            const url = absoluteUrl(href);

            if (url && !nextUrls.includes(url)) {
              nextUrls.push(url);
            }
          }
        }
      } catch {}
    }
  }

  if (!chapters.length) {
    const matches = [
      ...html.matchAll(
        /<a[^>]+href=["']([^"']*\/leer\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
      ),
    ];

    for (const match of matches) {
      const href = match[1];
      const id = absoluteUrl(href);

      if (!id || seen.has(id)) continue;

      const number = chapterNumberFromUrl(href);
      const title = cleanChapterTitle(match[2], number);

      seen.add(id);

      chapters.push({
        id,
        chapter: number,
        title,
        pages: 0,
        language: "es",
      });
    }
  }

  return {
    chapters,
    nextUrls,
  };
}

// ============================================================
// Páginas del capítulo
// ============================================================

function isLikelyMangaImage(url) {
  if (!url) return false;

  const lower = String(url).toLowerCase();

  if (
    lower.includes("logo") ||
    lower.includes("icon") ||
    lower.includes("favicon") ||
    lower.includes("avatar") ||
    lower.includes("banner") ||
    lower.includes("background") ||
    lower.includes("ads")
  ) {
    return false;
  }

  return true;
}

async function pageUrlsFromImages(html) {
  if (!html) return [];

  let doc;

  try {
    doc = await harbor.parseHtml(html);
  } catch {
    doc = null;
  }

  const urls = [];
  const seen = new Set();

  if (doc) {
    const selectors = [
      "#cascade-view img",
      "img.manga-image",
      "img[class*='manga']",
      "img[class*='chapter']",
      ".reader img",
      ".reading-content img",
    ];

    for (const selector of selectors) {
      try {
        const images = doc.querySelectorAll(selector);

        for (const img of images) {
          const src =
            img.attr("data-src") ||
            img.attr("data-lazy-src") ||
            img.attr("data-original") ||
            img.attr("src");

          const url = absoluteUrl(src);

          if (!url || !isLikelyMangaImage(url)) continue;

          if (seen.has(url)) continue;

          seen.add(url);
          urls.push(url);
        }
      } catch {}
    }

    if (urls.length) return urls;

    try {
      const images = doc.querySelectorAll("img");

      for (const img of images) {
        const src =
          img.attr("data-src") ||
          img.attr("data-lazy-src") ||
          img.attr("data-original") ||
          img.attr("src");

        const url = absoluteUrl(src);

        if (!url || !isLikelyMangaImage(url)) continue;

        if (seen.has(url)) continue;

        seen.add(url);
        urls.push(url);
      }
    } catch {}
  }

  return urls;
}

// ============================================================
// Provider
// ============================================================

const plugin = {
  id: "leercapitulo",
  name: "LeerCapitulo",

  // ----------------------------------------------------------
  // Popular / recientes
  // ----------------------------------------------------------

  async popular(offset, tagId) {
    if (tagId) {
      return this._byGenre(tagId, offset);
    }

    if (offset === 0) {
      const html = await fetchText("/");

      if (html) {
        let cards = [];

        cards = dedupeCardsBySlug([
          ...parseHotMangaBlocks(html),
          ...parseMainpageMangaBlocks(html),
        ]);

        if (cards.length < PAGE_SIZE) {
          const generic = await parseCatalogCardsGeneric(html);

          cards = dedupeCardsBySlug([
            ...cards,
            ...generic,
          ]);
        }

        if (cards.length) {
          return cardsToResults(
            cards.slice(0, PAGE_SIZE),
          );
        }
      }
    }

    const page = Math.floor(offset / PAGE_SIZE) + 1;

    const html = await fetchText(catalogPath({ page }));

    if (!html) return [];

    const cards = await parseCatalogCardsGeneric(html);

    return cardsToResults(cards);
  },

  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;

    const html = await fetchText(
      catalogPath({
        tagId,
        page,
      }),
    );

    if (!html) return [];

    const cards = await parseCatalogCardsGeneric(html);

    return cardsToResults(cards);
  },

  // ----------------------------------------------------------
  // Search (OPTIMIZADO - paralleliza peticiones)
  // ----------------------------------------------------------

  async search(query, offset, tagId) {
    if (!query && tagId) {
      return this._byGenre(tagId, offset);
    }

    if (!query) return [];

    const json = await fetchJson(
      `/search-autocomplete?term=${encodeURIComponent(query)}`,
    );

    if (!Array.isArray(json)) {
      return [];
    }

    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];

    // OPTIMIZACIÓN: Parallelizar peticiones de metadatos con límite de 3 simultáneas
    const MAX_CONCURRENT = 3;
    const batchedRequests = [];

    for (let i = 0; i < page.length; i += MAX_CONCURRENT) {
      const batch = page.slice(i, i + MAX_CONCURRENT);
      const promises = batch.map(async (serie) => {
        if (!serie) return null;

        const id = normalizeId(serie.link);
        if (!id) return null;

        const result = {
          id,
          title: cleanText(serie.label) || "Untitled",
          cover: absoluteUrl(serie.thumbnail),
        };

        // OPTIMIZACIÓN: Solo fetch de detalles si hay pocos resultados (< 10)
        // y solo en batches limitados
        if (json.length <= 10 && serie.link) {
          try {
            const html = await fetchText(serie.link);
            if (html) {
              const altTitle = extractAlternateTitles(html);
              if (altTitle) {
                result.altTitle = altTitle;
              }
            }
          } catch (e) {
            harbor.log(`Error fetching alt title for ${serie.link}: ${e}`);
          }
        }

        summaryCache.set(id, result);
        return result;
      });

      const batchResults = await Promise.all(promises);
      results.push(...batchResults.filter(Boolean));
    }

    return results;
  },

  // ----------------------------------------------------------
  // Detail
  // ----------------------------------------------------------

  async detail(id) {
    const normalizedId = normalizeId(id);

    if (!normalizedId) return null;

    const cached = summaryCache.get(normalizedId);

    const html = await fetchText(normalizedId);

    if (!html) {
      if (cached) {
        return { ...cached };
      }
      return null;
    }

    const title = extractTitle(
      html,
      cached?.title || "Untitled",
    );

    const cover =
      extractFirstImage(html) || cached?.cover;

    const description = extractDescription(html);
    const altTitle =
      extractAlternateTitles(html) || cached?.altTitle;
    const genres = extractGenres(html);
    const status = extractStatus(html);

    let chapters = [];

    try {
      chapters = await this.chapters(normalizedId, html);
    } catch (e) {
      harbor.log(`LeerCapitulo detail chapters error: ${e}`);
    }

    const lastChapter =
      chapters.length > 0
        ? chapters[chapters.length - 1].chapter
        : undefined;

    const result = {
      id: normalizedId,
      title:
        title &&
        title.toLowerCase() !== "untitled"
          ? title
          : cached?.title || "Untitled",
      altTitle,
      cover,
      description,
      status,
      lastChapter,
      genres: genres && genres.length > 0 ? genres.join(", ") : undefined,
    };

    summaryCache.set(normalizedId, {
      id: result.id,
      title: result.title,
      altTitle: result.altTitle,
      cover: result.cover,
    });

    return result;
  },

  // ----------------------------------------------------------
  // Chapters
  // ----------------------------------------------------------

  async chapters(id, cachedHtml) {
    let html = cachedHtml || (await fetchText(id));

    if (!html) return [];

    const allChapters = [];
    const seen = new Set();
    const visitedPages = new Set();

    let currentUrl = normalizeId(id);
    let firstPage = true;

    for (let iteration = 0; iteration < 50; iteration++) {
      if (!html) break;

      if (currentUrl && visitedPages.has(currentUrl)) {
        break;
      }

      if (currentUrl) {
        visitedPages.add(currentUrl);
      }

      const parsed = await parseChaptersFromHtml(html);

      for (const chapter of parsed.chapters) {
        if (!chapter?.id) continue;

        if (seen.has(chapter.id)) continue;

        seen.add(chapter.id);
        allChapters.push(chapter);
      }

      let nextUrl = null;

      const beforeLink = parsed.nextUrls.find((url) =>
        url.includes("before="),
      );

      if (beforeLink) {
        nextUrl = beforeLink;
      } else if (parsed.nextUrls.length) {
        nextUrl = parsed.nextUrls[0];
      }

      if (!nextUrl) break;

      if (visitedPages.has(nextUrl)) break;

      currentUrl = nextUrl;
      html = await fetchText(nextUrl);

      firstPage = false;
    }

    allChapters.sort((a, b) => {
      const na = parseFloat(a.chapter);
      const nb = parseFloat(b.chapter);

      if (!Number.isNaN(na) && !Number.isNaN(nb)) {
        return na - nb;
      }

      return String(a.chapter || "").localeCompare(
        String(b.chapter || ""),
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        },
      );
    });

    return allChapters;
  },

  // ----------------------------------------------------------
  // Page URLs
  // ----------------------------------------------------------

  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);

    if (!html) return [];

    const imageUrls = await pageUrlsFromImages(html);

    if (imageUrls.length) {
      return imageUrls;
    }

    const arrayDataMatch = html.match(
      /id=["']array_data["'][^>]*>([^<]+)</i,
    );

    const arrayData = (arrayDataMatch?.[1] || "").trim();

    const urlList = decodeArrayData(arrayData);

    if (!urlList.length) {
      return [];
    }

    const orderMetaMatch = html.match(
      /property=["']ad:check["'][^>]+content=["']([^"']+)["']/i,
    );

    const orderRaw = orderMetaMatch?.[1] || null;

    if (!orderRaw) {
      return urlList.map(absoluteUrl).filter(Boolean);
    }

    const orderList = orderRaw
      .replace(/[^\d]+/g, "-")
      .split("-")
      .filter(Boolean);

    const useReversed = orderList.some((x) => x === "01");

    const result = orderList
      .map((value) => {
        let index = parseInt(value, 10);

        if (useReversed) {
          index = parseInt(
            value.split("").reverse().join(""),
            10,
          );
        }

        return urlList[index];
      })
      .map(absoluteUrl)
      .filter(Boolean);

    return result.reverse();
  },

  // ----------------------------------------------------------
  // Tags
  // ----------------------------------------------------------

  async tags() {
    const html = await fetchText("/");

    if (!html) return [];

    let doc;

    try {
      doc = await harbor.parseHtml(html);
    } catch {
      return [];
    }

    if (!doc) return [];

    const links = doc.querySelectorAll(
      'a[href*="genre="], a[href*="theme="]',
    );

    const seen = new Set();
    const tags = [];

    for (const a of links) {
      const href = a.attr("href");
      const name = cleanText(a.text());

      if (!href || !name) continue;

      const genreMatch = href.match(/[?&]genre=([^&]+)/);

      const themeMatch = href.match(/[?&]theme=([^&]+)/);

      let id;

      if (genreMatch) {
        id = `genre:${decodeURIComponent(genreMatch[1])}`;
      } else if (themeMatch) {
        id = `theme:${decodeURIComponent(themeMatch[1])}`;
      } else {
        continue;
      }

      if (seen.has(id)) continue;

      seen.add(id);

      tags.push({
        id,
        name,
      });
    }

    return tags;
  },
};

harbor.register(plugin);
