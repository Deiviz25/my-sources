// es.novelcool.com — Harbor MangaProvider plugin
//
// Escrito contra HTML real del sitio que me pasaste (portada, categoría
// "Popular" y ficha de un manga/manhwa), con el mismo criterio que el
// plugin de leercapitulo: nada de heurísticas a ciegas donde hay HTML real
// que revisar, y avisos explícitos donde no lo hay.
//
// ✅ Confirmado contra HTML real:
//   - Tarjetas de manga (portada Y categoría "Popular"): ambas usan
//     <div class="book-pic" title="NOMBRE"><a href="URL"><img ...></a></div>.
//     La única diferencia es que la portada trae la portada directo en
//     `src`, mientras que las páginas de categoría la cargan perezosamente
//     en `lazy_url` (con `src` apuntando a un placeholder). El código
//     prueba `lazy_url` primero y cae a `src` si no existe.
//   - Ficha de manga: h1.bookinfo-title, img.bookinfo-pic-img,
//     .bk-summary-txt (sinopsis), bloque "Estado" con el estado real,
//     lista completa de capítulos en .chp-item (SÍ viene completa en el
//     HTML inicial — el botón "Más capítulos" solo hace un toggle CSS de
//     visibilidad, no una carga adicional).
//
// ⚠️ SIN CONFIRMAR (no tenía HTML real de estas páginas al escribir esto):
//   1. Página de resultados de búsqueda (/search?name=...): asumo que
//      reutiliza la misma tarjeta .book-pic que portada/categoría porque
//      es el patrón más probable en este framework, pero no lo pude
//      verificar. El formulario de búsqueda de escritorio usa el parámetro
//      "name"; hay una versión móvil que usa "wd" en su lugar — si buscar
//      no devuelve nada, puede que el parámetro real sea otro.
//   2. tags(): asumo que /category.html lista los géneros como enlaces
//      "/category/<Nombre>.html". Sin confirmar.
//   3. pageUrls() — la más importante y la más insegura: NO tengo HTML de
//      ninguna página de lectura de capítulo (algo como
//      https://es.novelcool.com/chapter/.../....html), así que no sé cómo
//      estructura las imágenes ahí. Below hay una heurística que prueba
//      varios selectores típicos, pero es una apuesta, no algo verificado.
//      Si la lectura no funciona, mándame el HTML de un capítulo real (el
//      mismo tipo de "ver código fuente" que ya me pasaste para las otras
//      páginas) y lo arreglo con datos reales en vez de adivinar otra vez.
//   4. Paginación: no vi ningún parámetro de página real en las muestras
//      (el "book-list-pager" venía vacío), así que popular() y la
//      búsqueda por género solo devuelven la primera página (offset 0).
 
const BASE_URL = "https://es.novelcool.com";
const PAGE_SIZE = 48; // MANGA_PAGE: offset -> página
 
// --- helpers de red --------------------------------------------------------
 
async function fetchText(urlOrPath) {
  const full = urlOrPath.startsWith("http") ? urlOrPath : `${BASE_URL}${urlOrPath}`;
  const res = await harbor.http(full, { responseType: "text" });
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
 
// --- tarjetas de manga (compartido por popular/búsqueda/género) ------------
// Confirmado contra portada Y contra /category/popular.html: ambas usan
// exactamente <div class="book-pic" title="NOMBRE"><a href="URL"><img...>.
// El título del atributo `title` viene limpio, así que no hace falta ir a
// buscar el <div class="book-name"> por separado.
function parseBookCards(html) {
  const cardRe = /<div class="book-pic" title="([^"]*)">\s*<a href="([^"]+)"[^>]*>\s*(<img[^>]*>)/g;
  const seen = new Set();
  const results = [];
 
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const title = decodeEntities(m[1]);
    const href = m[2];
    const imgTag = m[3];
    if (!title || !href || seen.has(href)) continue;
    seen.add(href);
 
    const lazyMatch = imgTag.match(/lazy_url="([^"]+)"/);
    const srcMatch = imgTag.match(/\ssrc="([^"]+)"/);
    const cover = lazyMatch?.[1] || srcMatch?.[1];
 
    results.push({ id: href, title, cover: absoluteUrl(cover) });
  }
 
  return results;
}
 
// --- MangaProvider -----------------------------------------------------
 
const plugin = {
  id: "novelcool",
  name: "NovelCool",
 
  // Usa /category/popular.html (confirmado) en vez de la portada, porque
  // es la lista que el propio sitio etiqueta como "Popular" — la portada
  // mezcla varias secciones (Último, Terminado, géneros...) que no son lo
  // mismo. Sin paginación real detectada, offset > 0 devuelve vacío.
  async popular(offset, tagId) {
    if (tagId) return plugin._byGenre(tagId, offset);
    if (offset > 0) return [];
 
    const html = await fetchText("/category/popular.html");
    if (!html) return [];
 
    return parseBookCards(html).slice(0, PAGE_SIZE);
  },
 
  // ⚠️ Sin confirmar (ver aviso al inicio del archivo): asumo que
  // /category/<Nombre>.html reutiliza la misma tarjeta .book-pic.
  async _byGenre(tagId, offset) {
    if (offset > 0) return [];
    const html = await fetchText(`/category/${tagId}.html`);
    if (!html) return [];
    return parseBookCards(html).slice(0, PAGE_SIZE);
  },
 
  // ⚠️ Sin confirmar (ver aviso al inicio del archivo): no tenía HTML real
  // de una página de resultados de búsqueda. Prueba con el parámetro
  // "name"; si nunca devuelve nada, puede que el parámetro correcto sea
  // otro (el formulario móvil del sitio usa "wd").
  async search(query, offset, tagId) {
    if (!query && tagId) return plugin._byGenre(tagId, offset);
 
    const html = await fetchText(`/search?name=${encodeURIComponent(query)}`);
    if (!html) return [];
 
    return parseBookCards(html).slice(offset, offset + PAGE_SIZE);
  },
 
  async detail(id) {
    const html = await fetchText(id);
    if (!html) return null;
 
    const titleMatch = html.match(/<h1 class="bookinfo-title"[^>]*>([^<]+)<\/h1>/);
    const coverMatch = html.match(/<img class="bookinfo-pic-img" src="([^"]+)"/);
    const synopsisMatch = html.match(
      /<div class="bk-summary-txt"[^>]*>([\s\S]*?)<\/div>/,
    );
    const authorMatch = html.match(/<span itemprop="creator">([^<]*)<\/span>/);
    const statusMatch = html.match(
      /<div class="bk-cate-item bk-cate-type1[^"]*">[\s\S]*?<a[^>]*>([^<]+)<\/a>/,
    );
 
    const chapters = await plugin.chapters(id);
    const lastChapter = chapters.length
      ? chapters[chapters.length - 1].chapter
      : undefined;
 
    return {
      id,
      title: titleMatch ? decodeEntities(titleMatch[1]) : id,
      cover: absoluteUrl(coverMatch?.[1]),
      description: synopsisMatch ? decodeEntities(synopsisMatch[1]) : undefined,
      author: authorMatch ? decodeEntities(authorMatch[1]) || undefined : undefined,
      status: statusMatch ? decodeEntities(statusMatch[1]).toLowerCase() : undefined,
      lastChapter,
    };
  },
 
  // Confirmado: la lista completa de capítulos ya viene en el HTML de la
  // ficha (el botón "Más capítulos" es un toggle CSS, no una carga AJAX),
  // así que no hace falta ninguna petición aparte de esta.
  async chapters(id) {
    const html = await fetchText(id);
    if (!html) return [];
 
    const chapRe =
      /<div class="chp-item">\s*<a href="([^"]+)" title="([^"]*)">[\s\S]*?<span class="chapter-item-time">([^<]*)<\/span>/g;
 
    const found = [];
    let m;
    while ((m = chapRe.exec(html)) !== null) {
      const url = m[1];
      const title = decodeEntities(m[2]);
      const publishAt = decodeEntities(m[3]);
      const numberMatch = title.match(/Cap[ií]tulo\s+([\d.]+)/i);
 
      found.push({
        id: url,
        chapter: numberMatch ? numberMatch[1] : null,
        title,
        pages: 0,
        language: "es",
        publishAt: publishAt || undefined,
      });
    }
 
    // El sitio lista de más nuevo a más viejo; se invierte para que el
    // array quede de más viejo a más nuevo (mismo orden que leercapitulo).
    return found.reverse();
  },
 
  // ⚠️ NO VERIFICADO — ver aviso #3 al inicio del archivo. No tenía HTML
  // de una página de lectura real, así que esto prueba varios selectores
  // típicos de este tipo de sitios y usa el primero que encuentre algo.
  // Es una apuesta razonable, no un selector confirmado.
  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    if (!html) return [];
 
    const doc = await harbor.parseHtml(html);
    const candidateSelectors = [
      ".chapter-images img",
      ".chapter-content img",
      ".reading-content img",
      "#chapter-content img",
      ".chapter-c img",
    ];
 
    for (const sel of candidateSelectors) {
      const imgs = doc.querySelectorAll(sel);
      if (imgs.length) {
        return imgs
          .map((img) => absoluteUrl(img.attr("data-src") || img.attr("src")))
          .filter(Boolean);
      }
    }
 
    return [];
  },
 
  // ⚠️ Sin confirmar (ver aviso al inicio del archivo).
  async tags() {
    const html = await fetchText("/category.html");
    if (!html) return [];
 
    const NON_GENRE_SLUGS = new Set([
      "latest", "popular", "new_list", "completed", "original", "updated",
    ]);
 
    const doc = await harbor.parseHtml(html);
    const links = doc.querySelectorAll('a[href*="/category/"]');
 
    const seen = new Set();
    const tags = [];
 
    for (const a of links) {
      const href = a.attr("href");
      const name = a.text();
      if (!href || !name || seen.has(href)) continue;
 
      const slug = href.split("/category/")[1]?.replace(/\.html.*$/, "");
      if (!slug || NON_GENRE_SLUGS.has(slug)) continue;
 
      seen.add(href);
      tags.push({ id: slug, name: decodeEntities(name) });
    }
 
    return tags;
  },
};
 
harbor.register(plugin);
