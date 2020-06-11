import * as ts from "./typescript";
import { watchFile, unwatchFile, Stats } from "fs";

export function watchFiles(
  rootFileNames: string[],
  tsconfigPath: string,
  originalServicePath: string,
  cb: () => void,
) {
  const tsConfig = ts.getTypescriptConfig(tsconfigPath, originalServicePath);
  let watchedFiles = ts.getSourceFiles(rootFileNames, tsConfig);

  watchedFiles.forEach(fileName => {
    watchFile(fileName, { persistent: true, interval: 250 }, watchCallback);
  });

  function watchCallback(curr: Stats, prev: Stats) {
    // Check timestamp
    if (+curr.mtime <= +prev.mtime) {
      return;
    }

    cb();

    // use can reference not watched yet file or remove reference to already watched
    const newWatchFiles = ts.getSourceFiles(rootFileNames, tsConfig);
    watchedFiles.forEach(fileName => {
      if (newWatchFiles.indexOf(fileName) < 0) {
        unwatchFile(fileName, watchCallback);
      }
    });

    newWatchFiles.forEach(fileName => {
      if (watchedFiles.indexOf(fileName) < 0) {
        watchFile(fileName, { persistent: true, interval: 250 }, watchCallback);
      }
    });

    watchedFiles = newWatchFiles;
  }
}
