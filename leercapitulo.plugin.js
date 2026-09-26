const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/* =========================================================
 * HTTP
 * ========================================================= */

async function fetchText(path) {
  try {
    let url = path;

    if (!/^https?:\/\//i.test(url)) {
      url = new URL(
        String(path).replace(/^\/+/, "/"),
        BASE_URL + "/"
      ).toString();
    }

    const res = await harbor.http(url, {
      responseType: "text",
      headers: {
        "user-agent": DESKTOP_UA,
      },
    });

    return res?.body || null;
  } catch (e) {
    harbor.log?.(`fetchText error: ${String(e)}`);
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await harbor.http(url, {
      responseType: "json",
      headers: {
        "user-agent": DESKTOP_UA,
      },
    });

    return res?.body ?? res ?? null;
  } catch (e) {
    harbor.log?.(`fetchJson error: ${String(e)}`);
    return null;
  }
}

/* =========================================================
 * URL / TEXTO
 * ========================================================= */

function absoluteUrl(url) {
  if (!url) return null;

  try {
    return new URL(url, BASE_URL).toString();
  } catch {
    return null;
  }
}

function decodeEntities(value) {
  if (!value) return "";

  return String(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(Number(n));
      } catch {
        return _;
      }
    });
}

function cleanText(value) {
  if (!value) return "";

  return decodeEntities(
    String(value)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/* =========================================================
 * MANGA ID
 *
 * Los mangas reales tienen URLs como:
 *
 * /manga/byywymjdxc/u-dont-know-me/
 *
 * Por eso guardamos los dos segmentos juntos:
 *
 * byywymjdxc/u-dont-know-me
 * ========================================================= */

function slugFromMangaHref(href) {
  if (!href) return null;

  const match = String(href).match(
    /\/manga\/([^?#]+?)\/?(?:[?#]|$)/i
  );

  if (!match || !match[1]) return null;

  return match[1];
}

function encodeMangaId(rawPath) {
  return encodeURIComponent(rawPath);
}

function decodeMangaId(id) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/*
 * Convierte cualquier representación del manga
 * en su URL real.
 *
 * Acepta:
 *
 * byywymjdxc/u-dont-know-me
 *
 * /manga/byywymjdxc/u-dont-know-me/
 *
 * https://www.leercapitulo.co/manga/byywymjdxc/u-dont-know-me/
 */
function mangaUrlFromId(id) {
  if (!id) return null;

  const value = String(id).trim();

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  if (/^\/manga\//i.test(value)) {
    return absoluteUrl(value);
  }

  const decoded = decodeMangaId(value).trim();

  if (/^https?:\/\//i.test(decoded)) {
    return decoded;
  }

  if (/^\/manga\//i.test(decoded)) {
    return absoluteUrl(decoded);
  }

  return `${BASE_URL}/manga/${decoded.replace(
    /^\/+|\/+$/g,
    ""
  )}/`;
}

/* =========================================================
 * ARRAY DATA
 * ========================================================= */

const K2_TO_K1 = {
  "Z": "0",
  "p": "1",
  "Q": "2",
  "x": "3",
  "R": "4",
  "m": "5",
  "V": "6",
  "a": "7",
  "N": "8",
  "k": "9",
  "b": "A",
  "T": "B",
  "w": "C",
  "c": "D",
  "L": "E",
  "d": "F",
  "Y": "G",
  "f": "H",
  "U": "I",
  "h": "J",
  "i": "K",
  "O": "L",
  "j": "M",
  "K": "N",
  "l": "O",
  "M": "P",
  "n": "Q",
  "P": "R",
  "q": "S",
  "H": "T",
  "r": "U",
  "S": "V",
  "t": "W",
  "u": "X",
  "I": "Y",
  "v": "Z",
  "+": "+",
  "/": "/",
  "=": "=",
};

function decodeArrayData(value) {
  if (!value) return [];

  try {
    const encoded = String(value)
      .split("")
      .map((char) => K2_TO_K1[char] ?? char)
      .join("");

    const decoded = atob(encoded);

    return decoded
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean)
      .map(absoluteUrl)
      .filter(Boolean);
  } catch (e) {
    harbor.log?.(`decodeArrayData error: ${String(e)}`);
    return [];
  }
}

/* =========================================================
 * CACHE
 * ========================================================= */

const summaryCache = new Map();

/* =========================================================
 * HOME / BUSQUEDA
 *
 * Esta parte se mantiene como la versión que ya funcionaba.
 * ========================================================= */

function extractMangaAnchors(html) {
  if (!html) return [];

  const re =
    /<a[^>]+href=["'](\/manga\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  const result = [];

  let match;

  while ((match = re.exec(html)) !== null) {
    result.push({
      href: match[1],
      inner: match[2],
    });
  }

  return result;
}

function parseMangaCards(html) {
  if (!html) return [];

  const anchors = extractMangaAnchors(html);

  const groups = new Map();

  for (const anchor of anchors) {
    const rawId = slugFromMangaHref(anchor.href);

    if (!rawId) continue;

    let cover = null;
    let title = "";

    const imageMatch = anchor.inner.match(
      /<img[^>]+(?:data-src|src)=["']([^"']+)["']/i
    );

    if (imageMatch) {
      cover = absoluteUrl(imageMatch[1]);
    }

    const altMatch = anchor.inner.match(
      /<img[^>]+alt=["']([^"']+)["']/i
    );

    if (altMatch) {
      title = cleanText(
        altMatch[1]
          .replace(/^Portada de\s*/i, "")
          .trim()
      );
    }

    if (!title) {
      const headingMatch = anchor.inner.match(
        /<(?:h[1-6]|span|strong|b)[^>]*>([\s\S]*?)<\/(?:h[1-6]|span|strong|b)>/i
      );

      if (headingMatch) {
        title = cleanText(headingMatch[1]);
      }
    }

    if (!title) {
      title = cleanText(anchor.inner);
    }

    if (!groups.has(rawId)) {
      groups.set(rawId, {
        rawId,
        cover,
        title,
      });
    } else {
      const existing = groups.get(rawId);

      if (!existing.cover && cover) {
        existing.cover = cover;
      }

      if (!existing.title && title) {
        existing.title = title;
      }
    }
  }

  return Array.from(groups.values()).filter(
    (item) => item.cover && item.title
  );
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const result = [];

  for (const card of cards) {
    if (!card?.rawId) continue;

    if (seen.has(card.rawId)) continue;

    seen.add(card.rawId);
    result.push(card);
  }

  return result;
}

function cardsToResults(cards) {
  return dedupeCardsBySlug(cards).map((card) => {
    const id = encodeMangaId(card.rawId);

    const result = {
      id,
      title: card.title,
      cover: absoluteUrl(card.cover),
    };

    summaryCache.set(id, {
      id,
      title: result.title,
      cover: result.cover,
    });

    return result;
  });
}

/* =========================================================
 * PROVIDER
 * ========================================================= */

const plugin = {
  id: "usvusr",
  name: "LeerCapitulo",

  /* =======================================================
   * POPULAR
   * ======================================================= */

  async popular(offset, tagId) {
    if (tagId) {
      return this._byGenre(offset, tagId);
    }

    const page =
      Math.floor(Number(offset || 0) / PAGE_SIZE) + 1;

    const path =
      page <= 1
        ? "/"
        : `/manga/?page=${page}`;

    const html = await fetchText(path);

    if (!html) return [];

    const cards = parseMangaCards(html);

    return cardsToResults(cards).slice(0, PAGE_SIZE);
  },

  /* =======================================================
   * GENEROS
   * ======================================================= */

  async _byGenre(offset, tagId) {
    const page =
      Math.floor(Number(offset || 0) / PAGE_SIZE) + 1;

    const encodedTag = encodeURIComponent(tagId);

    const path =
      `/manga/?genre=${encodedTag}&page=${page}`;

    const html = await fetchText(path);

    if (!html) return [];

    const cards = parseMangaCards(html);

    return cardsToResults(cards).slice(0, PAGE_SIZE);
  },

  /* =======================================================
   * SEARCH
   * ======================================================= */

  async search(query, offset, tagId) {
    if (!query) return [];

    const term = String(query).trim();

    if (!term) return [];

    const url =
      `${BASE_URL}/search-autocomplete?term=${encodeURIComponent(term)}`;

    const data = await fetchJson(url);

    if (!Array.isArray(data)) {
      return [];
    }

    const results = [];

    for (const item of data) {
      if (!item) continue;

      const href =
        item.link ||
        item.url ||
        item.href;

      const rawId = slugFromMangaHref(href);

      if (!rawId) continue;

      const id = encodeMangaId(rawId);

      const title =
        cleanText(
          item.label ||
          item.title ||
          item.name ||
          ""
        ) || rawId;

      const cover = absoluteUrl(
        item.thumbnail ||
        item.cover ||
        item.image
      );

      const result = {
        id,
        title,
        cover,
      };

      summaryCache.set(id, {
        id,
        title,
        cover,
      });

      results.push(result);
    }

    const start = Number(offset || 0);

    return results.slice(
      start,
      start + PAGE_SIZE
    );
  },

  /* =======================================================
   * DETAIL
   *
   * IMPORTANTE:
   * Aquí usamos mangaUrlFromId() y pasamos la misma URL
   * junto con el HTML a chapters().
   * ======================================================= */

  async detail(id) {
    if (!id) return null;

    const cached = summaryCache.get(id);

    const mangaUrl = mangaUrlFromId(id);

    if (!mangaUrl) {
      return cached ? { ...cached } : null;
    }

    harbor.log?.(
      `LeerCapitulo detail URL: ${mangaUrl}`
    );

    const html = await fetchText(mangaUrl);

    if (!html) {
      harbor.log?.(
        `LeerCapitulo: no se pudo cargar la ficha ${mangaUrl}`
      );

      if (cached) {
        return { ...cached };
      }

      return null;
    }

    /* -----------------------------------------------------
     * TITULO
     * ----------------------------------------------------- */

    const titleMatch = html.match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/i
    );

    const title =
      titleMatch
        ? cleanText(titleMatch[1])
        : cached?.title || id;

    /* -----------------------------------------------------
     * TITULO ALTERNATIVO
     * ----------------------------------------------------- */

    const altMatch = html.match(
      /<p class="small lc-muted mb-2">([\s\S]*?)<\/p>/i
    );

    let altTitle;

    if (altMatch) {
      const parts = cleanText(altMatch[1])
        .split("·")
        .map((s) => s.trim())
        .filter(Boolean);

      if (parts.length) {
        altTitle = parts.join(", ");
      }
    }

    /* -----------------------------------------------------
     * PORTADA
     * ----------------------------------------------------- */

    const coverMatch = html.match(
      /<div class="lc-cover-lg">[\s\S]*?<img[^>]+src=["']([^"']+)["']/i
    );

    const cover =
      absoluteUrl(
        coverMatch?.[1]
      ) ||
      cached?.cover;

    /* -----------------------------------------------------
     * SINOPSIS
     * ----------------------------------------------------- */

    const synopsisMatch = html.match(
      /id=["']sinopsis["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
    );

    let description;

    if (synopsisMatch) {
      const text = cleanText(
        synopsisMatch[1]
      );

      if (
        text &&
        !text
          .toLowerCase()
          .includes("no tiene sinopsis")
      ) {
        description = text;
      }
    }

    /* -----------------------------------------------------
     * ESTADO
     * ----------------------------------------------------- */

    const statusBlockMatch = html.match(
      /<span class="k">Estado<\/span>([\s\S]*?)<\/li>/i
    );

    let status;

    if (statusBlockMatch) {
      const statusRaw = cleanText(
        statusBlockMatch[1]
      ).toLowerCase();

      if (
        statusRaw.includes("curso") ||
        statusRaw.includes("ongoing")
      ) {
        status = "ongoing";
      } else if (
        statusRaw.includes("complet") ||
        statusRaw.includes("finaliz")
      ) {
        status = "completed";
      }
    }

    /* -----------------------------------------------------
     * AUTOR
     * ----------------------------------------------------- */

    const authorMatch = html.match(
      /<span class="k">Autor<\/span>([\s\S]*?)<\/li>/i
    );

    const author =
      authorMatch
        ? cleanText(authorMatch[1]) || undefined
        : undefined;

    /* -----------------------------------------------------
     * CAPITULOS
     *
     * Pasamos la URL real y el HTML ya descargado.
     * ----------------------------------------------------- */

    const chapters = await plugin.chapters(
      mangaUrl,
      html
    );

    harbor.log?.(
      `LeerCapitulo: capítulos encontrados: ${chapters.length}`
    );

    const lastChapter =
      chapters.length > 0
        ? chapters[chapters.length - 1].chapter
        : undefined;

    const result = {
      id,
      title,
      altTitle,
      cover,
      description,
      status,
      lastChapter,
      author,
    };

    summaryCache.set(id, {
      id: result.id,
      title: result.title,
      cover: result.cover,
    });

    return result;
  },

  /* =======================================================
   * CHAPTERS
   *
   * Primero intenta DOM.
   * Si Harbor no permite ese selector o falla el parseo,
   * usa regex como fallback.
   * ======================================================= */

  async chapters(id, cachedHtml) {
    let html = cachedHtml;

    if (!html) {
      const mangaUrl = mangaUrlFromId(id);

      if (!mangaUrl) {
        harbor.log?.(
          `LeerCapitulo chapters: URL inválida para ${id}`
        );

        return [];
      }

      harbor.log?.(
        `LeerCapitulo chapters URL: ${mangaUrl}`
      );

      html = await fetchText(mangaUrl);
    }

    if (!html) {
      harbor.log?.(
        "LeerCapitulo chapters: HTML vacío"
      );

      return [];
    }

    const chapters = [];
    const seen = new Set();

    /* =====================================================
     * PRIMER INTENTO: DOM
     * ===================================================== */

    try {
      const doc = harbor.parseHtml(html);

      if (doc) {
        const anchors = doc.querySelectorAll(
          'a.lc-chapter-row[href*="/leer/"], a[href*="/leer/"]'
        );

        for (const anchor of anchors) {
          const href =
            anchor.getAttribute("href");

          if (!href) continue;

          if (!href.includes("/leer/")) {
            continue;
          }

          const chapterId =
            absoluteUrl(href);

          if (!chapterId) continue;

          if (seen.has(chapterId)) {
            continue;
          }

          seen.add(chapterId);

          let title = "";
          let chapterNumber = null;
          let publishAt;

          const numberNode =
            anchor.querySelector(".n");

          const dateNode =
            anchor.querySelector(".d");

          if (numberNode) {
            title = cleanText(
              numberNode.textContent
            );
          }

          if (dateNode) {
            publishAt = cleanText(
              dateNode.textContent
            );
          }

          const parts = href
            .split("/")
            .filter(Boolean);

          const number =
            parts.length > 0
              ? parts[parts.length - 1]
              : null;

          chapterNumber =
            number || null;

          if (!title && chapterNumber) {
            title =
              `Capítulo ${chapterNumber}`;
          }

          if (!title) {
            title =
              cleanText(
                anchor.textContent
              );
          }

          if (!title) {
            title = "Sin título";
          }

          chapters.push({
            id: chapterId,
            chapter: chapterNumber,
            title,
            pages: 0,
            language: "es",
            publishAt,
          });
        }
      }
    } catch (e) {
      harbor.log?.(
        `LeerCapitulo DOM chapters error: ${String(e)}`
      );
    }

    /* =====================================================
     * FALLBACK REGEX
     *
     * Se ejecuta si el DOM no encontró nada.
     * ===================================================== */

    if (chapters.length === 0) {
      const anchorRe =
        /<a[^>]+href=["']([^"']*\/leer\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

      let match;

      while ((match = anchorRe.exec(html)) !== null) {
        const href = match[1];
        const inner = match[2];

        const chapterId =
          absoluteUrl(href);

        if (!chapterId) continue;

        if (seen.has(chapterId)) {
          continue;
        }

        seen.add(chapterId);

        const numSpan =
          inner.match(
            /<span[^>]*class=["'][^"']*\bn\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
          );

        const dateSpan =
          inner.match(
            /<span[^>]*class=["'][^"']*\bd\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
          );

        const parts = href
          .split("/")
          .filter(Boolean);

        const number =
          parts.length > 0
            ? parts[parts.length - 1]
            : null;

        let title =
          numSpan
            ? cleanText(numSpan[1])
            : cleanText(inner);

        if (!title && number) {
          title =
            `Capítulo ${number}`;
        }

        if (!title) {
          title =
            number || "Sin título";
        }

        chapters.push({
          id: chapterId,
          chapter: number,
          title,
          pages: 0,
          language: "es",
          publishAt:
            dateSpan
              ? cleanText(dateSpan[1])
              : undefined,
        });
      }
    }

    /* =====================================================
     * ORDEN
     *
     * Harbor espera normalmente los capítulos desde el
     * primero hasta el último.
     * ===================================================== */

    chapters.sort((a, b) => {
      const na = parseFloat(
        String(a.chapter ?? "").replace(",", ".")
      );

      const nb = parseFloat(
        String(b.chapter ?? "").replace(",", ".")
      );

      if (
        Number.isFinite(na) &&
        Number.isFinite(nb)
      ) {
        return na - nb;
      }

      if (Number.isFinite(na)) return -1;
      if (Number.isFinite(nb)) return 1;

      return String(a.title || "").localeCompare(
        String(b.title || ""),
        "es",
        {
          numeric: true,
          sensitivity: "base",
        }
      );
    });

    harbor.log?.(
      `LeerCapitulo: total capítulos = ${chapters.length}`
    );

    return chapters;
  },

  /* =======================================================
   * PAGE URLS
   * ======================================================= */

  async pageUrls(chapterId) {
    if (!chapterId) return [];

    const html = await fetchText(chapterId);

    if (!html) {
      return [];
    }

    /* -----------------------------------------------------
     * PRIMER INTENTO:
     * IMÁGENES DIRECTAS
     * ----------------------------------------------------- */

    const imageUrls = [];

    const imageRe =
      /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["']/gi;

    const ignoredImage =
      /logo|icon|avatar|favicon|sprite|banner|ads?|google|facebook|twitter|discord/i;

    let match;

    while ((match = imageRe.exec(html)) !== null) {
      const url = absoluteUrl(match[1]);

      if (!url) continue;

      if (ignoredImage.test(url)) {
        continue;
      }

      if (!imageUrls.includes(url)) {
        imageUrls.push(url);
      }
    }

    if (imageUrls.length > 0) {
      return imageUrls;
    }

    /* -----------------------------------------------------
     * SEGUNDO INTENTO:
     * array_data
     * ----------------------------------------------------- */

    const arrayMatch =
      html.match(
        /(?:array_data|array-data)\s*["'=:\s]+["']([^"']+)["']/i
      );

    if (arrayMatch) {
      const decoded =
        decodeArrayData(arrayMatch[1]);

      if (decoded.length > 0) {
        return decoded;
      }
    }

    /* -----------------------------------------------------
     * TERCER INTENTO:
     * ad:check / contenido JS
     * ----------------------------------------------------- */

    const adCheckMatch =
      html.match(
        /ad:check[\s\S]{0,5000}?["']([^"']+)["']/i
      );

    if (adCheckMatch) {
      const decoded =
        decodeArrayData(adCheckMatch[1]);

      if (decoded.length > 0) {
        return decoded;
      }
    }

    return [];
  },

  /* =======================================================
   * TAGS
   * ======================================================= */

  async tags() {
    return [
      {
        id: "accion",
        title: "Acción",
      },
      {
        id: "aventura",
        title: "Aventura",
      },
      {
        id: "comedia",
        title: "Comedia",
      },
      {
        id: "drama",
        title: "Drama",
      },
      {
        id: "fantasia",
        title: "Fantasía",
      },
      {
        id: "romance",
        title: "Romance",
      },
      {
        id: "isekai",
        title: "Isekai",
      },
      {
        id: "reencarnacion",
        title: "Reencarnación",
      },
      {
        id: "artes-marciales",
        title: "Artes Marciales",
      },
      {
        id: "cultivo",
        title: "Cultivo",
      },
      {
        id: "historico",
        title: "Histórico",
      },
      {
        id: "militar",
        title: "Militar",
      },
      {
        id: "misterio",
        title: "Misterio",
      },
      {
        id: "psicologico",
        title: "Psicológico",
      },
      {
        id: "sobrenatural",
        title: "Sobrenatural",
      },
      {
        id: "thriller",
        title: "Thriller",
      },
      {
        id: "web-novel",
        title: "Web Novel",
      },
      {
        id: "novela-ligera",
        title: "Novela Ligera",
      },
    ];
  },
};

export default plugin;
