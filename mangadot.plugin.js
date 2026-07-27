const BASE_URL = "https://mangadot.net";
const PAGE_SIZE = 48;

// --- helpers de red --------------------------------------------------------

async function fetchText(urlOrPath) {
  const full = urlOrPath.startsWith("http") ? urlOrPath : `${BASE_URL}${urlOrPath}`;
  const res = await harbor.http(full, { 
    responseType: "text",
    headers: {
      Referer: `${BASE_URL}/`,
    },
  });
  if (!res.ok) return null;
  return res.body;
}

async function fetchJson(urlOrPath) {
  const full = urlOrPath.startsWith("http") ? urlOrPath : `${BASE_URL}${urlOrPath}`;
  const res = await harbor.http(full, { 
    responseType: "json",
    headers: {
      Referer: `${BASE_URL}/`,
    },
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

// --- tarjetas de manga (búsqueda) ----------------------------------------
function parseSearchCards(html) {
  const cardRe = /<a\s+class="group\s+flex\s+flex-col\s+gap-1\.5"\s+href="\/manga\/([^"]+)"[\s\S]*?<img\s+src="([^"]+)"[\s\S]*?<div\s+class="line-clamp-2[\s\S]*?">([\s\S]*?)<\/div><\/a>/gi;
  const seen = new Set();
  const results = [];

  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const id = m[1]?.trim();
    const imgUrl = m[2]?.trim();
    const title = decodeEntities(m[3]?.trim());

    if (!id || !title || seen.has(id)) continue;
    seen.add(id);

    const image = imgUrl 
      ? (imgUrl.startsWith("http") ? imgUrl : `${BASE_URL}${imgUrl}`)
      : undefined;

    results.push({ 
      id, 
      title, 
      cover: absoluteUrl(image) 
    });
  }

  return results;
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

    const html = await fetchText(`/search?search=${encodeURIComponent(query)}&page=1`);
    if (!html) return [];

    return parseSearchCards(html).slice(offset, offset + PAGE_SIZE);
  },

  async detail(id) {
    const chapters = await plugin.chapters(id);
    const lastChapter = chapters.length
      ? chapters[chapters.length - 1].chapter
      : undefined;

    const detailData = await fetchJson(`/api/manga/${encodeURIComponent(id)}`);
    
    if (!detailData) {
      return {
        id,
        title: id,
        cover: undefined,
        description: undefined,
        author: undefined,
        status: undefined,
        lastChapter,
      };
    }

    return {
      id,
      title: detailData.title || id,
      cover: absoluteUrl(detailData.cover),
      description: detailData.description || undefined,
      author: detailData.author || undefined,
      status: detailData.status ? String(detailData.status).toLowerCase() : undefined,
      lastChapter,
    };
  },

  async chapters(id) {
    const json = await fetchJson(`/api/manga/${encodeURIComponent(id)}/chapters/list?lang=en`);
    if (!json) return [];

    const items = Array.isArray(json) ? json : [];
    const found = [];

    for (const ch of items) {
      const url = ch?.id != null ? String(ch.id) : "";
      if (!url) continue;

      const chapNum = ch?.chapter_number != null ? String(ch.chapter_number) : "0";
      const chapTitle = ch?.chapter_title ? String(ch.chapter_title) : null;
      const scanlator = 
        (ch?.scanlator_name && String(ch.scanlator_name).trim()) ||
        (ch?.group_name && String(ch.group_name).trim()) ||
        "Default";

      found.push({
        id: url,
        chapter: chapNum,
        title: chapTitle ? `Chapter ${chapNum} — ${chapTitle}` : `Chapter ${chapNum}`,
        pages: 0,
        language: ch?.language ?? "en",
        publishAt: ch?.published_at || undefined,
        scanlator,
      });
    }

    return found.reverse();
  },

  async pageUrls(chapterId) {
    const json = await fetchJson(`/api/chapters/${encodeURIComponent(chapterId)}/images`);
    if (!json) return [];

    const images = Array.isArray(json?.images) ? json.images : [];
    const urls = [];

    for (const img of images) {
      const imgUrl = img?.url;
      if (!imgUrl) continue;

      const absolute = imgUrl.startsWith("http") ? imgUrl : `${BASE_URL}${imgUrl}`;
      urls.push(absoluteUrl(absolute));
    }

    return urls.filter(Boolean);
  },

  async tags() {
    return [];
  },
};

harbor.register(plugin);
