#!/usr/bin/env node
/**
 * Check Shared Code Sync Between Frontend and Backend
 *
 * This script verifies that shared code is identical between
 * backend and frontend packages. Used in CI to prevent divergence.
 *
 * Usage: npm run check:shared
 * Exit code: 0 if synced, 1 if diverged
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BACKEND_SHARED = path.join(__dirname, "../backend/src/shared");
const FRONTEND_SHARED = path.join(__dirname, "../frontend/src/shared");

function getFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getAllFiles(dir, fileList = [], visited = new Set()) {
  // Resolve to absolute path to detect symlink loops
  const resolvedDir = fs.realpathSync(dir);

  // Check for circular symlinks
  if (visited.has(resolvedDir)) {
    console.warn(`⚠️  Skipping circular symlink: ${dir}`);
    return fileList;
  }
  visited.add(resolvedDir);

  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.lstatSync(filePath); // Use lstat to detect symlinks

    if (stat.isSymbolicLink()) {
      console.warn(`⚠️  Skipping symbolic link: ${filePath}`);
      return;
    }

    if (stat.isDirectory()) {
      getAllFiles(filePath, fileList, visited);
    } else {
      fileList.push(filePath);
    }
  });

  return fileList;
}

console.log("🔍 Checking shared code sync...");
console.log(`   Backend:  ${BACKEND_SHARED}`);
console.log(`   Frontend: ${FRONTEND_SHARED}`);
console.log("");

try {
  // Validate directories exist
  if (!fs.existsSync(BACKEND_SHARED)) {
    console.error(
      `❌ Backend shared directory does not exist: ${BACKEND_SHARED}`
    );
    process.exit(1);
  }
  if (!fs.existsSync(FRONTEND_SHARED)) {
    console.error(
      `❌ Frontend shared directory does not exist: ${FRONTEND_SHARED}`
    );
    process.exit(1);
  }

  // Get all files from both directories
  const backendFiles = getAllFiles(BACKEND_SHARED).map((f) =>
    path.relative(BACKEND_SHARED, f)
  );
  const frontendFiles = getAllFiles(FRONTEND_SHARED).map((f) =>
    path.relative(FRONTEND_SHARED, f)
  );

  // Check for missing files
  const missingInFrontend = backendFiles.filter(
    (f) => !frontendFiles.includes(f)
  );
  const missingInBackend = frontendFiles.filter(
    (f) => !backendFiles.includes(f)
  );

  let hasErrors = false;

  if (missingInFrontend.length > 0) {
    console.error("❌ Files missing in frontend:");
    missingInFrontend.forEach((f) => console.error(`   - ${f}`));
    hasErrors = true;
  }

  if (missingInBackend.length > 0) {
    console.error("❌ Files missing in backend:");
    missingInBackend.forEach((f) => console.error(`   - ${f}`));
    hasErrors = true;
  }

  // Check file contents
  const commonFiles = backendFiles.filter((f) => frontendFiles.includes(f));
  const divergedFiles = [];

  commonFiles.forEach((file) => {
    const backendPath = path.join(BACKEND_SHARED, file);
    const frontendPath = path.join(FRONTEND_SHARED, file);

    const backendHash = getFileHash(backendPath);
    const frontendHash = getFileHash(frontendPath);

    if (backendHash !== frontendHash) {
      divergedFiles.push(file);
    }
  });

  if (divergedFiles.length > 0) {
    console.error("❌ Files have diverged (content mismatch):");
    divergedFiles.forEach((f) => console.error(`   - ${f}`));
    console.error("");
    console.error(
      "💡 Run `npm run sync:shared` to sync from backend to frontend"
    );
    hasErrors = true;
  }

  if (hasErrors) {
    console.error("");
    console.error("❌ Shared code is NOT in sync!");
    process.exit(1);
  }

  console.log("✅ Shared code is in sync!");
  console.log(`   ${commonFiles.length} files verified`);
} catch (error) {
  console.error("❌ Error checking shared code:", error.message);
  process.exit(1);
}
