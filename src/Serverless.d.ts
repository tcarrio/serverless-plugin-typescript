declare namespace Serverless {
  interface Instance {
    cli: {
      log(str: string): void;
    };

    config: {
      servicePath: string;
    };

    service: {
      provider: {
        name: string;
      };
      functions: {
        [key: string]: Serverless.Function;
      };
      package: Serverless.Package;
      custom?: {
        [pluginName: string]: Partial<PluginConfig>;
      };
      getAllFunctions(): string[];
    };

    pluginManager: PluginManager;
  }

  interface Options {
    function?: string;
    watch?: boolean;
    extraServicePath?: string;
  }

  interface Function {
    handler: string;
    package: Serverless.Package;
  }

  interface Package {
    include: string[];
    exclude: string[];
    artifact?: string;
    individually?: boolean;
  }

  interface PluginConfig {
    originalServicePath: string;
    tsconfigPath: string;
  }

  interface PluginManager {
    spawn(command: string): Promise<void>;
  }
}
