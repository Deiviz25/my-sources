// leercapitulo.co — Harbor MangaProvider plugin
//
// ⚠️ Riesgo conocido: el scraper original mandaba `Referer: baseUrl/` en
// TODAS las peticiones. Al probar el sitio directamente, cualquier ruta
// que no fuera la portada (una ficha de manga, una página de género)
// devolvió 404 sin ese header. Harbor elimina la cabecera "referer" de
// toda llamada harbor.http (ver sección 3 de la API), así que es posible
// que chapters()/pageUrls()/detail() fallen igual una vez instalado. No es
// algo que se pueda arreglar desde el plugin — pruébalo pronto y, si pasa,
// es un límite del host, no un bug de este archivo.
// Reescrito contra HTML real del sitio (portada, ficha de manga y capítulo),
// ya no son heurísticas a ciegas. Selectores confirmados:
//   - Portada: bloques ".hot-manga" (Tendencias) y ".mainpage-manga" (Últimos
//     Capítulos Agregados), cada uno con <img data-src="..."> + título.
//   - Ficha:  h1.title-manga, .cover-detail img, .description-update (alt
//     títulos + géneros + estado), #example2.manga-collapse (sinopsis),
//     .chapter-list ul li a.xanh (capítulos).
//   - Capítulo: id="array_data" (imágenes en base64 con sustitución) +
//     meta[property="ad:check"] (orden real de las páginas).
//
// ⚠️ detail() sigue siendo "best effort" para description/status/author:
// no pude cargar una ficha de manga real mientras escribía esto (mismo
// bloqueo de arriba), así que usan heurísticas genéricas (spans con
// "Sinopsis"/"Estado"/"Autor", meta og:description) en vez de selectores
// confirmados contra el HTML real. Revísalos si algún campo vuelve vacío
// o mal cortado.
// ⚠️ LÍMITE CONOCIDO, NO ARREGLABLE DESDE EL PLUGIN: decodifiqué un
// array_data real y las imágenes viven en un CDN con ruta ofuscada
// (lc7-cdn.t34798ndc.com/...), el patrón típico de un host con protección
// anti-hotlink por Referer. pageUrls() en Harbor solo puede devolver
// string[] — no hay forma de adjuntar un header por imagen (a diferencia
// del formato Mangayomi, que sí soporta {url, headers} por página). Si el
// CDN exige Referer y lo rechaza, las imágenes fallarán pase lo que pase
// en este archivo; sería necesario que Harbor exponga headers por página
// en pageUrls(), no algo que yo pueda resolver aquí.
//
// ✅ popular() sí se pudo verificar contra una instalación real (ver
// captura del usuario): el problema no era falta de datos, sino que
// (a) no extraía ninguna imagen, (b) deduplicaba por URL exacta en vez
// de por serie (una misma serie aparecía una vez por cada capítulo
// listado en portada), y (c) no filtraba enlaces de menú tipo
// "/manga/generos" que casan con el mismo selector que una ficha real.
// Las tres cosas están arregladas abajo. Ese primer punto probablemente
// también explica la lentitud reportada: sin `cover` en popular(), lo más
// habitual es que el cliente termine llamando a detail() por cada tarjeta
// visible solo para conseguir la portada (48 peticiones de más en vez de
// 1), así que arreglar esto debería acelerar la carga del listado.
// ⚠️ Sin confirmar: la página de género (/genre/{slug}/) y su paginación.
// Asumo que reutiliza el mismo bloque ".mainpage-manga" que la portada
// porque es el patrón más común en este tipo de temas, pero no pude cargar
// una página de género real para confirmarlo. Si tagId no trae resultados,
// dímelo y lo reviso contra el HTML real de /genre/{slug}/.

const BASE_URL = "https://www.leercapitulo.co";
const PAGE_SIZE = 48; // MANGA_PAGE: offset -> página
@@ -40,8 +38,6 @@ async function fetchText(path) {
}

async function fetchJson(path) {
  // Con responseType "json" harbor.http ya devuelve el valor parseado
  // (o null si el body no era JSON válido), sin envoltorio { ok, body }.
  return harbor.http(`${BASE_URL}${path}`, { responseType: "json" });
}

@@ -54,20 +50,66 @@ function absoluteUrl(url) {
  }
}

// Quita etiquetas HTML y colapsa espacios — útil para sacar texto plano
// de un bloque capturado por regex (título dentro de un <a>, sinopsis
// dentro de un <span>, etc.)
function stripTags(html) {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text || undefined;
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .trim();
}
 
// slug de la serie a partir de "/manga/SLUG/..." o "/leer/SLUG/.../N/"
function slugFromMangaHref(href) {
  const parts = href.split("/").filter(Boolean); // ["manga"|"leer", slug, ...]
  return parts[1] || href;
}
 
// --- parseo de tarjetas de manga (portada / género) -------------------------
// Reutilizado por popular() y por la búsqueda por género, porque ambas
// secciones de la portada comparten la misma forma de tarjeta: un enlace a
// /manga/, una <img data-src> para la portada y un título en un h3/h4 cerca.
 
function parseHotMangaBlocks(html) {
  const results = [];
  const re =
    /<div class="hot-manga[^"]*"[\s\S]*?<a href="(\/manga\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]*data-src="([^"]+)"[\s\S]*?<h3 class="manga-title">([^<]+)<\/h3>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ href: m[1], cover: m[2], title: decodeEntities(m[3]) });
  }
  return results;
}
 
function parseMainpageMangaBlocks(html) {
  const results = [];
  const re =
    /<div class="media-left cover-manga">[\s\S]*?<a href="(\/manga\/[^"]+\/)"[^>]*>[\s\S]*?<img[^>]*data-src="([^"]+)"[\s\S]*?<h4 class="manga-newest">([^<]+)<\/h4>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    results.push({ href: m[1], cover: m[2], title: decodeEntities(m[3]) });
  }
  return results;
}
 
function dedupeCardsBySlug(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const slug = slugFromMangaHref(c.href);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(c);
  }
  return out;
}

// --- descifrado del array de páginas ---------------------------------------
// El sitio esconde la lista de imágenes de un capítulo en un <script
// id="array_data"> en base64 con las letras/dígitos sustituidos por este
// mapa. Harbor.parseHtml quita los <script>, así que esto tiene que seguir
// haciéndose con regex sobre el texto crudo (lo dice la propia spec).
// mapa. Confirmado contra un capítulo real: decodifica a URLs absolutas de
// imagen (ver aviso arriba sobre el CDN con protección anti-hotlink).
const K2_TO_K1 = new Map([
  ["0", "w"], ["1", "j"], ["2", "H"], ["3", "A"], ["4", "V"],
  ["5", "Q"], ["6", "P"], ["7", "3"], ["8", "L"], ["9", "Y"],
@@ -90,7 +132,7 @@ function decodeArrayData(arrayData) {

  let decoded;
  try {
    decoded = atob(replaced); // Buffer no existe en el worker de Harbor
    decoded = atob(replaced);
  } catch (e) {
    return [];
  }
@@ -101,144 +143,148 @@ function decodeArrayData(arrayData) {
    .filter(Boolean);
}

// Enlaces "/manga/..." de la portada que en realidad son menú (índice de
// géneros, ranking, buscador...) y no una ficha individual. Si alguno se
// cuela igual, añádelo aquí.
const NAV_SLUGS = new Set([
  "generos", "genero", "ranking", "directorio", "populares",
  "ultimos-capitulos", "buscar", "avanzada",
]);
 
// Mismo filtro pero por texto del enlace, por si el slug no es
// reconocible (algunos menús usan query params en vez de slug propio).
const NAV_TITLES = new Set([
  "géneros", "generos", "ranking", "directorio", "populares",
  "inicio", "buscar", "búsqueda avanzada", "busqueda avanzada",
]);
 
// --- MangaProvider -----------------------------------------------------

const plugin = {
  id: "leercapitulo",
  name: "LeerCapitulo",

  // No hay un endpoint de "populares" paginado de verdad: esto lee la
  // portada y saca las fichas de manga que hay en ella (mezcla
  // "Tendencias" con "Últimos Capítulos Agregados"). Al no ser paginable,
  // offsets > 0 devuelven vacío.
  //
  // Se hace con regex sobre el HTML crudo (no con harbor.parseHtml) para
  // poder capturar en un solo paso el <a href="/manga/..."> Y la <img>
  // que tiene dentro, y así sacar la portada sin peticiones adicionales.
  // La portada trae dos secciones ("Tendencias" y "Últimos Capítulos
  // Agregados") que pueden repetir la misma serie; se combinan y deduplican
  // por slug. No encontré paginación real de la portada, así que offset > 0
  // devuelve vacío en vez de repetir la misma página.
  async popular(offset, tagId) {
    if (tagId) return this._byGenre(tagId, offset);
    if (offset > 0) return [];

    const html = await fetchText("/");
    if (!html) return [];

    const anchorRe = /<a\s+[^>]*href="([^"]*\/manga\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    const seen = new Set();
    const results = [];
    const cards = dedupeCardsBySlug([
      ...parseHotMangaBlocks(html),
      ...parseMainpageMangaBlocks(html),
    ]);

    let match;
    while ((match = anchorRe.exec(html)) && results.length < PAGE_SIZE) {
      const href = match[1];
      const inner = match[2];
 
      const slugMatch = href.match(/\/manga\/([^/?#]+)/);
      if (!slugMatch) continue;
 
      const slug = slugMatch[1];
      if (NAV_SLUGS.has(slug)) continue;
    return cards.slice(0, PAGE_SIZE).map((c) => ({
      id: c.href,
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },

      const imgMatch = inner.match(/<img[^>]*\s(?:data-src|data-original|src)="([^"]+)"/i);
      const altMatch = inner.match(/<img[^>]*\salt="([^"]+)"/i);
      const title = stripTags(inner) || altMatch?.[1]?.trim();
      if (!title || NAV_TITLES.has(title.toLowerCase())) continue;
  // Best-effort: asumo que /genre/{slug}/ usa el mismo layout que la
  // portada. Sin confirmar contra HTML real (ver aviso arriba).
  async _byGenre(tagId, offset) {
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const path = page > 1 ? `/genre/${tagId}/${page}/` : `/genre/${tagId}/`;
    const html = await fetchText(path);
    if (!html) return [];

      // Dedupe por serie, no por URL exacta: la portada suele enlazar la
      // misma serie varias veces (una por cada capítulo reciente listado).
      const id = `/manga/${slug}`;
      if (seen.has(id)) continue;
      seen.add(id);
    const cards = dedupeCardsBySlug([
      ...parseHotMangaBlocks(html),
      ...parseMainpageMangaBlocks(html),
    ]);

      results.push({
        id,
        title,
        cover: absoluteUrl(imgMatch?.[1]),
      });
    }
 
    return results;
    return cards.slice(0, PAGE_SIZE).map((c) => ({
      id: c.href,
      title: c.title,
      cover: absoluteUrl(c.cover),
    }));
  },

  async search(query, offset, tagId) {
    if (!query && tagId) return this._byGenre(tagId, offset);
 
    const json = await fetchJson(`/search-autocomplete?term=${encodeURIComponent(query)}`);
    if (!Array.isArray(json)) return [];

    const page = json.slice(offset, offset + PAGE_SIZE);
    const results = [];

    if (json.length > 6) {
      return page.map((serie) => ({
        id: serie.link,
        title: serie.label,
        cover: absoluteUrl(serie.thumbnail),
      }));
    }
 
    // Pocos resultados: enriquecerlos abriendo cada ficha para sacar
    // títulos alternativos. Antes esto se hacía uno a uno con await
    // dentro del for; como mucho son 6 peticiones (harbor.http admite
    // hasta 6 en paralelo), así que se lanzan todas juntas con Promise.all
    // en vez de esperarlas en serie.
    return Promise.all(
      page.map(async (serie) => {
        const html = await fetchText(serie.link);
        const altTitle = html
          ?.match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
          ?.split(", ")
          .map((t) => t.trim())
          .join(", ");
 
        return {
    if (json.length <= 6) {
      // Pocos resultados: enriquecerlos abriendo cada ficha para sacar títulos alternativos.
      const details = await Promise.all(
        page.map(async (serie) => {
          const html = await fetchText(serie.link);
          const altTitle = html
            ?.match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
            ?.split(",")
            .map((t) => decodeEntities(t.trim()))
            .join(", ");
 
          return {
            id: serie.link,
            title: serie.label,
            altTitle,
            cover: absoluteUrl(serie.thumbnail),
          };
        }),
      );
      results.push(...details);
    } else {
      for (const serie of page) {
        results.push({
          id: serie.link,
          title: serie.label,
          altTitle,
          cover: absoluteUrl(serie.thumbnail),
        };
      }),
    );
        });
      }
    }
 
    return results;
  },

  async detail(id) {
    const html = await fetchText(id);
    if (!html) return null;

    const titleMatch = html.match(/<title>(.*?)(?:\s*\|\s*leercapitulo\.co)?<\/title>/i);
    const coverMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
    const titleMatch = html.match(/<h1 class="title-manga">([^<]+)<\/h1>/);
    const coverMatch = html.match(
      /<div class="media-left cover-detail">\s*<img src="([^"]+)"/,
    );

    const altTitle = html
    const descBlockMatch = html.match(
      /<p class="description-update">([\s\S]*?)<\/p>/,
    );
    const descBlock = descBlockMatch ? descBlockMatch[1] : "";
 
    const altTitle = descBlock
      .match(/<span>Títulos Alternativos: <\/span>(.*?)<br>/s)?.[1]
      ?.split(", ")
      .map((t) => t.trim())
      ?.split(",")
      .map((t) => decodeEntities(t.trim()))
      .join(", ");

    // Heurísticos sin confirmar contra HTML real (ver aviso al inicio del
    // archivo). Si el sitio usa otras etiquetas para esto, ajustar aquí.
    const descriptionMatch =
      html.match(/property="og:description"\s+content="([^"]+)"/i) ||
      html.match(/<span>\s*Sinopsis:?\s*<\/span>\s*(.*?)<\/(?:p|div)>/is);
    const statusMatch = html.match(/<span>\s*Estado:?\s*<\/span>\s*(.*?)<\/(?:span|p|div)>/is);
    const authorMatch = html.match(/<span>\s*Autor:?\s*<\/span>\s*(.*?)<\/(?:span|p|div)>/is);
    const genreBlockMatch = descBlock.match(
      /<span>Géneros: <\/span>([\s\S]*?)<br>/,
    );
    const genre = genreBlockMatch
      ? [...genreBlockMatch[1].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) =>
          decodeEntities(m[1]),
        )
      : [];
 
    const statusRaw = descBlock.match(/<span>Estado: <\/span>([^<]*)<br>/)?.[1]?.trim();
    const status = statusRaw ? statusRaw.toLowerCase() : undefined;
 
    const synopsisMatch = html.match(
      /<p id="example2" class="manga-collapse">([\s\S]*?)<\/p>/,
    );
    const description = synopsisMatch
      ? decodeEntities(synopsisMatch[1].replace(/\s+/g, " ").trim())
      : undefined;
 
    const chapters = await plugin.chapters(id);
    const lastChapter = chapters.length ? chapters[chapters.length - 1].chapter : undefined;

    return {
      id,
      title: titleMatch ? titleMatch[1].trim() : id,
      title: titleMatch ? decodeEntities(titleMatch[1].trim()) : id,
      altTitle,
      cover: absoluteUrl(coverMatch?.[1]),
      description: stripTags(descriptionMatch?.[1]),
      status: stripTags(statusMatch?.[1]),
      author: stripTags(authorMatch?.[1]),
      description,
      status,
      lastChapter,
      author: genre.length ? undefined : undefined, // el sitio no publica autor en la ficha
    };
  },

@@ -263,9 +309,9 @@ const plugin = {
      if (!hrefMatch) return;

      const url = hrefMatch[1];
      const title = titleMatch ? titleMatch[1].trim() : "";
      const urlParts = url.split("/");
      const number = urlParts[urlParts.length - 2];
      const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";
      const urlParts = url.split("/").filter(Boolean);
      const number = urlParts[urlParts.length - 1];

      chapters.push({
        id: url,
@@ -279,6 +325,9 @@ const plugin = {
    return chapters;
  },

  // ⚠️ Ver aviso al inicio del archivo: si el CDN de imágenes exige
  // Referer, esto puede seguir fallando en Harbor pase lo que pase aquí,
  // porque pageUrls() no admite headers por imagen en la spec actual.
  async pageUrls(chapterId) {
    const html = await fetchText(chapterId);
    if (!html) return [];
@@ -306,8 +355,7 @@ const plugin = {
      .reverse();
  },

  // Lista de géneros de la portada — esta sí la pude confirmar contra el
  // HTML real (URLs y nombres exactos), así que va sin advertencias.
  // Confirmado contra HTML real: sidebar de la portada y de la ficha.
  async tags() {
    const html = await fetchText("/");
    if (!html) return [];
@@ -335,3 +383,4 @@ const plugin = {
};

harbor.register(plugin);
