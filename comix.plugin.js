// MangaLect — Harbor MangaProvider plugin
// Creado a partir del HTML de la portada de mangalect.org

const BASE_URL = "https://mangalect.org";

// --- Helpers de red y utilidades -------------------------------------------

async function fetchText(urlOrPath) {
  const full = urlOrPath.startsWith("http") ? urlOrPath : `${BASE_URL}${urlOrPath}`;
  const res = await harbor.http(full, { 
    responseType: "text",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": `${BASE_URL}/`
    }
  });
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
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Extracción de tarjetas de manga (Bento grid / listados) ---------------

function parseCards(html) {
  // Captura el enlace /info/..., la imagen data-src/src y el título <h3>
  const cardRe = /<a\s+href="(\/info\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*alt="([^"]*)"[\s\S]*?<h3>([^<]+)<\/h3>/g;
  const seen = new Set();
  const results = [];

  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const href = m[1];
    const cover = m[2];
    const title = decodeEntities(m[4] || m[3]);

    if (!href || seen.has(href)) continue;
    seen.add(href);

    results.push({
      id: href,
      title: title,
      cover: absoluteUrl(cover)
    });
  }

  return results;
}

// --- Plugin Harbor --------------------------------------------------------

const plugin = {
  id: "mangalect",
  name: "MangaLect",

  async popular(offset, tagId) {
    // Si hay paginación offset > 0 se carga biblioteca
    const page = Math.floor(offset / 20) + 1;
    const path = page === 1 ? "/" : `/biblioteca/?page=${page}`;
    
    const html = await fetchText(path);
    if (!html) return [];

    return parseCards(html);
  },

  async search(query, offset, tagId) {
    if (!query) return plugin.popular(offset, tagId);

    const page = Math.floor(offset / 20) + 1;
    const url = `/biblioteca/?q=${encodeURIComponent(query)}&page=${page}`;
    
    const html = await fetchText(url);
    if (!html) return [];

    return parseCards(html);
  },

  async detail(id) {
    const html = await fetchText(id);
    if (!html) return null;

    const doc = await harbor.parseHtml(html);

    // Título
    const titleNode = doc.querySelector("h1, .manga-title, .title");
    const title = titleNode ? decodeEntities(titleNode.text()) : "MangaLect";

    // Portada
    const imgNode = doc.querySelector(".manga-cover img, .info-cover img, meta[property='og:image']");
    const cover = imgNode ? (imgNode.attr("data-src") || imgNode.attr("src") || imgNode.attr("content")) : undefined;

    // Sinopsis
    const descNode = doc.querySelector(".synopsis, .description, .manga-description, #sinopsis");
    const description = descNode ? decodeEntities(descNode.text()) : undefined;

    // Capítulos
    const chapterList = await plugin.chapters(id, html);
    const lastChapter = chapterList.length ? chapterList[0].chapter : undefined;

    return {
      id,
      title,
      cover: absoluteUrl(cover),
      description,
      lastChapter
    };
  },

  async chapters(id, cachedHtml) {
    const html = cachedHtml || await fetchText(id);
    if (!html) return [];

    // Expresión regular para enlaces de lectura (/lectura/slug/capitulo/)
    const chapRe = /<a\s+href="(\/lectura\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const found = [];
    const seen = new Set();

    let m;
    while ((m = chapRe.exec(html)) !== null) {
      const url = m[1];
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, ""));

      if (seen.has(url)) continue;
      seen.add(url);

      const numMatch = text.match(/Cap[íi]tulo\s+([\d.]+)/i) || url.match(/\/(\d+(\.\d+)?)\/?$/);

      found.push({
        id: url,
        chapter: numMatch ? numMatch[1] : null,
        title: text,
        language: "es",
        pages: 0
      });
    }

    return found;
  },

  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    if (!html) return [];

    const doc = await harbor.parseHtml(html);
    
    // Selectores habituales para el visor de imágenes
    const candidateSelectors = [
      ".reader-images img",
      ".reading-content img",
      "#chapter-images img",
      ".chapter-content img",
      ".page-break img"
    ];

    for (const sel of candidateSelectors) {
      const imgs = doc.querySelectorAll(sel);
      if (imgs.length) {
        return imgs
          .map((img) => absoluteUrl(img.attr("data-src") || img.attr("src")))
          .filter(Boolean);
      }
    }

    // Heurística fallback por regex si las imágenes se inyectan en scripts o tags genéricos
    const imgRe = /<img[^>]+(?:data-src|src)="([^"]+)"[^>]*class="[^"]*(?:page|chapter|reader)[^"]*"/gi;
    const pages = [];
    let m;

    while ((m = imgRe.exec(html)) !== null) {
      pages.push(absoluteUrl(m[1]));
    }

    return pages;
  }
};

harbor.register(plugin);
