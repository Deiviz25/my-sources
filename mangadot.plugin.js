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

      // Regex para extraer cards de manga
      const cardRe = /<a[^>]*class="[^"]*block[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[\s\S]*?<h[34][^>]*class="[^"]*post-title[^"]*"[^>]*>([^<]+)<\/h[34]>/gi;

      let m;
      while ((m = cardRe.exec(html)) !== null) {
        const href = m[1];
        const img = m[2];
        const title = decodeEntities(m[3]);

        if (!href || !title || seen.has(href)) continue;
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
      const titleMatch = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([^<]+)<\/h1>/i);
      const title = titleMatch ? decodeEntities(titleMatch[1]) : String(id);

      // Portada
      const coverMatch = html.match(/<img[^>]*class="[^"]*post-image[^"]*"[^>]*src="([^"]+)"/i) ||
                         html.match(/<img[^>]*src="([^"]+)"[^>]*class="[^"]*post-image[^"]*"/i);
      const cover = coverMatch ? absoluteUrl(coverMatch[1]) : undefined;

      // Sinopsis/Descripción
      const descMatch = html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const description = descMatch ? decodeEntities(descMatch[1].replace(/<[^>]+>/g, " ").trim()) : undefined;

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

      // Regex para extraer enlaces de capítulos
      const chapterRe = /<a[^>]*href="([^"]+)"[^>]*>([^<]*Chapter[^<]*\d+[^<]*)<\/a>/gi;

      let m;
      while ((m = chapterRe.exec(html)) !== null) {
        const href = m[1];
        const text = decodeEntities(m[2]);

        if (!href || seen.has(href)) continue;
        seen.add(href);

        // Extraer número de capítulo del texto
        const numMatch = text.match(/(\d+(?:\.\d+)?)/);
        const chapterNum = numMatch ? numMatch[1] : "0";

        chapters.push({
          id: href,
          chapter: chapterNum,
          title: text,
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

      // Regex para extraer imágenes dentro de divs de contenido
      const imgRe = /<img[^>]*src="([^"]+)"[^>]*class="[^"]*(?:post-image|wp-post-image)[^"]*"[^>]*>/gi;

      let m;
      while ((m = imgRe.exec(html)) !== null) {
        const imgUrl = m[1];
        if (!imgUrl || seen.has(imgUrl)) continue;
        seen.add(imgUrl);

        const absoluteImg = absoluteUrl(imgUrl);
        if (absoluteImg) {
          urls.push(absoluteImg);
        }
      }

      return urls.filter(Boolean);
    } catch (e) {
      return [];
    }
  },

  async tags() {
    return [];
  },
};

harbor.register(plugin);
