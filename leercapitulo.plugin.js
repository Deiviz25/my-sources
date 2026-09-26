const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48;

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
      headers: { Referer: `${BASE_URL}/` },
    });

    if (!res || !res.ok) {
      harbor.log(`LeerCapitulo HTTP error: ${url}`);
      return null;
    }

    return res.body;
  } catch (e) {
    harbor.log(`LeerCapitulo fetchText error: ${e}`);
    return null;
  }
}

async function fetchJson(url) {
  try {
    // IMPORTANTE: Con responseType "json", harbor.http devuelve el JSON
    // YA parseado directamente (o null si no es JSON válido).
    // NO devuelve {ok, body, headers} como con "text".
    const json = await harbor.http(url, {
      responseType: "json",
      headers: { Referer: `${BASE_URL}/` },
    });
    
    if (json === null) {
      harbor.log(`fetchJson: respuesta no es JSON válido: ${url}`);
    }
    
    return json;
  } catch (e) {
    harbor.log(`fetchJson: excepción en ${url}: ${e}`);
    return null;
  }
}

function absoluteUrl(url) {
  if (!url) return undefined;
  try {
    return new URL(url, BASE_URL).toString();
  } catch (e) {
    return undefined;
  }
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

// ============================================================
// Caché simple
// ============================================================

const summaryCache = new Map();

// ============================================================
// Array data (descodificación de imágenes)
// ============================================================

const K2_TO_K1 = new Map([
  ["0", "w"], ["1", "j"], ["2", "H"], ["3", "A"], ["4", "V"],
  ["5", "Q"], ["6", "P"], ["7", "3"], ["8", "L"], ["9", "Y"],
  ["A", "m"], ["B", "t"], ["C", "R"], ["D", "o"], ["E", "B"],
  ["F", "x"], ["G", "T"], ["H", "C"], ["I", "N"], ["J", "0"],
  ["K", "S"], ["L", "D"], ["M", "f"], ["N", "F"], ["O", "y"],
  ["P", "h"], ["Q", "7"], ["R", "c"], ["S", "s"], ["T", "d"],
  ["U", "9"], ["V", "e"], ["W", "J"], ["X", "z"], ["Y", "X"],
  ["Z", "b"], ["a", "a"], ["b", "I"], ["c", "q"], ["d", "G"],
  ["e", "n"], ["f", "2"], ["g", "Z"], ["h", "M"], ["i", "5"],
  ["j", "6"], ["k", "u"], ["l", "O"], ["m", "i"], ["n", "l"],
  ["o", "g"], ["p", "r"], ["q", "K"], ["r", "v"], ["s", "p"],
  ["t", "8"], ["u", "4"], ["v", "U"], ["w", "W"], ["x", "E"],
  ["y", "1"], ["z", "k"],
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
// Parseo de tarjetas
// ============================================================

function parseMangaCards(html) {
  if (!html) return [];
  
  const results = [];
  const cardRe = /<a[^>]+href=["']([^"']*\/manga\/[^"']*)["'][^>]*>[\s\S]*?<img[^>]*(?:data-src|src)=["']([^"']+)["'][\s\S]*?(?:<h[34][^>]*>([^<]+)<\/h[34]>|<span[^>]*>([^<]+)<\/span>)/gi;
  
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const href = m[1];
    const cover = m[2];
    const title = cleanText(m[3] || m[4] || "");
    
    if (!href || !cover || !title) continue;
    
    results.push({
      href,
      cover,
      title,
    });
  }
  
  return results;
}

function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const out = [];
  
  for (const c of cards) {
    const slug = slugFromMangaHref(c.href);
    if (!slug || seen.has(slug)) continue;
    
    seen.add(slug);
    out.push(c);
  }
  
  return out;
}

function cardsToResults(cards) {
  return cards.map((c) => {
    const id = slugFromMangaHref(c.href);
    const result = {
      id,
      title: c.title,
      cover: absoluteUrl(c.cover),
    };
    
    summaryCache.set(id, result);
    return result;
  });
}

// ============================================================
// MangaProvider
// ============================================================

const plugin = {
  id: "leercapitulo",
  name: "LeerCapitulo",

  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);

    if (offset === 0) {
      const html = await fetchText("/");
      
      if (html) {
        const cards = dedupeCardsBySlug(parseMangaCards(html));
        
        if (cards.length > 0) {
          return cardsToResults(cards.slice(0, PAGE_SIZE));
        }
      }
    }

    // Fallback: página del catálogo
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const html = await fetchText(`/manga/?page=${page}`);
    
    if (!html) return [];
    
    const cards = dedupeCardsBySlug(parseMangaCards(html));
    return cardsToResults(cards);
  },

  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    
    let path = "/manga/?";
    if (tagId.startsWith("genre:")) {
      path += `genre=${encodeURIComponent(tagId.slice(6))}`;
    } else if (tagId.startsWith("theme:")) {
      path += `theme=${encodeURIComponent(tagId.slice(6))}`;
    }
    
    path += `&page=${page}`;
    
    const html = await fetchText(path);
    if (!html) return [];
    
    const cards = dedupeCardsBySlug(parseMangaCards(html));
    return cardsToResults(cards);
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
    if (!query) return [];

    // LeerCapitulo tiene un endpoint de búsqueda rápida (autocomplete)
    const url = `${BASE_URL}/search-autocomplete?term=${encodeURIComponent(query)}`;
    harbor.log(`search: pidiendo ${url}`);
    
    const json = await fetchJson(url);
    harbor.log(`search: respuesta JSON tipo ${typeof json}, es array: ${Array.isArray(json)}`);
    
    if (!Array.isArray(json)) {
      harbor.log(`search: respuesta no es array válido`);
      return [];
    }

    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];

    for (const item of page) {
      if (!item) continue;

      const id = slugFromMangaHref(item.link);
      if (!id) continue;

      const result = {
        id,
        title: cleanText(item.label) || id,
        cover: absoluteUrl(item.thumbnail),
      };

      summaryCache.set(id, result);
      results.push(result);
    }

    return results;
  },

  async detail(id) {
    if (!id) return null;

    const cached = summaryCache.get(id);
    
    const html = await fetchText(`/manga/${id}/`);

    if (!html) {
      if (cached) return { ...cached };
      return null;
    }

    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const title = titleMatch ? cleanText(titleMatch[1]) : id;

    const coverMatch = html.match(/<img[^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*class=["'][^"']*(?:cover|manga)[^"']*["']/i) ||
                        html.match(/<img[^>]*class=["'][^"']*(?:cover|manga)[^"']*["'][^>]*(?:src|data-src|data-lazy-src)=["']([^"']+)["']/i);
    const cover = absoluteUrl(coverMatch?.[1]);

    const descMatch = html.match(/<p[^>]*id=["']example2["'][^>]*>([\s\S]*?)<\/p>/i) ||
                      html.match(/<p[^>]*class=["'][^"']*description[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch ? cleanText(descMatch[1]) : undefined;

    const statusMatch = html.match(/Estado\s*:\s*<\/span>\s*([^<]+)/i);
    let status;
    if (statusMatch) {
      const statusRaw = cleanText(statusMatch[1]).toLowerCase();
      if (statusRaw.includes("curso")) status = "ongoing";
      else if (statusRaw.includes("complet") || statusRaw.includes("finaliz")) status = "completed";
    }

    const chapters = await plugin.chapters(id, html);
    const lastChapter = chapters.length > 0 ? chapters[chapters.length - 1].chapter : undefined;

    const result = {
      id,
      title,
      cover,
      description,
      status,
      lastChapter,
    };

    summaryCache.set(id, {
      id: result.id,
      title: result.title,
      cover: result.cover,
    });

    return result;
  },

  async chapters(id, cachedHtml) {
    let html = cachedHtml || (await fetchText(`/manga/${id}/`));
    
    if (!html) return [];

    const chapterRe = /<a[^>]+href=["']([^"']*\/leer\/[^"']*)["'][^>]*>[\s\S]*?(?:<(?:h[34]|span|strong|b)[^>]*>([^<]+)<\/(?:h[34]|span|strong|b)>|([^<]+))<\/a>/gi;
    
    const chapters = [];
    const seen = new Set();
    let m;

    while ((m = chapterRe.exec(html)) !== null) {
      const href = m[1];
      const id = absoluteUrl(href);
      
      if (!id || seen.has(id)) continue;
      
      seen.add(id);
      
      const titleText = cleanText(m[2] || m[3] || "");
      const number = href.split("/").filter(Boolean).pop();
      
      let title = titleText;
      if (!title && number) title = `Capítulo ${number}`;
      if (!title) title = number || "Sin título";

      chapters.push({
        id,
        chapter: number,
        title,
        pages: 0,
        language: "es",
      });
    }

    // Invertir para orden ascendente
    return chapters.reverse();
  },

  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    
    if (!html) return [];

    // Primero intentar extraer imágenes del DOM
    let urls = [];
    const imgRe = /<img[^>]+(?:src|data-src|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
    
    let m;
    const seen = new Set();
    
    while ((m = imgRe.exec(html)) !== null) {
      const url = absoluteUrl(m[1]);
      
      if (!url || seen.has(url)) continue;
      
      const lower = url.toLowerCase();
      if (lower.includes("logo") || lower.includes("icon") || lower.includes("avatar") || 
          lower.includes("favicon") || lower.includes("ads") || lower.includes("banner")) {
        continue;
      }
      
      seen.add(url);
      urls.push(url);
    }
    
    if (urls.length > 0) return urls;

    // Fallback: array_data cifrado
    const arrayDataMatch = html.match(/id=["']array_data["'][^>]*>([^<]+)</i);
    if (!arrayDataMatch) return [];

    const arrayData = arrayDataMatch[1].trim();
    const urlList = decodeArrayData(arrayData);

    if (!urlList.length) return [];

    const orderMetaMatch = html.match(/property=["']ad:check["'][^>]+content=["']([^"']+)["']/i);
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
          index = parseInt(value.split("").reverse().join(""), 10);
        }

        return urlList[index];
      })
      .map(absoluteUrl)
      .filter(Boolean);

    return result.reverse();
  },

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

    const links = doc.querySelectorAll('a[href*="genre="], a[href*="theme="]');
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
      tags.push({ id, name });
    }

    return tags;
  },
};

harbor.register(plugin);
