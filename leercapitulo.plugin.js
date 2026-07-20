/// <reference path="./manga-provider.d.ts" />

const baseUrl = "https://www.leercapitulo.co";

const plugin = {
    id: "leercapitulo",
    name: "LeerCapítulo",

    async popular(offset = 0) {
        const page = Math.floor(offset / 48) + 1;
        const res = await harbor.http(`${baseUrl}/?page=${page}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll(".manga-card, .manga-item").forEach(el => {
            const link = el.querySelector("a");
            const img = el.querySelector("img");
            const title = el.querySelector("h3, .title")?.text()?.trim();

            if (link && title) {
                items.push({
                    id: link.attr("href") || "",
                    title: title,
                    cover: img?.attr("src") || img?.attr("data-src") || "",
                });
            }
        });

        return items;
    },

    async search(query, offset = 0) {
        const res = await harbor.http(`${baseUrl}/?s=${encodeURIComponent(query)}`, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const items = [];

        doc.querySelectorAll(".manga-card, .manga-item").forEach(el => {
            const link = el.querySelector("a");
            const img = el.querySelector("img");
            const title = el.querySelector("h3, .title")?.text()?.trim();

            if (link && title) {
                items.push({
                    id: link.attr("href") || "",
                    title: title,
                    cover: img?.attr("src") || img?.attr("data-src") || "",
                });
            }
        });

        return items;
    },

    async detail(id) {
        const res = await harbor.http(baseUrl + id, { responseType: "text" });
        if (!res.ok) return null;

        const doc = await harbor.parseHtml(res.body);

        return {
            id: id,
            title: doc.querySelector("h1.title-manga")?.text()?.trim() || "Sin título",
            cover: doc.querySelector(".cover-detail img, img[src*='/covers/']")?.attr("src") || "",
            description: doc.querySelector("#example2, .manga-collapse")?.text()?.trim(),
            status: "Ongoing"
        };
    },

    async chapters(id) {
        const res = await harbor.http(baseUrl + id, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const chapters = [];

        doc.querySelectorAll(".chapter-list a.xanh, .chapter-list h4 a").forEach(link => {
            const href = link.attr("href");
            const title = link.text().trim();

            if (href) {
                chapters.push({
                    id: href,
                    chapter: title.match(/(\d+)/)?.[0] || "",
                    title: title,
                    pages: 0,
                    language: "es"
                });
            }
        });

        return chapters.reverse();
    },

    async pageUrls(chapterId) {
        const res = await harbor.http(baseUrl + chapterId, { responseType: "text" });
        if (!res.ok) return [];

        const doc = await harbor.parseHtml(res.body);
        const urls = [];

        doc.querySelectorAll("img").forEach(img => {
            let src = img.attr("src") || img.attr("data-src") || "";
            if (src && (src.includes(".jpg") || src.includes(".png") || src.includes(".webp"))) {
                if (!src.startsWith("http")) src = baseUrl + src;
                urls.push(src);
            }
        });

        return urls;
    }
};

harbor.register(plugin);
