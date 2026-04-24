const puppeteer = require("puppeteer");
const admin = require("firebase-admin");
const https = require("https");
const fs = require("fs");
const path = require("path");

// 🔥 Firebase init
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "book-catalogue-flutter.firebasestorage.app",
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// 📥 stáhne obrázek do dočasného souboru
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);

    https
      .get(url, response => {
        response.pipe(file);
        file.on("finish", () => {
          file.close(resolve);
        });
      })
      .on("error", err => {
        fs.unlink(filepath, () => reject(err));
      });
  });
}
///////////////////////////////////////////////////////
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // odstraní diakritiku
    .replace(/[.,:;!?()[\]'"`´-]/g, " ") // odstraní interpunkci
    .replace(/\b(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, match => {
      const romanMap = {
        i: "1",
        ii: "2",
        iii: "3",
        iv: "4",
        v: "5",
        vi: "6",
        vii: "7",
        viii: "8",
        ix: "9",
        x: "10",
      };
      return romanMap[match] || match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function isPublisherMatch(dbPublisher, scrapedPublisher) {
  const a = normalizeText(dbPublisher);
  const b = normalizeText(scrapedPublisher);

  if (!a || !b) return false;

  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const aWords = a.split(" ").filter(w => w.length > 1);
  const bWords = b.split(" ").filter(w => w.length > 1);
  const commonWords = aWords.filter(word => bWords.includes(word));

  return commonWords.length >= 1;
}

function extractPagesFromText(text) {
  const lines = String(text || "")
    .split("\n")
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // varianta: "Počet stran: 286"
    let match = line.match(/Počet stran\s*:?\s*(\d{2,5})/i);
    if (match) return Number(match[1]);

    // varianta: "Počet stran:" na jednom řádku a číslo na dalším
    if (/Počet stran\s*:?/i.test(line) && lines[i + 1]) {
      match = lines[i + 1].match(/^(\d{2,5})$/);
      if (match) return Number(match[1]);
    }

    // fallbacky
    match = line.match(/Stran\s*:?\s*(\d{2,5})/i);
    if (match) return Number(match[1]);

    match = line.match(/^(\d{2,5})\s*stran$/i);
    if (match) return Number(match[1]);
  }

  return null;
}

function extractPagesFromMetadataText(text) {
  const normalized = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let match = normalized.match(/Počet stran\s*:?\s*(\d{2,5})/i);
  if (match) return Number(match[1]);

  match = normalized.match(/Stran\s*:?\s*(\d{2,5})/i);
  if (match) return Number(match[1]);

  return null;
}

function hasMissingBookData(data) {
  const hasCover = typeof data.coverUrl === "string" && data.coverUrl.trim() !== "";
  const hasGenre = Array.isArray(data.genre) && data.genre.length > 0;
  const hasPages = Number.isInteger(data.pages) && data.pages > 0;
  const hasDescription = typeof data.description === "string" && data.description.trim() !== "";

  return !(hasCover && hasGenre && hasPages && hasDescription);
}

async function expandMoreInfo(page) {
  try {
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll("a, button, span, div")];
      const target = candidates.find(el => {
        const text = (el.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
        return text === "více info..." || text === "vice info..." || text === "více info" || text === "vice info";
      });

      if (target) {
        target.click();
        return true;
      }

      return false;
    });

    if (clicked) {
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch {}
}

async function extractDescription(page) {
  try {
    const description = await page.evaluate(() => {
      const normalize = value => String(value || "").replace(/\s+/g, " ").trim();

      // 1) hlavní popis na Databázi knih bývá přímo v <p class="new2 odtop">
      const directParagraph = document.querySelector("p.new2.odtop");
      const directText = normalize(directParagraph?.innerText || "");

      if (
        directText &&
        directText !== "Popis knihy zde zatím bohužel není..." &&
        directText.length >= 40 &&
        !directText.includes("Přihlásit Vytvořit profil") &&
        !directText.includes("Vydáno:") &&
        !directText.includes("Počet stran:") &&
        !directText.includes("Jazyk vydání:") &&
        !directText.includes("ISBN:") &&
        !/\bpřehled\b/i.test(directText) &&
        !/\bnehodnoceno\b/i.test(directText)
      ) {
        return directText;
      }

      // 2) fallback: najdi text v nejbližším okolí odkazu "celý text"
      const triggers = [...document.querySelectorAll("a, button, span, div")];
      const fullTextTrigger = triggers.find(el => {
        const text = normalize(el.innerText).toLowerCase();
        return (
          text === "celý text" ||
          text === "... celý text" ||
          text === "cely text" ||
          text === "... cely text"
        );
      });

      if (fullTextTrigger) {
        let node = fullTextTrigger.previousElementSibling;
        while (node) {
          const text = normalize(node.innerText);
          if (
            text &&
            text.length >= 40 &&
            !text.includes("Vydáno:") &&
            !text.includes("Počet stran:") &&
            !text.includes("Jazyk vydání:") &&
            !text.includes("ISBN:") &&
            !text.includes("Přihlásit Vytvořit profil") &&
            !text.includes("Databazeknih.cz") &&
            text !== "Popis knihy zde zatím bohužel není..."
          ) {
            return text;
          }
          node = node.previousElementSibling;
        }
      }

      return null;
    });

    return description;
  } catch {
    return null;
  }
}

async function expandFullDescription(page) {
  try {
    const clicked = await page.evaluate(() => {
      const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

      // nejdřív zkus přímo odkaz vedle popisu
      const paragraph = document.querySelector("p.new2.odtop");
      if (paragraph) {
        let sibling = paragraph.nextElementSibling;
        let safety = 0;

        while (sibling && safety < 5) {
          const text = normalize(sibling.innerText);
          if (
            text === "celý text" ||
            text === "... celý text" ||
            text === "cely text" ||
            text === "... cely text"
          ) {
            sibling.click();
            return true;
          }
          sibling = sibling.nextElementSibling;
          safety += 1;
        }
      }

      // fallback: projdi celou stránku
      const candidates = [...document.querySelectorAll("a, button, span, div")];
      const target = candidates.find(el => {
        const text = normalize(el.innerText);
        return (
          text === "celý text" ||
          text === "... celý text" ||
          text === "cely text" ||
          text === "... cely text"
        );
      });

      if (target) {
        target.click();
        return true;
      }

      return false;
    });

    if (clicked) {
      await new Promise(r => setTimeout(r, 1200));
    }
  } catch {}
}

async function extractBookDetail(page) {
  let coverUrl = null;
  let genre = [];
  let publisher = null;
  let pages = null;
  let publishedRaw = null;
  let description = null;

  // obálka: zkus více selectorů
  try {
    coverUrl = await page.$eval("img.coverOnDetail", img => img.src);
  } catch {}

  if (!coverUrl) {
    try {
      coverUrl = await page.$eval(
        'img[src*="/img/books/"]',
        img => img.src
      );
    } catch {}
  }

  if (!coverUrl) {
    try {
      const allImgs = await page.$$eval("img", imgs =>
        imgs.map(img => img.src).filter(Boolean)
      );
      coverUrl = allImgs.find(src => src.includes("/img/books/")) || null;
    } catch {}
  }

  try {
    genre = await page.$$eval(
      'a[href*="/zanry/"]',
      els => [...new Set(els.map(e => e.innerText.trim()).filter(Boolean))]
    );
  } catch {}

  const pageText = await page.evaluate(() => document.body.innerText);

  const metadataTexts = await page.evaluate(() => {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim();

    return [...document.querySelectorAll("body *")]
      .map(el => normalize(el.innerText))
      .filter(text =>
        text &&
        (text.includes("Vydáno") ||
          text.includes("Počet stran") ||
          text.includes("Jazyk vydání") ||
          text.includes("Vazba knihy") ||
          text.includes("ISBN"))
      );
  });
  description = await extractDescription(page);

  // vydáno / nakladatelství
  const publishedMatch = pageText.match(/Vydáno:\s*([^\n]+)/i);
  if (publishedMatch) {
    publishedRaw = publishedMatch[1].trim();

    const parts = publishedRaw.split(",");
    if (parts.length >= 2) {
      publisher = parts.slice(1).join(",").trim();
    }
  }

  // počet stran: zkus přímo projet texty elementů na stránce
  try {
    const extractedPages = await page.evaluate(() => {
      const normalize = value => String(value || "").replace(/\s+/g, " ").trim();

      const texts = [...document.querySelectorAll("body *")]
        .map(el => normalize(el.innerText))
        .filter(Boolean);

      for (let i = 0; i < texts.length; i++) {
        const line = texts[i];

        let match = line.match(/^Počet stran\s*:?\s*(\d{2,5})$/i);
        if (match) return Number(match[1]);

        match = line.match(/^Stran\s*:?\s*(\d{2,5})$/i);
        if (match) return Number(match[1]);

        if (/^Počet stran\s*:?$/i.test(line) && texts[i + 1]) {
          match = texts[i + 1].match(/^(\d{2,5})$/);
          if (match) return Number(match[1]);
        }

        if (/^Stran\s*:?$/i.test(line) && texts[i + 1]) {
          match = texts[i + 1].match(/^(\d{2,5})$/);
          if (match) return Number(match[1]);
        }
      }

      const bodyText = normalize(document.body?.innerText || "");

      let match = bodyText.match(/Počet stran\s*:?\s*(\d{2,5})/i);
      if (match) return Number(match[1]);

      match = bodyText.match(/Stran\s*:?\s*(\d{2,5})/i);
      if (match) return Number(match[1]);

      return null;
    });

    if (extractedPages) {
      pages = extractedPages;
    }
  } catch {}

  // zkus metadata bloky, kde bývají údaje typu Vydáno / Počet stran / ISBN pohromadě
  if (!pages) {
    for (const metaText of metadataTexts) {
      const extracted = extractPagesFromMetadataText(metaText);
      if (extracted) {
        pages = extracted;
        break;
      }
    }
  }

  // fallback přes text helper
  if (!pages) {
    pages = extractPagesFromText(pageText);
  }

  // odfiltruj nesmysly typu 5, 8, 12 nebo 0
  if (!pages || pages < 16) {
    pages = null;
  }

  return { coverUrl, genre, publisher, pages, publishedRaw, metadataTexts, description };
}

// 🕷️ scraping
async function scrapeBook(page, title, author, expectedPublisher) {
  if (!title || typeof title !== "string") {
    throw new Error("title chybí nebo není string");
  }

  const query = `${title} ${author || ""}`;

  await page.setCookie({
    name: "euconsent-v2",
    value: "accepted",
    domain: ".databazeknih.cz",
  });

  await page.goto(
    `https://www.databazeknih.cz/vyhledavani/knihy?q=${encodeURIComponent(query)}`,
    { waitUntil: "domcontentloaded" }
  );

  try {
    await new Promise(r => setTimeout(r, 1500));
    const buttons = await page.$$("button");

    for (const btn of buttons) {
      const text = await page.evaluate(el => el.innerText, btn);

      if (
        text.includes("Souhlas") ||
        text.includes("Přijmout") ||
        text.includes("Accept")
      ) {
        await btn.click();
        await new Promise(r => setTimeout(r, 1000));
        console.log("🍪 Cookies odsouhlaseny:", text);
        break;
      }
    }
  } catch {}

  await page.waitForSelector("a", { timeout: 7000 });

  const linksOnPage = await page.$$eval("a", links =>
    links
      .map(link => ({
        text: link.innerText.trim(),
        href: link.href,
        visible:
          window.getComputedStyle(link).display !== "none" &&
          window.getComputedStyle(link).visibility !== "hidden" &&
          link.offsetHeight > 0,
      }))
      .filter(link => link.visible && link.text.length > 0)
  );

  console.log("🔍 Viditelné odkazy na stránce:");
  console.log(linksOnPage);

  const normalizedTitle = normalizeText(title);
  const normalizedAuthor = normalizeText(author || "");

  const scoredLinks = linksOnPage
    .filter(link =>
      link.href.includes("/prehled-knihy/")
    )
    .map(link => {
      const normalizedLinkText = normalizeText(link.text);

      let score = 0;

      if (normalizedLinkText === normalizedTitle) score += 100;
      if (normalizedLinkText.includes(normalizedTitle)) score += 60;
      if (normalizedTitle.includes(normalizedLinkText)) score += 40;

      const titleWords = normalizedTitle.split(" ");
      for (const word of titleWords) {
        if (word.length > 2 && normalizedLinkText.includes(word)) {
          score += 10;
        }
      }

      if (normalizedAuthor && normalizedLinkText.includes(normalizedAuthor)) {
        score += 30;
      }

      return { ...link, score };
    })
    .filter(link => link.score > 0)
    .sort((a, b) => b.score - a.score);

  console.log("🏆 Nejlepší kandidáti:", scoredLinks.slice(0, 10));

  if (scoredLinks.length === 0) {
    console.log("⚠️ Kniha nenalezena ve výsledcích:", title);
    return { coverUrl: null, genre: [], publisher: null, pages: null };
  }

  for (const candidate of scoredLinks.slice(0, 10)) {
    console.log("🔗 Otevírám detail:", candidate.href);

    try {
      await page.goto(candidate.href, { waitUntil: "domcontentloaded" });
      await new Promise(r => setTimeout(r, 1200));

      try {
        await page.waitForFunction(
          () => {
            const text = document.body?.innerText || "";
            return text.includes("Vydáno") || text.includes("více info") || text.includes("vice info");
          },
          { timeout: 4000 }
        );
      } catch {}

      await expandFullDescription(page);
      await expandMoreInfo(page);

      try {
        await page.waitForFunction(
          () => {
            const text = document.body?.innerText || "";
            return text.includes("Počet stran") || text.includes("Jazyk vydání") || text.includes("Vazba knihy") || text.includes("ISBN");
          },
          { timeout: 4000 }
        );
      } catch {}

      const detail = await extractBookDetail(page);

      console.log("📘 Detail kandidáta:", {
        title,
        expectedPublisher,
        publishedRaw: detail.publishedRaw,
        foundPublisher: detail.publisher,
        pages: detail.pages,
        genre: detail.genre,
        coverUrl: detail.coverUrl,
        hasCover: !!detail.coverUrl,
        pagesType: typeof detail.pages,
        pageHasPageLabel: (await page.evaluate(() => (document.body?.innerText || "").includes("Počet stran"))),
        pageHasMoreInfoLabel: (await page.evaluate(() => { const text = (document.body?.innerText || "").toLowerCase(); return text.includes("více info") || text.includes("vice info"); })),
        pageHasFullTextLabel: (await page.evaluate(() => { const text = (document.body?.innerText || "").toLowerCase(); return text.includes("celý text") || text.includes("cely text"); })),
        metadataPreview: detail.metadataTexts?.slice(0, 5),
        bodyPreview: await page.evaluate(() => (document.body?.innerText || "").slice(0, 1200)),
        descriptionPreview: detail.description?.slice(0, 300),
        hasDescription: !!detail.description,
      });

      if (expectedPublisher) {
        if (isPublisherMatch(expectedPublisher, detail.publisher)) {
          console.log("✅ Nakladatelství sedí:", expectedPublisher, "<=>", detail.publisher);
          return detail;
        } else {
          console.log("⛔ Nakladatelství nesedí:", expectedPublisher, "<=>", detail.publisher);
          continue;
        }
      } else {
        if (detail.coverUrl) {
          console.log("✅ Beru první výsledek bez kontroly nakladatelství");
          return detail;
        }
      }
    } catch (err) {
      console.log("❌ Chyba při detailu:", candidate.href, err.message);
    }
  }

  console.log("⚠️ Nenašlo se vydání se správným nakladatelstvím:", title);
  return { coverUrl: null, genre: [], publisher: null, pages: null, description: null };
}

// 🔄 hlavní funkce
async function run() {
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  const snapshot = await db.collection("Knihy1").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!data.title || typeof data.title !== "string") {
      console.log("⚠️ Přeskakuji dokument bez title:", doc.id, data);
      continue;
    }

    if (!hasMissingBookData(data)) {
      console.log("✅ Přeskakuji, kniha už má coverUrl, genre, pages i description:", data.title);
      continue;
    }

    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));

    console.log("📚 Zpracovávám chybějící data pro:", data.title);

    try {
      const result = await scrapeBook(page, data.title, data.author, data.publication);

      let firebaseImageUrl = null;

      if (result.coverUrl) {
        const tempPath = path.join(__dirname, `${doc.id}.jpg`);
        await downloadImage(result.coverUrl, tempPath);

        const storagePath = `puppeteer1/${doc.id}.jpg`;

        await bucket.upload(tempPath, {
          destination: storagePath,
        });

        const file = bucket.file(storagePath);

        [firebaseImageUrl] = await file.getSignedUrl({
          action: "read",
          expires: "03-01-2500",
        });

        fs.unlinkSync(tempPath);
      }

      const updateData = {};

      // pojistka: nepřepisuj obrázek na null
      if (firebaseImageUrl) {
        updateData.coverUrl = firebaseImageUrl;
      }

      // pojistka: žánry jen pokud existují
      if (Array.isArray(result.genre) && result.genre.length > 0) {
        updateData.genre = result.genre;
      }

      // počet stran zapisuj vždy, i když je null
      updateData.pages = result.pages ?? null;

      // publisher si ukládej vždy pro debug
      if (result.publisher) {
        updateData.matchedPublisher = result.publisher;
      }
      // popis knihy ukládej, pokud existuje
      if (result.description) {
        updateData.description = result.description;
      }

      if (Object.keys(updateData).length > 0) {
        await doc.ref.update(updateData);
        console.log("💾 Uloženo:", updateData);
      } else {
        console.log("⚠️ Nic k uložení (žádná validní data):", data.title);
      }
    } catch (err) {
      console.log("❌ Chyba:", data.title, err.message);
    }
  }

  await browser.close();
}

run();