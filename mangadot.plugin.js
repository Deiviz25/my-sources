/**
 * Harbor MangaProvider Plugin para Mangadotnet
 * Sitio: Mangadotnet (https://mangadot.net)
 * 
 * ============================================================================
 * SELECTORES Y ESTADO DE VERIFICACIÓN
 * ============================================================================
 * 
 * [CONFIRMADO] Tarjetas de Manga (Portada / Listados):
 *   - ID y URL: <a href="\/manga\/([^"]+)"
 *   - Imagen de portada: <img [^>]*src="([^"]+)"
 *   - Título: <div class="line-clamp-2[^>]*">(.*?)<\/div>
 * 
 * [CONFIRMADO] Ficha de Serie (/manga/{id}):
 *   - Título principal: <h1 class="...">(.*?)<\/h1>
 *   - Portada real (no el poster OG): dentro de contenedor aspect-[2/3] -> src="(\/uploads\/[^"]+)"
 *   - Descripción: contenedor <div class="text-sm text-white\/60..."> o <meta name="description" ...>
 *   - Estado (Ongoing / Completed): <span class="...">(Ongoing|Completed)<\/span>
 *   - Autor / Artista: href="\/search\?author=([^"]+)"
 *   - Total de capítulos / Último capítulo: "Chapters" -> <span class="...">(\d+)<\/span>
 *   - Ruta base de capítulos: URLs con formato /chapter/{chapterId}
 * 
 * [ASUMIDO] Lista completa de Capítulos (/manga/{id}):
 *   - El extracto HTML proporcionado de la ficha se cortó en la barra lateral antes de llegar al bloque de la lista de capítulos.
 *   - Se utiliza el regex general de enlaces /chapter/{id} (confirmado por el botón "Start Reading" que apunta a /chapter/284787).
 *   * Requiere confirmar la estructura exacta del listado completo de capítulos (ej. si están en un tab de Remix o renderizados directamente).
 * 
 * [ASUMIDO] Lector de Páginas (/chapter/{chapterId}):
 *   - Extracción de imágenes dentro del contenedor del visor o de la lista de páginas.
 *   * Requiere confirmación con el HTML real de una página de lectura.
 * 
 * [ASUMIDO] Búsqueda y Géneros:
 *   - Endpoints /search?q={query} o /search?search={genre} (detectados enlaces como /search?search=Comedy).
 * 
 * ============================================================================
 * LIMITACIONES CONOCIDAS
 * ============================================================================
 * ⚠️ [Corte de HTML]: El HTML de la ficha proporcionado finaliza en el sidebar, por lo que la lista completa de capítulos se deduce del patrón de enlace del botón "Start Reading" (/chapter/284787).
 * ⚠️ [Protección Anti-Hotlink CDN]: Las imágenes de portadas y páginas (/uploads/...) pueden requerir el header Referer: https://mangadot.net/.
 * ⚠️ [Paginación Portada]: La portada no expone una paginación standard por URL; si offset > 0, devuelve [] para evitar datos duplicados.
 */

const SITE_URL = 'https://mangadot.net';
const SITE_NAME = 'Mangadotnet';

// ============================================================================
// 1. HELPERS DE RED Y UTILIDADES
// ============================================================================

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': SITE_URL
      }
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  }
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': SITE_URL
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

function absoluteUrl(path) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  if (path.startsWith('//')) return 'https:' + path;
  if (path.startsWith('/')) return SITE_URL + path;
  return SITE_URL + '/' + path;
}

function decodeEntities(encodedString) {
  if (!encodedString) return '';
  const translate_re = /&(nbsp|amp|quot|lt|gt|#39|#x27);/g;
  const translate = {
    "nbsp": " ",
    "amp": "&",
    "quot": "\"",
    "lt": "<",
    "gt": ">",
    "#39": "'",
    "#x27": "'"
  };
  return encodedString.replace(translate_re, (match, entity) => translate[entity] || match);
}

// ============================================================================
// 2. PARSEO DE TARJETAS DE MANGA
// ============================================================================

function parseMangaCards(html) {
  if (!html) return [];
  const results = [];
  const seenIds = new Set();

  const cardRegex = /<a[^>]+href="\/manga\/([^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[\s\S]*?<div class="line-clamp-2[^>]*">\s*([\s\S]*?)\s*<\/div>/g;

  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const id = match[1].trim();
    if (seenIds.has(id)) continue;

    const cover = absoluteUrl(match[2].trim());
    const title = decodeEntities(match[3].replace(/<!--.*?-->/g, '').trim());

    if (id && title) {
      seenIds.add(id);
      results.push({ id, title, cover });
    }
  }

  return results;
}

// ============================================================================
// 3. DESOFUSCACIÓN / LÓGICA ESPECÍFICA
// ============================================================================

// No se detecta ofuscación en las páginas examinadas.

// ============================================================================
// 4. OBJETO PLUGIN (INTERFAZ HARBOR MANGAPROVIDER)
// ============================================================================

const plugin = {
  id: 'mangadotnet',
  name: SITE_NAME,

  async popular(offset = 0, tagId = null) {
    if (tagId) {
      return this.search('', offset, tagId);
    }

    if (offset > 0) return [];

    const html = await fetchText(SITE_URL);
    return parseMangaCards(html);
  },

  async search(query = '', offset = 0, tagId = null) {
    if (offset > 0) return [];

    let url = `${SITE_URL}/search`;
    if (query) {
      url += `?q=${encodeURIComponent(query)}`;
    } else if (tagId) {
      url += `?search=${encodeURIComponent(tagId)}`;
    }

    const html = await fetchText(url);
    if (!html) return [];

    const results = parseMangaCards(html);

    if (results.length > 0 && results.length <= 3) {
      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        const detailData = await this.detail(item.id);
        if (detailData && detailData.altTitle) {
          item.altTitle = detailData.altTitle;
        }
      }
    }

    return results;
  },

  async detail(id) {
    const url = `${SITE_URL}/manga/${id}`;
    const html = await fetchText(url);
    if (!html) return null;

    // Título principal [CONFIRMADO]
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<!--.*?-->/g, '').trim()) : undefined;

    // Imagen de portada real [CONFIRMADO] (evita el og:image genérico de la vista OG)
    const coverMatch = html.match(/aspect-\[2\/3\][\s\S]*?<img[^>]+src="([^"]+)"/i) ||
                       html.match(/<img[^>]+src="(\/uploads\/[^"]+)"/i);
    const cover = coverMatch ? absoluteUrl(coverMatch[1]) : undefined;

    // Descripción [CONFIRMADO]
    const descDivMatch = html.match(/<div class="text-sm text-white\/60[^>]*">[\s\S]*?<div>([\s\S]*?)<\/div>/i);
    const metaDescMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    let description = descDivMatch ? descDivMatch[1] : (metaDescMatch ? metaDescMatch[1] : undefined);
    if (description) {
      description = decodeEntities(description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim());
    }

    // Estado [CONFIRMADO]
    const statusMatch = html.match(/<span[^>]*>(Ongoing|Completed|Hiatus|Cancelled)<\/span>/i);
    const status = statusMatch ? statusMatch[1].trim() : undefined;

    // Autor [CONFIRMADO]
    const authorMatch = html.match(/href="\/search\?author=[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    const author = authorMatch ? decodeEntities(authorMatch[1].trim()) : undefined;

    // Conteo / Último capítulo [CONFIRMADO]
    const lastChapterMatch = html.match(/Chapters<\/span>\s*<span[^>]*>([\d.]+)<\/span>/i);
    const lastChapter = lastChapterMatch ? parseFloat(lastChapterMatch[1]) : undefined;

    return {
      id,
      title: title || id,
      altTitle: undefined,
      cover,
      description,
      status,
      lastChapter,
      author
    };
  },

  async chapters(id) {
    const url = `${SITE_URL}/manga/${id}`;
    const html = await fetchText(url);
    if (!html) return [];

    const chapters = [];
    const seenIds = new Set();

    // Captura enlaces a capítulos (/chapter/ID)
    const chapterRegex = /<a[^>]+href="\/chapter\/([^"?#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

    let match;
    while ((match = chapterRegex.exec(html)) !== null) {
      const chapId = match[1].trim();
      if (seenIds.has(chapId)) continue;
      seenIds.add(chapId);

      const rawText = decodeEntities(match[2].replace(/<[^>]+>/g, '').trim());
      const numMatch = rawText.match(/Ch(?:apter)?\s*([\d.]+)/i) || chapId.match(/([\d.]+)/);
      const chapterNum = numMatch ? parseFloat(numMatch[1]) : 0;

      chapters.push({
        id: chapId,
        chapter: chapterNum,
        title: rawText || `Chapter ${chapterNum}`,
        pages: 0,
        language: 'en'
      });
    }

    return chapters.reverse();
  },

  async pageUrls(chapterId) {
    const url = `${SITE_URL}/chapter/${chapterId}`;
    const html = await fetchText(url);
    if (!html) return [];

    const pages = [];
    
    // Extracción de imágenes directas del lector
    const imgRegex = /<img[^>]+src="([^"]+)"[^>]*class="[^"]*reader-page[^"]*"/g;
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      pages.push(absoluteUrl(match[1]));
    }

    // Fallback: imágenes en rutas de uploads
    if (pages.length === 0) {
      const fallbackRegex = /<img[^>]+src="(\/uploads\/pages\/[^"]+|\/uploads\/chapters\/[^"]+|\/uploads\/manga\/[^"]+)"/g;
      while ((match = fallbackRegex.exec(html)) !== null) {
        pages.push(absoluteUrl(match[1]));
      }
    }

    return pages;
  },

  async tags() {
    const html = await fetchText(SITE_URL);
    if (!html) return [];

    const tagsList = [];
    const tagRegex = /<a[^>]+href="\/search\?search=([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    
    let match;
    const seen = new Set();
    while ((match = tagRegex.exec(html)) !== null) {
      const tagId = match[1].trim();
      const name = decodeEntities(match[2].replace(/<[^>]+>/g, '').trim());

      if (tagId && name && !seen.has(tagId)) {
        seen.add(tagId);
        tagsList.push({ id: tagId, name });
      }
    }

    return tagsList;
  }
};

if (typeof harbor !== 'undefined') {
  harbor.register(plugin);
}
