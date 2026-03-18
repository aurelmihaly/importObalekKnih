// prevodFotky_ultimate.js
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const serviceAccountPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "serviceAccountKey.json");
const serviceAccount = require(serviceAccountPath);

const rawBucket =
  process.env.FIREBASE_STORAGE_BUCKET ||
  `gs://${serviceAccount.project_id}.appspot.com`;

const bucketName = rawBucket.replace(/^gs:\/\//, "");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: bucketName
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

if (!fs.existsSync("./tmp")) fs.mkdirSync("./tmp");

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ================= ISBN =================

function normalizeISBN(isbn) {
  return (isbn || "").replace(/[^0-9Xx]/g, "").trim();
}

function isValidISBN(isbn) {
  const clean = normalizeISBN(isbn);
  return clean.length >= 10;
}

// ================= IMAGE =================

async function downloadImage(url, filename) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filename, Buffer.from(buffer));

    if (!isValidImage(filename)) {
      fs.unlinkSync(filename);
      return null;
    }

    return filename;
  } catch (err) {
    log("❌ Download error: " + err.message);
    return null;
  }
}

function isValidImage(file) {
  try {
    const stats = fs.statSync(file);
    return stats.size > 2000; // filtr na fake obrázky
  } catch {
    return false;
  }
}

// ================= SOURCES =================

// 1. Obalkyknih
async function getCoverFromObalkyKnih(isbn) {
  const cleanISBN = normalizeISBN(isbn);
  if (!isValidISBN(cleanISBN)) return null;

  log(`🔍 Obalkyknih: ${cleanISBN}`);

  try {
    const res = await fetch(`https://www.obalkyknih.cz/api/books?isbn=${cleanISBN}`);
    const text = await res.text();

    if (!text.startsWith("{") && !text.startsWith("[")) return null;

    const data = JSON.parse(text);
    const img = data?.[0]?.cover_medium_url;

    if (!img) return null;

    const file = path.join("./tmp", `${cleanISBN}.jpg`);
    return await downloadImage(img, file);
  } catch {
    return null;
  }
}

// 2. OpenLibrary
async function getCoverFromOpenLibrary(isbn) {
  const cleanISBN = normalizeISBN(isbn);
  log(`🔍 OpenLibrary: ${cleanISBN}`);

  const url = `https://covers.openlibrary.org/b/isbn/${cleanISBN}-L.jpg`;
  const file = path.join("./tmp", `${cleanISBN}.jpg`);
  return await downloadImage(url, file);
}

// 3. Google Books ISBN
async function getCoverFromGoogleBooks(isbn) {
  const cleanISBN = normalizeISBN(isbn);
  log(`🔍 Google ISBN: ${cleanISBN}`);

  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${cleanISBN}`);
    const data = await res.json();

    const img = data.items?.[0]?.volumeInfo?.imageLinks?.thumbnail;
    if (!img) return null;

    const file = path.join("./tmp", `${cleanISBN}.jpg`);
    return await downloadImage(img, file);
  } catch {
    return null;
  }
}

// 4. Amazon hack
async function getCoverFromAmazon(isbn) {
  const cleanISBN = normalizeISBN(isbn);
  log(`🔍 Amazon: ${cleanISBN}`);

  const url = `https://images-na.ssl-images-amazon.com/images/P/${cleanISBN}.01.L.jpg`;
  const file = path.join("./tmp", `${cleanISBN}.jpg`);
  return await downloadImage(url, file);
}

// 5. Google podle názvu
async function getCoverByTitle(title) {
  if (!title) return null;

  log(`🔍 Google TITLE: ${title}`);

  try {
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=intitle:${encodeURIComponent(title)}`);
    const data = await res.json();

    const img = data.items?.[0]?.volumeInfo?.imageLinks?.thumbnail;
    if (!img) return null;

    const file = path.join("./tmp", `${Date.now()}.jpg`);
    return await downloadImage(img, file);
  } catch {
    return null;
  }
}

// ================= FIREBASE =================

async function uploadToFirebase(file, dest) {
  const token = crypto.randomUUID();

  await bucket.upload(file, {
    destination: dest,
    metadata: {
      contentType: "image/jpeg",
      metadata: {
        firebaseStorageDownloadTokens: token
      }
    }
  });

  const encodedPath = encodeURIComponent(dest);

  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
}

// ================= CORE =================

async function getBestCover(isbn, title) {
  return (
    await getCoverFromObalkyKnih(isbn) ||
    await getCoverFromOpenLibrary(isbn) ||
    await getCoverFromGoogleBooks(isbn) ||
    await getCoverFromAmazon(isbn) ||
    await getCoverByTitle(title)
  );
}

async function processBook(doc, index, total) {
  const book = doc.data();
  const title = book["title"];
  const isbn = book["ISBN"];

  log(`\n📖 [${index + 1}/${total}] ${title || "BEZ NÁZVU"}`);

  let file = null;

  if (isValidISBN(isbn)) {
    file = await getBestCover(isbn, title);
  } else {
    log("⚠️ ISBN špatné → zkouším jen název");
    file = await getCoverByTitle(title);
  }

  if (!file) {
    log("⚠️ Cover nenalezen");
    return;
  }

  const dest = `covers/${doc.id}.jpg`;
  const url = await uploadToFirebase(file, dest);

  await db.collection("Knihy1").doc(doc.id).set(
    {
      ...book,
      imageUrl: url
    },
    { merge: true }
  );

  log("✅ Uloženo");
}

// ================= MAIN =================

async function main() {
  log(`🪣 Bucket: ${bucket.name}`);
  log("🚀 Načítám knihy...");

  const snapshot = await db.collection("Knihy").get();

  if (snapshot.empty) {
    log("❗ Kolekce je prázdná");
    return;
  }

  log(`📚 Celkem knih: ${snapshot.size}`);

  let i = 0;
  for (const doc of snapshot.docs) {
    await processBook(doc, i, snapshot.size);
    i++;
  }

  log("🎉 HOTOVO");
}

main();
