import * as path from "path";
import * as fs from "fs-extra";
import globby from "globby";

import * as _ from "./fauxdash";
import * as ts from "./typescript";
import { watchFiles } from "./watchFiles";

const SERVERLESS_FOLDER = ".serverless";
const BUILD_FOLDER = ".build";
const PLUGIN_NAME = "serverless-plugin-typescript";

export class TypeScriptPlugin {
  private isWatching = false;
  private config: Serverless.PluginConfig;

  public serverless: Serverless.Instance;
  public options: Serverless.Options;
  public hooks: { [key: string]: Serverless.HookFunc };

  public constructor(
    serverless: Serverless.Instance,
    options: Serverless.Options,
  ) {
    this.serverless = serverless;
    this.options = options;
    this.config = this.buildConfig();

    this.hooks = {
      "before:run:run": async () => {
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
      },
      "before:offline:start": async () => {
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
        this.watchAll();
      },
      "before:offline:start:init": async () => {
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
        this.watchAll();
      },
      "before:package:createDeploymentArtifacts": async () => {
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies(true);
      },
      "after:package:createDeploymentArtifacts": async () => {
        await this.cleanup();
      },
      "before:deploy:function:packageFunction": async () => {
        await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies(true);
      },
      "after:deploy:function:packageFunction": async () => {
        await this.cleanup();
      },
      "before:invoke:local:invoke": async () => {
        const emittedFiles = await this.compileTs();
        await this.copyExtras();
        await this.copyDependencies();
        if (this.isWatching) {
          emittedFiles.forEach(filename => {
            const module = require.resolve(
              path.resolve(this.config.originalServicePath, filename),
            );
            delete require.cache[module];
          });
        }
      },
      "after:invoke:local:invoke": () => {
        if (this.options.watch) {
          this.watchFunction();
          this.serverless.cli.log("Waiting for changes...");
        }
      },
    };
  }

  public get functions() {
    const { options } = this;
    const { service } = this.serverless;

    if (options.function) {
      return {
        [options.function]: service.functions[options.function],
      };
    }

    return service.functions;
  }

  public get rootFileNames() {
    return ts.extractFileNames(
      this.config.originalServicePath,
      this.serverless.service.provider.name,
      this.functions,
    );
  }

  private prepare() {
    // exclude serverless-plugin-typescript
    for (const fnName in this.functions) {
      const fn = this.functions[fnName];
      fn.package = fn.package || {
        exclude: [],
        include: [],
      };

      // Add plugin to excluded packages or an empty array if exclude is undefined
      fn.package.exclude = _.uniq([
        ...(fn.package.exclude || []),
        "node_modules/serverless-plugin-typescript",
      ]);
    }
  }

  private async watchFunction(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.serverless.cli.log(`Watch function ${this.options.function}...`);

    this.isWatching = true;
    watchFiles(
      this.rootFileNames,
      this.config.tsconfigPath,
      this.config.originalServicePath,
      () => {
        this.serverless.pluginManager.spawn("invoke:local");
      },
    );
  }

  private async watchAll(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    this.serverless.cli.log(`Watching typescript files...`);

    this.isWatching = true;
    watchFiles(
      this.rootFileNames,
      this.config.tsconfigPath,
      this.config.originalServicePath,
      this.compileTs.bind(this),
    );
  }

  private async compileTs(): Promise<string[]> {
    this.prepare();
    this.serverless.cli.log("Compiling with Typescript...");

    const tsconfig = ts.getTypescriptConfig(
      this.config.tsconfigPath,
      this.config.originalServicePath,
      this.isWatching ? undefined : this.serverless.cli,
    );

    tsconfig.outDir = BUILD_FOLDER;

    const emittedFiles = await ts.run(this.rootFileNames, tsconfig);
    this.serverless.cli.log("Typescript compiled.");
    return emittedFiles;
  }

  /** Link or copy extras such as node_modules or package.include definitions */
  private async copyExtras() {
    const { service } = this.serverless;

    // include any "extras" from the "include" section
    if (service.package.include && service.package.include.length > 0) {
      const files = await globby(service.package.include);

      for (const filename of files) {
        const destFileName = path.resolve(path.join(BUILD_FOLDER, filename));
        const dirname = path.dirname(destFileName);

        if (!fs.existsSync(dirname)) {
          fs.mkdirpSync(dirname);
        }

        if (!fs.existsSync(destFileName)) {
          fs.copySync(
            path.resolve(filename),
            path.resolve(path.join(BUILD_FOLDER, filename)),
          );
        }
      }
    }
  }

  /**
   * Copy the `node_modules` folder and `package.json` files to the output
   * directory.
   * @param isPackaging Provided if serverless is packaging the service for deployment
   */
  private async copyDependencies(isPackaging = false) {
    const outPkgPath = path.resolve(path.join(BUILD_FOLDER, "package.json"));
    const outModulesPath = path.resolve(
      path.join(BUILD_FOLDER, "node_modules"),
    );

    // copy development dependencies during packaging
    if (isPackaging) {
      if (fs.existsSync(outModulesPath)) {
        fs.unlinkSync(outModulesPath);
      }

      fs.copySync(
        path.resolve("node_modules"),
        path.resolve(path.join(BUILD_FOLDER, "node_modules")),
      );
    } else {
      if (!fs.existsSync(outModulesPath)) {
        await this.linkOrCopy(
          path.resolve("node_modules"),
          outModulesPath,
          "junction",
        );
      }
    }

    // copy/link package.json
    if (!fs.existsSync(outPkgPath)) {
      await this.linkOrCopy(path.resolve("package.json"), outPkgPath, "file");
    }
  }

  /**
   * Move built code to the serverless folder, taking into account individual
   * packaging preferences.
   */
  private async moveArtifacts(): Promise<void> {
    const { service, cli } = this.serverless;

    cli.log(`this.options.function: ${this.options.function}`);

    await fs.copy(
      path.join(
        this.config.originalServicePath,
        BUILD_FOLDER,
        SERVERLESS_FOLDER,
      ),
      path.join(this.config.originalServicePath, SERVERLESS_FOLDER),
    );

    if (this.options.function) {
      const fn = service.functions[this.options.function];
      cli.log(`fn.package.artifact: ${fn.package.artifact}`);
      fn.package.artifact = path.join(
        this.config.originalServicePath,
        SERVERLESS_FOLDER,
        path.basename(fn.package.artifact!),
      );
      return;
    }

    if (service.package.individually) {
      const functionNames = service.getAllFunctions();
      functionNames.forEach(name => {
        service.functions[name].package.artifact = path.join(
          this.config.originalServicePath,
          SERVERLESS_FOLDER,
          path.basename(service.functions[name].package.artifact!),
        );
        cli.log(
          `service.functions[${name}].package.artifact!): ${service.functions[
            name
          ].package.artifact!})}`,
        );
      });
      return;
    }

    service.package.artifact = path.join(
      this.config.originalServicePath,
      SERVERLESS_FOLDER,
      path.basename(service.package.artifact!),
    );
    cli.log(`service.package.artifact: ${service.package.artifact}`);
  }

  private async cleanup(): Promise<void> {
    await this.moveArtifacts();
    // Restore service path
    this.serverless.config.servicePath = this.config.originalServicePath;
    // Remove temp build folder
    fs.removeSync(path.join(this.config.originalServicePath, BUILD_FOLDER));
  }

  /**
   * Attempt to symlink a given path or directory and copy if it fails with an
   * `EPERM` error.
   */
  private async linkOrCopy(
    srcPath: string,
    dstPath: string,
    type?: fs.FsSymlinkType,
  ): Promise<void> {
    return fs.symlink(srcPath, dstPath, type).catch(error => {
      if (error.code === "EPERM" && error.errno === -4048) {
        return fs.copy(srcPath, dstPath);
      }
      throw error;
    });
  }

  /**
   * Generates the plugin config while also setting new values in the Serverless
   * config so that Serverless knows the real directory for the plugin code
   */
  private buildConfig(): Serverless.PluginConfig {
    const originalServicePath = this.serverless.config.servicePath;
    // Fake service path so that serverless will know what to zip
    this.serverless.config.servicePath = path.join(
      originalServicePath,
      BUILD_FOLDER,
    );

    const tsconfigRelPath =
      (this.serverless.service.custom &&
        this.serverless.service.custom[PLUGIN_NAME] &&
        this.serverless.service.custom[PLUGIN_NAME].tsconfigPath) ||
      "tsconfig.json";
    const tsconfigPath = path.join(originalServicePath, tsconfigRelPath);

    this.serverless.cli.log(`Found tsconfig path: ${tsconfigPath}`);

    return {
      originalServicePath,
      tsconfigPath,
    };
  }
}

module.exports = TypeScriptPlugin;
