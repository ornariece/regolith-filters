import fs from "fs";
import path from "path";
const DIRECTORY = "data/gametests/";

/**
 * Source: https://stackoverflow.com/a/22185855/6459649
 * Look ma, it's cp -R.
 * @param {string} src  The path to the thing to copy.
 * @param {string} dest The path to the new copy.
 */
var copyRecursiveSync = function (src, dest) {
  var exists = fs.existsSync(src);
  var stats = exists && fs.statSync(src);
  var isDirectory = exists && stats.isDirectory();
  if (isDirectory) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest);
    }
    fs.readdirSync(src).forEach(function (childItemName) {
      copyRecursiveSync(
        path.join(src, childItemName),
        path.join(dest, childItemName)
      );
    });
  } else {
    fs.copyFileSync(src, dest);
  }
};

// Copies the optional `extra_files` directory into the pack root, if present.
export function moveExtraFiles() {
  if (!fs.existsSync(DIRECTORY + "extra_files")) {
    console.log("No extra files, skipping step");
    return;
  }
  console.log("Copying extra files");
  copyRecursiveSync(DIRECTORY + "extra_files", "./");
}
