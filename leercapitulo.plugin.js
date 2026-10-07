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
      url = new URL(String(path).replace(/^\/+/, "/"), BASE_URL + "/").toString();
    }

    const res = await harbor.http(url, {
      responseType: "text",
      headers: { "user-agent": DESKTOP_UA },
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
      headers: { "user-agent": DESKTOP_UA },
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
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (match, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
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
 * Las URLs reales son del tipo:
 *   /manga/byywymjdxc/u-dont-know-me/
 * Guardamos los dos segmentos juntos: "byywymjdxc/u-dont-know-me"
 * ========================================================= */

function slugFromMangaHref(href) {
  if (!href) return null;

  const match = String(href).match(/\/manga\/([^?#]+?)\/?(?:[?#]|$)/i);

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
 * Convierte cualquier representación del manga en su URL real.
 * Acepta: "byywymjdxc/u-dont-know-me", "/manga/…/", o una URL completa.
 */
function mangaUrlFromId(id) {
  if (!id) return null;

  const value = decodeMangaId(String(id).trim()).trim();

  if (/^https?:\/\//i.test(value)) return value;

  if (/^\/manga\//i.test(value)) return absoluteUrl(value);

  return `${BASE_URL}/manga/${value.replace(/^\/+|\/+$/g, "")}/`;
}

/* =========================================================
 * ARRAY DATA (cifrado de páginas del lector)
 * ========================================================= */

const K2_TO_K1 = {
  Z: "0", p: "1", Q: "2", x: "3", R: "4", m: "5", V: "6", a: "7", N: "8", k: "9",
  b: "A", T: "B", w: "C", c: "D", L: "E", d: "F", Y: "G", f: "H", U: "I", h: "J",
  i: "K", O: "L", j: "M", K: "N", l: "O", M: "P", n: "Q", P: "R", q: "S", H: "T",
  r: "U", S: "V", t: "W", u: "X", I: "Y", v: "Z",
  "+": "+", "/": "/", "=": "=",
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
 * PARSEO DE TARJETAS (home, catálogo, búsqueda)
 * ========================================================= */

function extractMangaAnchors(html) {
  if (!html) return [];

  const re = /<a[^>]+href=["'](\/manga\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const result = [];
  let match;

  while ((match = re.exec(html)) !== null) {
    result.push({ href: match[1], inner: match[2] });
  }

  return result;
}

function parseMangaCards(html) {
  if (!html) return [];

  const groups = new Map();

  for (const anchor of extractMangaAnchors(html)) {
    const rawId = slugFromMangaHref(anchor.href);
    if (!rawId) continue;

    let cover = null;
    let title = "";

    const imageMatch = anchor.inner.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
    if (imageMatch) cover = absoluteUrl(imageMatch[1]);

    const altMatch = anchor.inner.match(/<img[^>]+alt=["']([^"']+)["']/i);
    if (altMatch) {
      title = cleanText(altMatch[1].replace(/^Portada de\s*/i, "").trim());
    }

    if (!title) {
      const headingMatch = anchor.inner.match(
        /<(?:h[1-6]|span|strong|b)[^>]*>([\s\S]*?)<\/(?:h[1-6]|span|strong|b)>/i
      );
      if (headingMatch) title = cleanText(headingMatch[1]);
    }

    if (!title) title = cleanText(anchor.inner);

    if (!groups.has(rawId)) {
      groups.set(rawId, { rawId, cover, title });
    } else {
      const existing = groups.get(rawId);
      if (!existing.cover && cover) existing.cover = cover;
      if (!existing.title && title) existing.title = title;
    }
  }

  return Array.from(groups.values()).filter((item) => item.cover && item.title);
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const result = [];

  for (const card of cards) {
    if (!card?.rawId || seen.has(card.rawId)) continue;
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

    summaryCache.set(id, { ...result });
    return result;
  });
}

/* =========================================================
 * PROVIDER
 * ========================================================= */

const plugin = {
  id: "usvusr",
  name: "LeerCapitulo",

  /* ---------- POPULAR ---------- */

  async popular(offset, tagId) {
    if (tagId) {
      return plugin._byGenre(offset, tagId);
    }

    const page = Math.floor(Number(offset || 0) / PAGE_SIZE) + 1;
    const path = page <= 1 ? "/manga/" : `/manga/?page=${page}`;

    const html = await fetchText(path);
    if (!html) return [];

    return cardsToResults(parseMangaCards(html)).slice(0, PAGE_SIZE);
  },

  /* ---------- GÉNEROS ---------- */

  async _byGenre(offset, tagId) {
    const page = Math.floor(Number(offset || 0) / PAGE_SIZE) + 1;
    const path = `/manga/?genre=${encodeURIComponent(tagId)}&page=${page}`;

    const html = await fetchText(path);
    if (!html) return [];

    return cardsToResults(parseMangaCards(html)).slice(0, PAGE_SIZE);
  },

  /* ---------- SEARCH ---------- */

  async search(query, offset) {
    const term = String(query || "").trim();
    if (!term) return [];

    const url = `${BASE_URL}/search-autocomplete?term=${encodeURIComponent(term)}`;
    const data = await fetchJson(url);

    if (!Array.isArray(data)) return [];

    const results = [];

    for (const item of data) {
      if (!item) continue;

      const href = item.link || item.url || item.href;
      const rawId = slugFromMangaHref(href);
      if (!rawId) continue;

      const id = encodeMangaId(rawId);
      const title = cleanText(item.label || item.title || item.name || "") || rawId;
      const cover = absoluteUrl(item.thumbnail || item.cover || item.image);

      const result = { id, title, cover };
      summaryCache.set(id, { ...result });
      results.push(result);
    }

    const start = Number(offset || 0);
    return results.slice(start, start + PAGE_SIZE);
  },

  /* ---------- DETAIL ----------
   * Descarga la ficha una sola vez y se la pasa a chapters()
   * para no volver a pedir la misma página. */

  async detail(id) {
    if (!id) return null;

    const cached = summaryCache.get(id);
    const mangaUrl = mangaUrlFromId(id);

    if (!mangaUrl) return cached ? { ...cached } : null;

    harbor.log?.(`LeerCapitulo detail URL: ${mangaUrl}`);

    const html = await fetchText(mangaUrl);

    if (!html) {
      harbor.log?.(`LeerCapitulo: no se pudo cargar la ficha ${mangaUrl}`);
      return cached ? { ...cached } : null;
    }

    /* Título */
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : cached?.title || id;

    /* Títulos alternativos */
    let altTitle;
    const altMatch = html.match(/<p class="small lc-muted mb-2">([\s\S]*?)<\/p>/i);
    if (altMatch) {
      const parts = cleanText(altMatch[1])
        .split("·")
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length) altTitle = parts.join(", ");
    }

    /* Portada */
    const coverMatch = html.match(/<div class="lc-cover-lg">[\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
    const cover = absoluteUrl(coverMatch?.[1]) || cached?.cover;

    /* Sinopsis */
    let description;
    const synopsisMatch = html.match(/id=["']sinopsis["'][\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (synopsisMatch) {
      const text = cleanText(synopsisMatch[1]);
      if (text && !text.toLowerCase().includes("no tiene sinopsis")) {
        description = text;
      }
    }

    /* Estado */
    let status;
    const statusBlockMatch = html.match(/<span class="k">Estado<\/span>([\s\S]*?)<\/li>/i);
    if (statusBlockMatch) {
      const statusRaw = cleanText(statusBlockMatch[1]).toLowerCase();
      if (statusRaw.includes("curso") || statusRaw.includes("ongoing")) {
        status = "ongoing";
      } else if (statusRaw.includes("complet") || statusRaw.includes("finaliz")) {
        status = "completed";
      }
    }

    /* Autor */
    const authorMatch = html.match(/<span class="k">Autor<\/span>([\s\S]*?)<\/li>/i);
    const author = authorMatch ? cleanText(authorMatch[1]) || undefined : undefined;

    /* Capítulos (reutiliza el HTML ya descargado) */
    const chapters = await plugin.chapters(mangaUrl, html);

    harbor.log?.(`LeerCapitulo: capítulos encontrados: ${chapters.length}`);

    const lastChapter = chapters.length ? chapters[chapters.length - 1].chapter : undefined;

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

    summaryCache.set(id, { id, title, cover });
    return result;
  },

  /* ---------- CHAPTERS ----------
   * Acepta opcionalmente el HTML ya descargado. */

  async chapters(id, prefetchedHtml) {
    const mangaUrl = mangaUrlFromId(id);
    if (!mangaUrl) return [];

    const html = prefetchedHtml || (await fetchText(mangaUrl));
    if (!html) return [];

    const chapters = [];
    const seen = new Set();

    /* Enlaces del tipo /leer/<id>/<slug>/<numero>/ */
    const re = /<a\b[^>]*href=["']([^"']*\/leer\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;
    while ((match = re.exec(html)) !== null) {
      const href = match[1];
      const inner = match[2];

      const chapterUrl = absoluteUrl(href);
      if (!chapterUrl || seen.has(chapterUrl)) continue;
      seen.add(chapterUrl);

      /* Número: último segmento numérico de la URL */
      const cleanHref = href.split("?")[0].split("#")[0];
      const parts = cleanHref.split("/").filter(Boolean);

      let chapter = null;
      if (parts.length) {
        const last = parts[parts.length - 1];
        if (/^\d+(?:\.\d+)?$/.test(last)) chapter = last;
      }

      /* Fecha: se extrae y se quita antes de limpiar el título,
       * para que no aparezca dentro del título del capítulo. */
      let publishAt;
      const dateMatch = inner.match(
        /<span[^>]*class=["'][^"']*\bd\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
      );
      if (dateMatch) publishAt = cleanText(dateMatch[1]) || undefined;

      const innerWithoutDate = inner.replace(
        /<span[^>]*class=["'][^"']*\bd\b[^"']*["'][^>]*>[\s\S]*?<\/span>/gi,
        " "
      );

      let title = cleanText(innerWithoutDate);

      const numberMatch = title.match(/Cap[ií]tulo\s+([0-9]+(?:\.[0-9]+)?)/i);
      if (numberMatch) chapter = numberMatch[1];

      if (!title) {
        title = chapter ? `Capítulo ${chapter}` : "Sin título";
      }

      chapters.push({
        id: chapterUrl,
        chapter,
        title,
        pages: 1,
        language: "es",
        publishAt,
      });
    }

    chapters.sort((a, b) => {
      const na = parseFloat(a.chapter);
      const nb = parseFloat(b.chapter);

      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;

      return String(a.title).localeCompare(String(b.title), "es", {
        numeric: true,
        sensitivity: "base",
      });
    });

    return chapters;
  },

  /* ---------- PAGE URLS ----------
   * Las imágenes del lector son lazy (data-src). */

  async pageUrls(chapterId) {
    if (!chapterId) return [];

    const html = await fetchText(chapterId);
    if (!html) return [];

    /* PRIMER INTENTO: imágenes directas */
    const imageUrls = [];
    const imageRe = /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["']/gi;

    let match;
    while ((match = imageRe.exec(html)) !== null) {
      const url = absoluteUrl(match[1]);
      if (!url || isIgnoredImage(url) || imageUrls.includes(url)) continue;
      imageUrls.push(url);
    }

    if (imageUrls.length > 0) return imageUrls;

    /* SEGUNDO INTENTO: array_data cifrado */
    const arrayMatch = html.match(/(?:array_data|array-data)\s*["'=:\s]+["']([^"']+)["']/i);
    if (arrayMatch) {
      const decoded = decodeArrayData(arrayMatch[1]);
      if (decoded.length > 0) return decoded;
    }

    /* TERCER INTENTO: ad:check */
    const adCheckMatch = html.match(/ad:check[\s\S]{0,5000}?["']([^"']+)["']/i);
    if (adCheckMatch) {
      const decoded = decodeArrayData(adCheckMatch[1]);
      if (decoded.length > 0) return decoded;
    }

    return [];
  },

  /* ---------- TAGS ----------
   * Solo ids que existen como ?genre= en el sitio. */

  async tags() {
    return [
      { id: "accion", title: "Acción" },
      { id: "aventura", title: "Aventura" },
      { id: "comedia", title: "Comedia" },
      { id: "drama", title: "Drama" },
      { id: "fantasia", title: "Fantasía" },
      { id: "romance", title: "Romance" },
      { id: "isekai", title: "Isekai" },
      { id: "reencarnacion", title: "Reencarnación" },
      { id: "artes-marciales", title: "Artes Marciales" },
      { id: "historical", title: "Histórico" },
      { id: "militar", title: "Militar" },
      { id: "misterio", title: "Misterio" },
      { id: "psicologico", title: "Psicológico" },
      { id: "sobrenatural", title: "Sobrenatural" },
      { id: "thriller", title: "Thriller" },
    ];
  },
};

/* Filtra logos, iconos y anuncios mirando solo el pathname,
 * con límites de palabra para no descartar páginas reales
 * (antes "ads?" coincidía con cualquier "ad" dentro de un hash). */
const IGNORED_IMAGE_RE =
  /(?:^|[\/._-])(logo|icon|avatar|favicon|sprite|banner|ads?|google|facebook|twitter|discord)(?:[\/._-]|$)/i;

function isIgnoredImage(url) {
  try {
    return IGNORED_IMAGE_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export default plugin;
