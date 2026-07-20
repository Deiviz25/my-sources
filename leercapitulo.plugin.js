/// <reference path="./manga-provider.d.ts" />

const baseUrl = "https://www.leercapitulo.co";

const plugin = {
    id: "leercapitulo",
    name: "LeerCapítulo",

    // ==================== POPULAR ====================
    async popular(offset = 0) {
        const page = Math.floor(offset / 48) + 1;
        const res = await harbor.http(`${baseUrl}/?page=${page}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll("div").forEach(el => {
            const link = el.querySelector("a[href*='/manga/']");
            const img = el.querySelector("img");
            const titleEl = el.querySelector("h3, h4, .title, a");

            if (link && titleEl && img) {
                const title = titleEl.text().trim();
                if (title.length > 2) {
                    items.push({
                        id: link.attr("href"),
                        title: title,
                        cover: img.attr("src") || img.attr("data-src") || ""
                    });
                }
            }
        });

        return items;
    },

    // ==================== SEARCH ====================
    async search(query, offset = 0) {
        const res = await harbor.http(`${baseUrl}/?s=${encodeURIComponent(query)}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll("a[href*='/manga/']").forEach(link => {
            const title = link.text().trim();
            if (title.length > 3) {
                items.push({
                    id: link.attr("href"),
                    title: title,
                    cover: ""
                });
            }
        });

        return items;
    },

    // ==================== DETAIL ====================
    async detail(id) {
        const res = await harbor.http(baseUrl + id, { responseType: "text" });
        if (!res.ok) return null;

        const doc = await harbor.parseHtml(res.body);

        return {
            id: id,
            title: doc.querySelector("h1.title-manga, h1")?.text()?.trim() || "Sin título",
            cover: doc.querySelector("img[src*='/covers/'], .cover-detail img")?.attr("src") || "",
            description: doc.querySelector("#example2, .manga-content p, .description, .manga-collapse")?.text()?.trim(),
            status: doc.querySelector("span:contains('Estado')")?.parentNode?.textContent?.includes("Ongoing") ? "Ongoing" : "Completed"
        };
    },

    // ==================== CHAPTERS ====================
    async chapters(id) {
        const res = await harbor.http(baseUrl + id, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const chapters = [];

        doc.querySelectorAll(".chapter-list a, a[href*='/leer/']").forEach(link => {
            const href = link.attr("href");
            const text = link.text().trim();

            if (href && text) {
                chapters.push({
                    id: href,
                    chapter: text.match(/\d+/)?.[0] || "",
                    title: text,
                    pages: 0,
                    language: "es"
                });
            }
        });

        return chapters.reverse();
    },

    // ==================== PAGE URLS ====================
    async pageUrls(chapterId) {
        const res = await harbor.http(baseUrl + chapterId, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const urls = [];

        doc.querySelectorAll("img").forEach(img => {
            let src = img.attr("src") || img.attr("data-src") || "";
            if (src && /\.(jpg|jpeg|png|webp)/i.test(src)) {
                if (!src.startsWith("http")) {
                    src = baseUrl + (src.startsWith("/") ? "" : "/") + src;
                }
                if (!urls.includes(src)) urls.push(src);
            }
        });

        return urls;
    }
};

harbor.register(plugin);
