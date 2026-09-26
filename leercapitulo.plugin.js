// leercapitulo.co — Harbor MangaProvider
// V3 — estructura actual de LeerCapítulo
//
// Cambios principales:
// - Fichas adaptadas al HTML actual.
// - Los capítulos se detectan directamente mediante /leer/.
// - Se extraen título, títulos alternativos, géneros, estado, autor,
//   dibujo y sinopsis desde la ficha actual.
// - El lector obtiene las imágenes directamente desde <img>.
// - array_data queda como fallback para versiones antiguas.
// - Mantiene search-autocomplete y catálogo.
// - Compatible con Harbor MangaProvider.

const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48;

// ---------------------------------------------------------------------------
// RED
// ---------------------------------------------------------------------------

async function fetchText(path) {
  try {
    const url = path.startsWith("http")
      ? path
      : `${BASE_URL}${path}`;

    const res = await harbor.http(url, {
      responseType: "text",
    });

    if (!res || !res.ok) return null;

    return typeof res.body === "string" ? res.body : null;
  } catch (e) {
    harbor.log(`NETWORK ${path}: ${String(e).slice(0, 200)}`);
    return null;
  }
}

async function fetchJson(path) {
  try {
    const url = path.startsWith("http")
      ? path
      : `${BASE_URL}${path}`;

    const json = await harbor.http(url, {
      responseType: "json",
    });

    return json == null ? null : json;
  } catch (e) {
    harbor.log(`JSON NETWORK ${path}: ${String(e).slice(0, 200)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------------

function absoluteUrl(url) {
  if (!url) return undefined;

  try {
    return new URL(url, BASE_URL).toString();
  } catch (e) {
    return undefined;
  }
}

function cleanText(value) {
  if (!value) return "";

  return String(value)
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function decodeEntities(str) {
  if (!str) return "";

  return String(str)
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function pageFromOffset(offset) {
  return Math.floor((offset || 0) / PAGE_SIZE) + 1;
}

function slugFromMangaHref(href) {
  if (!href) return "";

  const parts = href.split("/").filter(Boolean);

  if (parts[0] === "manga") {
    return parts[1] || href;
  }

  return href;
}

// ---------------------------------------------------------------------------
// TARJETAS DE MANGA
// ---------------------------------------------------------------------------

function parseHotMangaBlocks(html) {
  const results = [];

  const re =
    /<div class="hot-manga[^"]*"[\s\S]*?<a href="(\/manga\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]*(?:data-src|src)="([^"]+)"[\s\S]*?<h3 class="manga-title">([^<]+)<\/h3>/gi;

  let m;

  while ((m = re.exec(html)) !== null) {
    results.push({
      href: m[1],
      cover: m[2],
      title: decodeEntities(m[3]),
    });
  }

  return results;
}

function parseMainpageMangaBlocks(html) {
  const results = [];

  const re =
    /<div class="media-left cover-manga">[\s\S]*?<a href="(\/manga\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]*(?:data-src|src)="([^"]+)"[\s\S]*?<h4 class="manga-newest">([^<]+)<\/h4>/gi;

  let m;

  while ((m = re.exec(html)) !== null) {
    results.push({
      href: m[1],
      cover: m[2],
      title: decodeEntities(m[3]),
    });
  }

  return results;
}

async function parseCatalogCards(html) {
  if (!html) return [];

  let doc;

  try {
    doc = await harbor.parseHtml(html);
  } catch (e) {
    return [];
  }

  if (!doc) return [];

  const anchors = doc.querySelectorAll('a[href^="/manga/"]');

  const bySlug = new Map();

  for (const a of anchors) {
    const href = a.attr("href");

    if (!href) continue;

    const slug = slugFromMangaHref(href);

    if (!slug) continue;

    const text = cleanText(a.text());

    const img = a.querySelector
      ? a.querySelector("img")
      : null;

    let cover;

    if (img) {
      cover =
        img.attr("data-src") ||
        img.attr("data-lazy-src") ||
        img.attr("src");
    }

    let item = bySlug.get(slug);

    if (!item) {
      item = {
        href,
        title: "",
        cover: undefined,
      };

      bySlug.set(slug, item);
    }

    if (cover && !item.cover) {
      item.cover = cover;
    }

    if (text && text.length > item.title.length) {
      item.title = text;
    }
  }

  return [...bySlug.values()].filter(
    (x) => x.title && x.cover,
  );
}

function dedupeCards(cards) {
  const seen = new Set();
  const result = [];

  for (const card of cards) {
    const slug = slugFromMangaHref(card.href);

    if (!slug || seen.has(slug)) continue;

    seen.add(slug);
    result.push(card);
  }

  return result;
}

function cardsToResults(cards) {
  return cards
    .slice(0, PAGE_SIZE)
    .map((card) => ({
      id: card.href,
      title: cleanText(card.title),
      cover: absoluteUrl(card.cover),
    }))
    .filter((x) => x.id && x.title);
}

// ---------------------------------------------------------------------------
// CATÁLOGO
// ---------------------------------------------------------------------------

function catalogPath({ tagId, page } = {}) {
  const params = new URLSearchParams();

  if (tagId) {
    let type = "genre";
    let value = tagId;

    if (typeof tagId === "string" && tagId.includes(":")) {
      const split = tagId.split(/:(.*)/s);

      if (split[0] === "genre" || split[0] === "theme") {
        type = split[0];
        value = split[1];
      }
    }

    params.set(type, value);
  }

  if (page && page > 1) {
    params.set("page", String(page));
  }

  const query = params.toString();

  return query
    ? `/manga/?${query}`
    : "/manga/?page=1";
}

// ---------------------------------------------------------------------------
// EXTRAER META DE FICHA
// ---------------------------------------------------------------------------

function extractField(text, label) {
  if (!text) return undefined;

  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const re = new RegExp(
    `${escaped}\\s*:?\\s*(.*?)(?=\\s+(?:Títulos Alternativos|Géneros|Escribe|Estado|Tipo|Demografia|Capitulos|Vistas|Autor|Dibujo|Actualizado|Sinopsis)\\b|$)`,
    "i",
  );

  const match = text.match(re);

  return match ? cleanText(match[1]) : undefined;
}

function parseMangaDetail(html, id) {
  if (!html) return null;

  let doc = null;

  try {
    doc = harbor.parseHtml(html);
  } catch (e) {
    doc = null;
  }

  let title;
  let cover;
  let description;
  let altTitle;
  let status;
  let author;

  const genres = [];

  if (doc) {
    // -----------------------------------------------------------------------
    // TÍTULO
    // -----------------------------------------------------------------------

    const h1 = doc.querySelector("h1");

    if (h1) {
      title = cleanText(h1.text());
    }

    // -----------------------------------------------------------------------
    // PORTADA
    // -----------------------------------------------------------------------

    const ogImage = doc.querySelector(
      'meta[property="og:image"]',
    );

    if (ogImage) {
      cover =
        ogImage.attr("content") ||
        ogImage.attr("value");
    }

    if (!cover) {
      const images = doc.querySelectorAll("img");

      for (const img of images) {
        const src =
          img.attr("data-src") ||
          img.attr("data-lazy-src") ||
          img.attr("src");

        if (!src) continue;

        const alt = cleanText(
          img.attr("alt") || "",
        ).toLowerCase();

        if (
          alt.includes("portada") ||
          alt.includes("cover") ||
          !cover
        ) {
          cover = src;
        }
      }
    }

    // -----------------------------------------------------------------------
    // BLOQUE DE DESCRIPCIÓN / METADATOS
    // -----------------------------------------------------------------------

    const body = doc.querySelector("body");

    const bodyText = body
      ? cleanText(body.text())
      : "";

    // Títulos alternativos
    const altMatch = bodyText.match(
      /Títulos Alternativos:\s*(.*?)(?=\s+Géneros:|\s+Escribe:|\s+Estado:|$)/i,
    );

    if (altMatch) {
      altTitle = cleanText(altMatch[1]);
    }

    // Estado
    const statusMatch = bodyText.match(
      /Estado\s+([A-Za-zÁÉÍÓÚáéíóúÑñ]+)/i,
    );

    if (statusMatch) {
      status = cleanText(statusMatch[1]).toLowerCase();
    }

    // Autor
    const authorMatch = bodyText.match(
      /Autor\s+(.+?)(?=\s+Dibujo\s+|\s+Actualizado\s+|\s+Sinopsis\s+|$)/i,
    );

    if (authorMatch) {
      author = cleanText(authorMatch[1]);
    }

    // Géneros
    const genreMatch = bodyText.match(
      /Géneros:\s*(.*?)(?=\s+Escribe:|\s+Estado:|\s+Tipo:|$)/i,
    );

    if (genreMatch) {
      genreMatch[1]
        .split(",")
        .map((x) => cleanText(x))
        .filter(Boolean)
        .forEach((x) => genres.push(x));
    }

    // Sinopsis
    const headingNodes = doc.querySelectorAll("h2, h3");

    for (const heading of headingNodes) {
      const headingText = cleanText(
        heading.text(),
      ).toLowerCase();

      if (
        headingText === "sinopsis" ||
        headingText.includes("sinopsis")
      ) {
        // Intentar encontrar el siguiente párrafo
        const parent = heading.parent
          ? heading.parent()
          : null;

        if (parent) {
          const txt = cleanText(parent.text());

          if (txt.length > 10) {
            description = txt
              .replace(/^sinopsis\s*/i, "")
              .trim();
          }
        }
      }
    }

    // Fallback: buscar el texto después de "Sinopsis"
    if (!description) {
      const synopsisMatch = bodyText.match(
        /Sinopsis\s+(.+?)(?=\s+Lista Capítulos|\s+Capitulos|\s+Capítulos|$)/i,
      );

      if (synopsisMatch) {
        description = cleanText(
          synopsisMatch[1],
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // FALLBACK REGEX
  // -------------------------------------------------------------------------

  if (!title) {
    const match = html.match(
      /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    );

    if (match) {
      title = cleanText(
        match[1].replace(/<[^>]+>/g, ""),
      );
    }
  }

  if (!cover) {
    const match =
      html.match(
        /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i,
      ) ||
      html.match(
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i,
      );

    if (match) {
      cover = match[1];
    }
  }

  return {
    id,
    title: title || id,
    altTitle,
    cover: absoluteUrl(cover),
    description,
    status,
    author,
  };
}

// ---------------------------------------------------------------------------
// CAPÍTULOS — ESTRUCTURA NUEVA
// ---------------------------------------------------------------------------
//
// La ficha actual contiene enlaces como:
//
// /leer/5yt4bkltil/kubo-san-wa-boku-mobu-wo-yurusanai/148/
//
// Por eso ya no dependemos de .chapter-list.

async function parseChaptersFromHtml(html) {
  if (!html) return [];

  let doc;

  try {
    doc = await harbor.parseHtml(html);
  } catch (e) {
    return [];
  }

  if (!doc) return [];

  const anchors = doc.querySelectorAll(
    'a[href*="/leer/"]',
  );

  const chapters = [];
  const seen = new Set();

  for (const a of anchors) {
    const href = a.attr("href");

    if (!href) continue;

    const absolute = absoluteUrl(href);

    if (!absolute || seen.has(absolute)) {
      continue;
    }

    // Solo URLs reales de capítulos
    const match = href.match(
      /\/leer\/([^/]+)\/([^/]+)\/([^/?#]+)\/?$/i,
    );

    if (!match) continue;

    const chapterNumber = decodeURIComponent(
      match[3],
    );

    let text = cleanText(a.text());

    // El HTML actual puede mostrar simplemente:
    // "Capitulo 148"
    if (!text) {
      text = `Capitulo ${chapterNumber}`;
    }

    // Quitar fechas si aparecen en el texto
    text = text
      .replace(
        /\s+\d{4}-\d{2}-\d{2}.*$/i,
        "",
      )
      .trim();

    chapters.push({
      id: absolute,
      chapter: chapterNumber || null,
      title: text,
      pages: 0,
      language: "es",
    });

    seen.add(absolute);
  }

  // El sitio actualmente muestra primero los más recientes.
  // No invertimos el orden porque queremos respetar el orden
  // que presenta LeerCapítulo.
  return chapters;
}

// ---------------------------------------------------------------------------
// IMÁGENES DEL CAPÍTULO
// ---------------------------------------------------------------------------

async function parseImagesFromHtml(html) {
  if (!html) return [];

  let doc;

  try {
    doc = await harbor.parseHtml(html);
  } catch (e) {
    return [];
  }

  if (!doc) return [];

  const images = doc.querySelectorAll("img");

  const urls = [];
  const seen = new Set();

  for (const img of images) {
    let src =
      img.attr("src") ||
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("data-original");

    if (!src) continue;

    src = absoluteUrl(src);

    if (!src) continue;

    // Evitar iconos/logos
    const alt = cleanText(
      img.attr("alt") || "",
    ).toLowerCase();

    if (
      alt.includes("logo") ||
      alt.includes("avatar") ||
      alt.includes("icon")
    ) {
      continue;
    }

    // El CDN actual usa t34798ndc.com
    // y las imágenes del lector son externas.
    if (
      !src.includes("t34798ndc.com") &&
      !alt.includes("pagina") &&
      !alt.includes("página") &&
      !alt.includes("capitulo") &&
      !alt.includes("capítulo")
    ) {
      continue;
    }

    if (seen.has(src)) continue;

    seen.add(src);
    urls.push(src);
  }

  return urls;
}

// ---------------------------------------------------------------------------
// FALLBACK ARRAY_DATA
// ---------------------------------------------------------------------------

const K2_TO_K1 = new Map([
  ["0", "w"], ["1", "j"], ["2", "H"], ["3", "A"],
  ["4", "V"], ["5", "Q"], ["6", "P"], ["7", "3"],
  ["8", "L"], ["9", "Y"], ["A", "m"], ["B", "t"],
  ["C", "R"], ["D", "o"], ["E", "B"], ["F", "x"],
  ["G", "T"], ["H", "C"], ["I", "N"], ["J", "0"],
  ["K", "S"], ["L", "D"], ["M", "f"], ["N", "F"],
  ["O", "y"], ["P", "h"], ["Q", "7"], ["R", "c"],
  ["S", "s"], ["T", "d"], ["U", "9"], ["V", "e"],
  ["W", "J"], ["X", "z"], ["Y", "X"], ["Z", "b"],
  ["a", "a"], ["b", "I"], ["c", "q"], ["d", "G"],
  ["e", "n"], ["f", "2"], ["g", "Z"], ["h", "M"],
  ["i", "5"], ["j", "6"], ["k", "u"], ["l", "O"],
  ["m", "i"], ["n", "l"], ["o", "g"], ["p", "r"],
  ["q", "K"], ["r", "v"], ["s", "p"], ["t", "8"],
  ["u", "4"], ["v", "U"], ["w", "W"], ["x", "E"],
  ["y", "1"], ["z", "k"],
]);

function decodeArrayData(arrayData) {
  if (!arrayData) return [];

  const replaced = arrayData.replace(
    /[A-Za-z0-9]/g,
    (ch) => K2_TO_K1.get(ch) || ch,
  );

  let decoded;

  try {
    decoded = atob(replaced);
  } catch (e) {
    return [];
  }

  return decoded
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => absoluteUrl(x))
    .filter(Boolean);
}

function parseArrayDataFallback(html) {
  const match =
    html.match(
      /id=["']array_data["'][^>]*>([^<]+)</i,
    ) ||
    html.match(
      /id=["']array_data["'][^>]*value=["']([^"']+)/i,
    );

  if (!match) return [];

  return decodeArrayData(
    cleanText(match[1]),
  );
}

// ---------------------------------------------------------------------------
// PROVIDER
// ---------------------------------------------------------------------------

const plugin = {
  id: "leercapitulo",

  name: "LeerCapitulo",

  // -------------------------------------------------------------------------
  // POPULAR
  // -------------------------------------------------------------------------

  async popular(offset, tagId) {
    if (tagId) {
      return this._byGenre(tagId, offset);
    }

    if (offset === 0) {
      const html = await fetchText("/");

      if (html) {
        const cards = dedupeCards([
          ...parseHotMangaBlocks(html),
          ...parseMainpageMangaBlocks(html),
        ]);

        if (cards.length > 0) {
          return cardsToResults(cards);
        }
      }
    }

    const page = pageFromOffset(offset);

    const html = await fetchText(
      catalogPath({ page }),
    );

    if (!html) return [];

    const cards = await parseCatalogCards(html);

    return cardsToResults(cards);
  },

  // -------------------------------------------------------------------------
  // FILTROS
  // -------------------------------------------------------------------------

  async _byGenre(tagId, offset) {
    const page = pageFromOffset(offset);

    const html = await fetchText(
      catalogPath({
        tagId,
        page,
      }),
    );

    if (!html) return [];

    const cards = await parseCatalogCards(html);

    return cardsToResults(cards);
  },

  // -------------------------------------------------------------------------
  // BUSCAR
  // -------------------------------------------------------------------------

  async search(query, offset, tagId) {
    if (!query && tagId) {
      return this._byGenre(tagId, offset);
    }

    if (!query) return [];

    const json = await fetchJson(
      `/search-autocomplete?term=${encodeURIComponent(
        query,
      )}`,
    );

    if (!Array.isArray(json)) {
      return [];
    }

    const page = json.slice(
      offset,
      offset + PAGE_SIZE,
    );

    return page
      .map((serie) => {
        if (!serie) return null;

        const link =
          serie.link ||
          serie.url ||
          serie.href;

        const title =
          serie.label ||
          serie.title ||
          serie.name;

        const thumbnail =
          serie.thumbnail ||
          serie.cover ||
          serie.image;

        if (!link || !title) {
          return null;
        }

        return {
          id: absoluteUrl(link) || link,
          title: cleanText(title),
          cover: absoluteUrl(thumbnail),
        };
      })
      .filter(Boolean);
  },

  // -------------------------------------------------------------------------
  // DETALLE
  // -------------------------------------------------------------------------

  async detail(id) {
    if (!id) return null;

    const html = await fetchText(id);

    if (!html) {
      harbor.log(`DETAIL EMPTY: ${id}`);
      return null;
    }

    const manga = parseMangaDetail(
      html,
      id,
    );

    if (!manga) {
      return null;
    }

    // Intentar averiguar el último capítulo.
    const chapters =
      await parseChaptersFromHtml(html);

    if (chapters.length > 0) {
      manga.lastChapter =
        chapters[0].chapter || undefined;
    }

    return manga;
  },

  // -------------------------------------------------------------------------
  // CAPÍTULOS
  // -------------------------------------------------------------------------

  async chapters(id) {
    if (!id) return [];

    const html = await fetchText(id);

    if (!html) {
      harbor.log(`CHAPTERS EMPTY: ${id}`);
      return [];
    }

    const chapters =
      await parseChaptersFromHtml(html);

    harbor.log(
      `CHAPTERS ${id}: ${chapters.length}`,
    );

    return chapters;
  },

  // -------------------------------------------------------------------------
  // PÁGINAS
  // -------------------------------------------------------------------------

  async pageUrls(chapterId) {
    if (!chapterId) return [];

    const html = await fetchText(
      chapterId,
    );

    if (!html) {
      harbor.log(
        `PAGES EMPTY: ${chapterId}`,
      );

      return [];
    }

    // PRIMER MÉTODO:
    // HTML actual de LeerCapítulo.
    //
    // Las páginas aparecen directamente como imágenes
    // dentro del lector.

    const images =
      await parseImagesFromHtml(html);

    if (images.length > 0) {
      harbor.log(
        `PAGES IMG: ${images.length}`,
      );

      return images;
    }

    // SEGUNDO MÉTODO:
    // Compatibilidad con el lector antiguo.

    const fallback =
      parseArrayDataFallback(html);

    if (fallback.length > 0) {
      harbor.log(
        `PAGES ARRAY_DATA: ${fallback.length}`,
      );

      return fallback;
    }

    harbor.log(
      `PAGES NOT FOUND: ${chapterId}`,
    );

    return [];
  },

  // -------------------------------------------------------------------------
  // TAGS
  // -------------------------------------------------------------------------

  async tags() {
    const html = await fetchText("/");

    if (!html) return [];

    let doc;

    try {
      doc = await harbor.parseHtml(html);
    } catch (e) {
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

      const genreMatch =
        href.match(/[?&]genre=([^&]+)/i);

      const themeMatch =
        href.match(/[?&]theme=([^&]+)/i);

      let id;

      if (genreMatch) {
        id = `genre:${decodeURIComponent(
          genreMatch[1],
        )}`;
      } else if (themeMatch) {
        id = `theme:${decodeURIComponent(
          themeMatch[1],
        )}`;
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
