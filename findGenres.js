// prevodZanru_ultimate.js
const admin = require("firebase-admin");
const path = require("path");
const fetch = require("node-fetch"); // npm install node-fetch@2

// --- Firebase init ---
const serviceAccountPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "serviceAccountKey.json");
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ================= ISBN =================
function normalizeISBN(isbn) {
  return (isbn || "").replace(/[^0-9Xx]/g, "").trim();
}

function isValidISBN(isbn) {
  const clean = normalizeISBN(isbn);
  // ISBN-10 (10 znaků) nebo ISBN-13 (13 znaků)
  return clean.length === 10 || clean.length === 13;
}

// ================= MAPOVÁNÍ ŽÁNRŮ =================
function mapToCzechGenre(raw) {
  if (!raw) return null;
  const g = raw.toLowerCase();
  if (g.includes("fiction")) return "Beletrie";
  if (g.includes("science fiction") || g.includes("sci-fi")) return "Sci-Fi";
  if (g.includes("fantasy")) return "Fantasy";
  if (g.includes("mystery") || g.includes("detective")) return "Detektivka";
  if (g.includes("children") || g.includes("juvenile")) return "Pro děti";
  if (g.includes("poetry") || g.includes("poem")) return "Poezie";
  if (g.includes("history") || g.includes("historical")) return "Historický román";
  if (g.includes("drama")) return "Drama";
  return null;
}

// ================= FETCH =================
async function fetchOpenLibrarySubjectsByISBN(isbn) {
  if (!isValidISBN(isbn)) return [];
  const url = `https://openlibrary.org/isbn/${normalizeISBN(isbn)}.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.subjects || [];
  } catch {
    return [];
  }
}

async function fetchGoogleBooksCategoriesByISBN(isbn) {
  if (!isbn) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${normalizeISBN(isbn)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      return data.items[0].volumeInfo.categories || [];
    }
  } catch {}
  return [];
}

// fallback podle title
async function fetchGoogleBooksCategoriesByTitle(title) {
  if (!title) return [];
  const url = `https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      return data.items[0].volumeInfo.categories || [];
    }
  } catch {}
  return [];
}

// ================= CORE =================
async function getGenre(book) {
  const isbn = book.ISBN;
  const title = book.title;

  let genres = [];
  if (isValidISBN(isbn)) {
    genres = await fetchOpenLibrarySubjectsByISBN(isbn);
    if (!genres.length) genres = await fetchGoogleBooksCategoriesByISBN(isbn);
  }

  // fallback podle title
  if (!genres.length && title) {
    genres = await fetchGoogleBooksCategoriesByTitle(title);
  }

  for (const g of genres) {
    const mapped = mapToCzechGenre(g);
    if (mapped) return mapped;
  }

  return "Neznámé";
}

async function processBook(doc, index, total) {
  const book = doc.data();
  const title = book.title || "BEZ NÁZVU";

  console.log(`\n📖 [${index + 1}/${total}] ${title} | ISBN: ${book.ISBN}`);

  const genre = await getGenre(book);

  try {
    await doc.ref.update({ genre });
    console.log(`✅ ${title} → ${genre}`);
  } catch (err) {
    console.error(`❌ Firestore error for ${title}:`, err);
  }

  await new Promise(r => setTimeout(r, 200)); // pauza kvůli API limitům
}

// ================= MAIN =================
async function main() {
  console.log("🚀 Načítám knihy...");
  const snapshot = await db.collection("Knihy1").get();

  if (snapshot.empty) {
    console.log("❗ Kolekce je prázdná");
    return;
  }

  console.log(`📚 Celkem knih: ${snapshot.size}`);

  let i = 0;
  for (const doc of snapshot.docs) {
    await processBook(doc, i, snapshot.size);
    i++;
  }

  console.log("🎉 HOTOVO!");
}

main();