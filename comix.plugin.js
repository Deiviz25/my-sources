// MangaLect — Harbor MangaProvider plugin
// Corregido con el catálogo completo (/biblioteca/) y la búsqueda rápida por API

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

// Extractor unificado de tarjetas usando el DOM
async function parseBookCards(html) {
  if (!html) return [];
  const doc = await harbor.parseHtml(html);
  const links = doc.querySelectorAll('a[href*="/info/"]');
  const seen = new Set();
  const results = [];

  for (const a of links) {
    const href = a.attr("href");
    if (!href || seen.has(href)) continue;

    // Extraer título
    let title = "";
    const hElement = a.querySelector("h3, h4, .title, .manga-title, .score-card-title");
    if (hElement) {
      title = decodeEntities(hElement.text());
    } else {
      const altImg = a.querySelector("img");
      if (altImg && altImg.attr("alt")) {
        title = decodeEntities(altImg.attr("alt").replace(/^Leer\s+/i, ""));
      }
    }

    // Extraer imagen (priorizando data-src sobre base64)
    const img = a.querySelector("img");
    let cover;
    if (img) {
      const dataSrc = img.attr("data-src");
      const src = img.attr("src");
      cover = (dataSrc && !dataSrc.startsWith("data:")) ? dataSrc : ((src && !src.startsWith("data:")) ? src : undefined);
    }

    if (href && title) {
      seen.add(href);
      results.push({
        id: href,
        title: title,
        cover: absoluteUrl(cover)
      });
    }
  }

  return results;
}

// --- Plugin Harbor --------------------------------------------------------

const plugin = {
  id: "mangalect",
  name: "MangaLect",

  async popular(offset, tagId) {
    // Paginación sobre la biblioteca completa en lugar de la home
    const page = Math.floor(offset / 24) + 1;
    const path = `/biblioteca/?page=${page}`;

    const html = await fetchText(path);
    let cards = await parseBookCards(html);

    // Fallback a portada si la biblioteca no devolvió datos en página 1
    if (cards.length === 0 && page === 1) {
      const homeHtml = await fetchText("/");
      cards = await parseBookCards(homeHtml);
    }

    return cards;
  },

  async search(query, offset, tagId) {
    if (!query) return plugin.popular(offset, tagId);

    const page = Math.floor(offset / 24) + 1;

    // 1. Probar búsqueda en /biblioteca/?q=
    let html = await fetchText(`/biblioteca/?q=${encodeURIComponent(query)}&page=${page}`);
    let results = await parseBookCards(html);

    // 2. Probar parámetro alternativo /biblioteca/?buscar=
    if (results.length === 0) {
      html = await fetchText(`/biblioteca/?buscar=${encodeURIComponent(query)}&page=${page}`);
      results = await parseBookCards(html);
    }

    // 3. Fallback: Consulta a la API de búsqueda rápida (/api/api/busqueda-rapida/)
    if (results.length === 0 && page === 1) {
      try {
        const apiRes = await harbor.http(`${BASE_URL}/api/api/busqueda-rapida/?q=${encodeURIComponent(query)}`, {
          responseType: "json",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": `${BASE_URL}/`
          }
        });

        if (apiRes.ok && apiRes.body) {
          const data = Array.isArray(apiRes.body) ? apiRes.body : (apiRes.body.results || apiRes.body.data || []);
          for (const item of data) {
            const href = item.url || item.link || (item.slug ? `/info/${item.slug}/` : null);
            const title = item.title || item.nombre || item.name;
            const cover = item.cover || item.portada || item.image || item.img;
            if (href && title) {
              results.push({
                id: href,
                title: decodeEntities(title),
                cover: absoluteUrl(cover)
              });
            }
          }
        }
      } catch (e) {
        // Silenciar errores de API si no responde JSON
      }
    }

    return results;
  },

  async detail(id) {
    const html = await fetchText(id);
    if (!html) return null;

    const doc = await harbor.parseHtml(html);

    // Título
    const titleNode = doc.querySelector("h1.manga-title, h1");
    const title = titleNode ? decodeEntities(titleNode.text()) : "MangaLect";

    // Portada
    const imgNode = doc.querySelector("img.manga-cover, .manga-cover-wrapper img, meta[property='og:image']");
    let cover;
    if (imgNode) {
      cover = imgNode.attr("src") || imgNode.attr("data-src") || imgNode.attr("content");
    }

    // Sinopsis
    const descNode = doc.querySelector("#synopsis-text, .synopsis p");
    const description = descNode ? decodeEntities(descNode.text()) : undefined;

    // Estado
    const statusNode = doc.querySelector(".status-text, .circle-state-indicator + span");
    const statusText = statusNode ? decodeEntities(statusNode.text()).toLowerCase() : "";
    let status;
    if (statusText.includes("curso") || statusText.includes("publicando")) {
      status = "ongoing";
    } else if (statusText.includes("complet") || statusText.includes("finaliz")) {
      status = "completed";
    }

    // Capítulos
    const chapterList = await plugin.chapters(id, html);
    const lastChapter = chapterList.length ? chapterList[0].chapter : undefined;

    return {
      id,
      title,
      cover: absoluteUrl(cover),
      description,
      status,
      lastChapter
    };
  },

  async chapters(id, cachedHtml) {
    const html = cachedHtml || await fetchText(id);
    if (!html) return [];

    const doc = await harbor.parseHtml(html);
    const chapLinks = doc.querySelectorAll("a.chapter-link, .chapter-card a");
    const found = [];
    const seen = new Set();

    for (const a of chapLinks) {
      const url = a.attr("href");
      if (!url || url === "#" || seen.has(url)) continue;
      seen.add(url);

      const dataChapter = a.attr("data-chapter");
      const titleNode = a.querySelector(".chapter-title");
      const dateNode = a.querySelector(".chapter-date");

      const titleText = titleNode ? decodeEntities(titleNode.text()) : decodeEntities(a.text());
      const publishAt = dateNode ? decodeEntities(dateNode.text()) : undefined;

      let chapterNum = dataChapter;
      if (!chapterNum) {
        const numMatch = titleText.match(/Cap[íi]tulo\s+([\d.]+)/i) || url.match(/\/([\d.]+)\/?$/);
        chapterNum = numMatch ? numMatch[1] : null;
      }

      found.push({
        id: url,
        chapter: chapterNum ? String(chapterNum) : null,
        title: titleText,
        language: "es",
        publishAt: publishAt
      });
    }

    return found;
  },

  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    if (!html) return [];

    const doc = await harbor.parseHtml(html);
    
    const candidateSelectors = [
      ".reader-images img",
      ".reading-content img",
      "#chapter-images img",
      ".chapter-content img",
      ".page-break img",
      ".lectura-images img"
    ];

    for (const sel of candidateSelectors) {
      const imgs = doc.querySelectorAll(sel);
      if (imgs.length) {
        const urls = imgs
          .map((img) => {
            const src = img.attr("data-src") || img.attr("src");
            return (src && !src.startsWith("data:")) ? absoluteUrl(src) : null;
          })
          .filter(Boolean);
        if (urls.length) return urls;
      }
    }

    // Fallback con Regex
    const imgRe = /<img[^>]+(?:data-src|src)="([^"]+)"[^>]*>/gi;
    const pages = [];
    let m;

    while ((m = imgRe.exec(html)) !== null) {
      const src = m[1];
      if (src && !src.startsWith("data:") && !src.includes("favicon") && !src.includes("logo") && !src.includes("brand")) {
        pages.push(absoluteUrl(src));
      }
    }

    return [...new Set(pages)];
  }
};

harbor.register(plugin);
