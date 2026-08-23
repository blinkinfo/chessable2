// web-ext configuration: keeps lint/build focused on what actually ships.
module.exports = {
  ignoreFiles: [
    "engine",
    "node_modules",
    ".git",
    ".github",
    "bun.lock",
    "package.json",
    "package-lock.json",
    "readme.md",
    ".gitignore",
    "scripts/package-firefox.sh",
    "scripts/setup-engine.js",
    "icon.png",
    "chessable-firefox.xpi",
  ],
};
