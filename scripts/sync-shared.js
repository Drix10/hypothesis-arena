#!/usr/bin/env node
/**
 * Sync Shared Code Between Frontend and Backend
 *
 * This script copies the canonical shared code from backend to frontend
 * to keep both packages in sync.
 *
 * Usage: npm run sync:shared
 */

const fs = require("fs");
const path = require("path");

const BACKEND_SHARED = path.join(__dirname, "../packages/backend/src/shared");
const FRONTEND_SHARED = path.join(__dirname, "../packages/frontend/src/shared");

function copyRecursive(src, dest) {
  const exists = fs.existsSync(src);
  const stats = exists && fs.statSync(src);
  const isDirectory = exists && stats.isDirectory();

  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    fs.readdirSync(src).forEach((childItemName) => {
      copyRecursive(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
  } else {
    fs.copyFileSync(src, dest);
  }
}

console.log("🔄 Syncing shared code from backend to frontend...");
console.log(`   Source: ${BACKEND_SHARED}`);
console.log(`   Destination: ${FRONTEND_SHARED}`);
console.log("");

try {
  // Validate source directory exists
  if (!fs.existsSync(BACKEND_SHARED)) {
    console.error(`❌ Source directory does not exist: ${BACKEND_SHARED}`);
    console.error("   Cannot sync shared code without a source directory.");
    process.exit(1);
  }

  // Remove existing frontend shared folder
  if (fs.existsSync(FRONTEND_SHARED)) {
    fs.rmSync(FRONTEND_SHARED, { recursive: true, force: true });
  }

  // Copy from backend to frontend
  copyRecursive(BACKEND_SHARED, FRONTEND_SHARED);

  console.log("✅ Shared code synced successfully!");
  console.log("   Files copied:");

  // List copied files
  const listFiles = (dir, prefix = "") => {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        console.log(`   ${prefix}📁 ${file}/`);
        listFiles(filePath, prefix + "  ");
      } else {
        console.log(`   ${prefix}📄 ${file}`);
      }
    });
  };

  listFiles(FRONTEND_SHARED, "   ");
} catch (error) {
  console.error("❌ Error syncing shared code:", error.message);
  process.exit(1);
}
