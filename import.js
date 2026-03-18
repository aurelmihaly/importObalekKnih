const admin = require("firebase-admin");
const path = require("path");
const data = require("./data.json");

const serviceAccountPath =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.join(__dirname, "serviceAccountKey.json");
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
                 
async function importData() {
  const collection = db.collection("Knihy1");

  for (const item of data) {
    const rawId = String(item.inventory_number ?? "").trim();

    if (!rawId) {
      throw new Error("Missing inventory_number for document ID.");
    }

    // Encode to allow characters like '/' while preserving identity.
    const docId = encodeURIComponent(rawId);

    await collection.doc(docId).set(item);
  }

  console.log("Data importována");
}

importData().catch((err) => {
  console.error("Import failed:", err);
  process.exitCode = 1;
});
