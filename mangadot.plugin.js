const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 48;

// --- helpers de red --------------------------------------------------------

async function fetchText(path) {
  const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "text" });
  if (!res.ok) return null;
  return res.body;
}

async function fetchJson(path) {
  const res = await harbor.http(`${BASE_URL}${path}`, { responseType: "json" });
  if (!res.ok) return null;
  return res.body;
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
    .replace(/&#x27;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/<!--\s*-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- helpers de parsing (independientes del orden de atributos) -----------

// Extrae el valor de un atributo dentro del texto de un tag, sin importar
// dónde aparezca dentro del tag.
function getAttr(tagStr, attrName) {
  const re = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = tagStr.match(re);
  return m ? m[1] : undefined;
}

// Devuelve todos los tags <tagName ...> (auto-cerrados o no) como strings.
function getTags(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  return html.match(re) || [];
}

// Extrae el contenido de un <div class="...target...">...</div> respetando
// divs anidados (en vez de pararse en el primer </div> que encuentre).
function extractBalancedDiv(html, classNeedle) {
  const openRe = new RegExp(`<div\\b[^>]*class=["'][^"']*${classNeedle}[^"']*["'][^>]*>`, "i");
  const openMatch = html.match(openRe);
  if (!openMatch) return undefined;

  const startIdx = openMatch.index + openMatch[0].length;
  const tagRe = /<div\b[^>]*>|<\/div>/gi;
  tagRe.lastIndex = startIdx;

  let depth = 1;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].toLowerCase() === "</div>") {
      depth--;
      if (depth === 0) {
        return html.slice(startIdx, m.index);
      }
    } else {
      depth++;
    }
  }
  // Div sin cerrar correctamente: devolver lo que haya hasta el final.
  return html.slice(startIdx);
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

// --- MangaProvider -------------------------------------------------------

const plugin = {
  id: "mangadot",
  name: "MangaDot",

  async popular(offset, tagId) {
    if (offset > 0) return [];
    return [];
  },

  async _byGenre(tagId, offset) {
    if (offset > 0) return [];
    return [];
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);

    try {
      const html = await fetchText(`/?s=${encodeURIComponent(query)}`);
      if (!html) return [];

      const results = [];
      const seen = new Set();

      // Cada card es un <a class="...block...">, buscamos todos los <a>
      // y filtramos por clase (sin asumir orden de atributos).
      const anchorBlocks = html.split(/(?=<a\b)/i);

      for (const block of anchorBlocks) {
        const aTagMatch = block.match(/^<a\b[^>]*>/i);
        if (!aTagMatch) continue;
        const aTag = aTagMatch[0];

        const cls = getAttr(aTag, "class") || "";
        if (!/\bblock\b/i.test(cls)) continue;

        const href = getAttr(aTag, "href");
        if (!href || seen.has(href)) continue;

        // Sólo miramos hasta el cierre de este bloque (siguiente <a o fin)
        const closeIdx = block.search(/<\/a>/i);
        const inner = closeIdx >= 0 ? block.slice(0, closeIdx) : block;

        const imgTag = (inner.match(/<img\b[^>]*>/i) || [])[0];
        const img = imgTag ? getAttr(imgTag, "src") : undefined;

        const titleMatch = inner.match(/<h[34]\b[^>]*class=["'][^"']*post-title[^"']*["'][^>]*>([^<]+)<\/h[34]>/i);
        const title = titleMatch ? decodeEntities(titleMatch[1]) : undefined;

        if (!title) continue;
        seen.add(href);

        results.push({
          id: href,
          title,
          cover: absoluteUrl(img),
        });
      }

      return results.slice(offset, offset + PAGE_SIZE);
    } catch (e) {
      return [];
    }
  },

  async detail(id) {
    try {
      const html = await fetchText(id);
      if (!html) return null;

      // Título
      const titleMatch = html.match(/<h1\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([^<]+)<\/h1>/i);
      const title = titleMatch ? decodeEntities(titleMatch[1]) : String(id);

      // Portada (busca todos los <img> y toma el que tenga la clase correcta,
      // sin importar si "class" va antes o después de "src")
      let cover;
      for (const imgTag of getTags(html, "img")) {
        const cls = getAttr(imgTag, "class") || "";
        if (/\bpost-image\b/i.test(cls)) {
          cover = absoluteUrl(getAttr(imgTag, "src"));
          break;
        }
      }

      // Sinopsis/Descripción (respeta divs anidados)
      const descHtml = extractBalancedDiv(html, "entry-content");
      const description = descHtml ? stripTags(descHtml) : undefined;

      // Capítulos
      const chapters = await plugin.chapters(id);
      const lastChapter = chapters.length ? chapters[chapters.length - 1].chapter : undefined;

      return {
        id,
        title,
        cover,
        description,
        author: undefined,
        status: undefined,
        lastChapter,
      };
    } catch (e) {
      return null;
    }
  },

  async chapters(id) {
    try {
      const html = await fetchText(id);
      if (!html) return [];

      const chapters = [];
      const seen = new Set();

      // Ya no exigimos la palabra "Chapter" en el texto: aceptamos cualquier
      // enlace cuyo texto contenga un número (con o sin la palabra "Chapter"/"Ch."),
      // que suele ser el patrón real en plantillas WP de manga.
      const chapterRe = /<a\b[^>]*href="([^"]+)"[^>]*>\s*(?:Chapter|Ch\.?)?\s*(\d+(?:\.\d+)?)[^<]*<\/a>/gi;

      let m;
      while ((m = chapterRe.exec(html)) !== null) {
        const href = m[1];
        const chapterNum = m[2];

        if (!href || seen.has(href)) continue;
        seen.add(href);

        chapters.push({
          id: href,
          chapter: chapterNum,
          title: decodeEntities(m[0].replace(/<[^>]+>/g, "")),
          pages: 0,
          language: "en",
        });
      }

      return chapters.reverse();
    } catch (e) {
      return [];
    }
  },

  async pageUrls(chapterId) {
    try {
      const html = await fetchText(chapterId);
      if (!html) return [];

      const urls = [];
      const seen = new Set();

      // Recorremos todos los <img> y filtramos por clase, sin depender
      // del orden en que aparezcan los atributos.
      for (const imgTag of getTags(html, "img")) {
        const cls = getAttr(imgTag, "class") || "";
        if (!/\b(post-image|wp-post-image)\b/i.test(cls)) continue;

        const src = getAttr(imgTag, "src");
        if (!src || seen.has(src)) continue;
        seen.add(src);

        const absoluteImg = absoluteUrl(src);
        if (absoluteImg) urls.push(absoluteImg);
      }

      return urls;
    } catch (e) {
      return [];
    }
  },

  async tags() {
    return [];
  },
};

harbor.register(plugin);
