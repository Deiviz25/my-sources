/// <reference path="./manga-provider.d.ts" />

const BASE_URL = "https://es.novelcool.com";

const plugin = {
    id: "novelcool",
    name: "NovelCool (ES)",

    async popular(offset = 0) {
        const page = Math.floor(offset / 48) + 1;
        const res = await harbor.http(`${BASE_URL}/?page=${page}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll(".novel-item, .book-item, .list-item").forEach(el => {
            const link = el.querySelector("a");
            const img = el.querySelector("img");
            const title = el.querySelector("h3, h4, .title, .novel-name")?.text()?.trim();

            if (link && title) {
                items.push({
                    id: link.attr("href"),
                    title: title,
                    cover: absoluteUrl(img?.attr("src") || img?.attr("data-src"))
                });
            }
        });

        return items;
    },

    async search(query, offset = 0) {
        const res = await harbor.http(`${BASE_URL}/search?keywords=${encodeURIComponent(query)}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll(".novel-item, .book-item").forEach(el => {
            const link = el.querySelector("a");
            const title = el.querySelector("h3, .title, .novel-name")?.text()?.trim();

            if (link && title) {
                items.push({
                    id: link.attr("href"),
                    title: title,
                    cover: ""
                });
            }
        });

        return items;
    },

    async detail(id) {
        const res = await harbor.http(BASE_URL + id, { responseType: "text" });
        if (!res.ok) return null;

        const doc = await harbor.parseHtml(res.body);

        return {
            id,
            title: doc.querySelector("h1")?.text()?.trim() || "Sin título",
            cover: doc.querySelector(".book-img img, img.cover, .novel-cover img")?.attr("src") || "",
            description: doc.querySelector(".description, .intro, .novel-intro")?.text()?.trim(),
            status: doc.querySelector(".status")?.text()?.trim()
        };
    },

    async chapters(id) {
        const res = await harbor.http(BASE_URL + id, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const chapters = [];

        doc.querySelectorAll(".chapter-list a, a.chapter-link").forEach(link => {
            const href = link.attr("href");
            const title = link.text().trim();

            if (href) {
                chapters.push({
                    id: href,
                    chapter: title.match(/\d+/)?.[0] || "",
                    title: title,
                    pages: 0,
                    language: "es"
                });
            }
        });

        return chapters.reverse();
    },

    async pageUrls(chapterId) {
        // Novelas suelen ser texto, pero si tienen imágenes:
        const res = await harbor.http(BASE_URL + chapterId, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const urls = [];

        doc.querySelectorAll(".chapter-content img, .content img").forEach(img => {
            let src = img.attr("src") || img.attr("data-src") || "";
            if (src) {
                if (!src.startsWith("http")) src = BASE_URL + (src.startsWith("/") ? "" : "/") + src;
                urls.push(src);
            }
        });

        return urls;
    }
};

function absoluteUrl(url) {
    if (!url) return undefined;
    if (url.startsWith("http")) return url;
    return BASE_URL + (url.startsWith("/") ? "" : "/") + url;
}

harbor.register(plugin);
