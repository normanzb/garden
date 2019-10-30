/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { parse, relative, resolve, dirname } from "path"
import { flatten, isString, cloneDeep, sortBy, fromPairs, keyBy } from "lodash"
const AsyncLock = require("async-lock")

import { TreeCache } from "./cache"
import { builtinPlugins } from "./plugins/plugins"
import { Module, getModuleCacheContext, getModuleKey, ModuleConfigMap } from "./types/module"
import { pluginModuleSchema } from "./types/plugin/plugin"
import { SourceConfig, ProjectConfig, resolveProjectConfig, pickEnvironment } from "./config/project"
import { findByName, pickKeys, getPackageVersion, getNames } from "./util/util"
import { ConfigurationError, PluginError, RuntimeError } from "./exceptions"
import { VcsHandler, ModuleVersion } from "./vcs/vcs"
import { GitHandler } from "./vcs/git"
import { BuildDir } from "./build-dir"
import { ConfigGraph } from "./config-graph"
import { TaskGraph, TaskResults, ProcessTasksOpts } from "./task-graph"
import { getLogger } from "./logger/logger"
import { PluginActionHandlers, GardenPlugin } from "./types/plugin/plugin"
import { validate, PrimitiveMap, validateWithPath } from "./config/common"
import { resolveTemplateStrings } from "./template-string"
import { loadConfig, findProjectConfig } from "./config/base"
import { BaseTask } from "./tasks/base"
import { LocalConfigStore, ConfigStore, GlobalConfigStore } from "./config-store"
import { getLinkedSources, ExternalSourceType } from "./util/ext-source-util"
import { BuildDependencyConfig, ModuleConfig, ModuleResource, moduleConfigSchema } from "./config/module"
import { ModuleConfigContext, ContextResolveOpts } from "./config/config-context"
import { createPluginContext, CommandInfo } from "./plugin-context"
import { ModuleAndRuntimeActionHandlers, RegisterPluginParam } from "./types/plugin/plugin"
import { SUPPORTED_PLATFORMS, SupportedPlatform, DEFAULT_GARDEN_DIR_NAME } from "./constants"
import { platform, arch } from "os"
import { LogEntry } from "./logger/log-entry"
import { EventBus } from "./events"
import { Watcher } from "./watch"
import { findConfigPathsInPath, getConfigFilePath, getWorkingCopyId, fixedExcludes } from "./util/fs"
import { Provider, ProviderConfig, getAllProviderDependencyNames, defaultProvider } from "./config/provider"
import { ResolveProviderTask } from "./tasks/resolve-provider"
import { ActionRouter } from "./actions"
import { detectCycles, cyclesToString, Dependency } from "./util/validate-dependencies"
import chalk from "chalk"
import { RuntimeContext } from "./runtime-context"
import { deline } from "./util/string"
import { loadPlugins, getModuleTypeBases } from "./plugins"

export interface ActionHandlerMap<T extends keyof PluginActionHandlers> {
  [actionName: string]: PluginActionHandlers[T]
}

export interface ModuleActionHandlerMap<T extends keyof ModuleAndRuntimeActionHandlers> {
  [actionName: string]: ModuleAndRuntimeActionHandlers[T]
}

export type PluginActionMap = {
  [A in keyof PluginActionHandlers]: {
    [pluginName: string]: PluginActionHandlers[A]
  }
}

export type ModuleActionMap = {
  [A in keyof ModuleAndRuntimeActionHandlers]: {
    [moduleType: string]: {
      [pluginName: string]: ModuleAndRuntimeActionHandlers[A]
    }
  }
}

export interface GardenOpts {
  config?: ProjectConfig
  commandInfo?: CommandInfo
  gardenDirPath?: string
  environmentName?: string
  persistent?: boolean
  log?: LogEntry
  plugins?: RegisterPluginParam[]
}

interface ModuleConfigResolveOpts extends ContextResolveOpts {
  configContext?: ModuleConfigContext
}

export interface GardenParams {
  buildDir: BuildDir
  environmentName: string
  dotIgnoreFiles: string[]
  gardenDirPath: string
  log: LogEntry
  moduleIncludePatterns?: string[]
  moduleExcludePatterns?: string[]
  opts: GardenOpts
  plugins: RegisterPluginParam[]
  projectName: string
  projectRoot: string
  projectSources?: SourceConfig[]
  providerConfigs: ProviderConfig[]
  variables: PrimitiveMap
  vcs: VcsHandler
  workingCopyId: string
}

export class Garden {
  public readonly log: LogEntry
  private loadedPlugins: GardenPlugin[]
  private moduleConfigs: ModuleConfigMap
  private pluginModuleConfigs: ModuleConfig[]
  private resolvedProviders: Provider[]
  private modulesScanned: boolean
  private readonly registeredPlugins: { [key: string]: GardenPlugin }
  private readonly taskGraph: TaskGraph
  private watcher: Watcher
  private asyncLock: any

  public readonly configStore: ConfigStore
  public readonly globalConfigStore: GlobalConfigStore
  public readonly vcs: VcsHandler
  public readonly cache: TreeCache
  private actionHelper: ActionRouter
  public readonly events: EventBus

  public readonly projectRoot: string
  public readonly projectName: string
  public readonly environmentName: string
  public readonly variables: PrimitiveMap
  public readonly projectSources: SourceConfig[]
  public readonly buildDir: BuildDir
  public readonly gardenDirPath: string
  public readonly opts: GardenOpts
  private readonly providerConfigs: ProviderConfig[]
  public readonly workingCopyId: string
  public readonly dotIgnoreFiles: string[]
  public readonly moduleIncludePatterns?: string[]
  public readonly moduleExcludePatterns: string[]
  public readonly persistent: boolean

  constructor(params: GardenParams) {
    this.buildDir = params.buildDir
    this.environmentName = params.environmentName
    this.gardenDirPath = params.gardenDirPath
    this.log = params.log
    this.opts = params.opts
    this.projectName = params.projectName
    this.projectRoot = params.projectRoot
    this.projectSources = params.projectSources || []
    this.providerConfigs = params.providerConfigs
    this.variables = params.variables
    this.workingCopyId = params.workingCopyId
    this.dotIgnoreFiles = params.dotIgnoreFiles
    this.moduleIncludePatterns = params.moduleIncludePatterns
    this.moduleExcludePatterns = params.moduleExcludePatterns || []
    this.asyncLock = new AsyncLock()
    this.persistent = !!params.opts.persistent
    this.vcs = params.vcs

    // make sure we're on a supported platform
    const currentPlatform = platform()
    const currentArch = arch()

    if (!SUPPORTED_PLATFORMS.includes(<SupportedPlatform>currentPlatform)) {
      throw new RuntimeError(`Unsupported platform: ${currentPlatform}`, { platform: currentPlatform })
    }

    if (currentArch !== "x64") {
      throw new RuntimeError(`Unsupported CPU architecture: ${currentArch}`, { arch: currentArch })
    }

    this.modulesScanned = false
    // TODO: Support other VCS options.
    this.configStore = new LocalConfigStore(this.gardenDirPath)
    this.globalConfigStore = new GlobalConfigStore()
    this.cache = new TreeCache()

    this.moduleConfigs = {}
    this.pluginModuleConfigs = []
    this.registeredPlugins = {}

    this.taskGraph = new TaskGraph(this, this.log)
    this.events = new EventBus(this.log)

    // Register plugins
    for (const plugin of [...builtinPlugins, ...params.plugins]) {
      this.registerPlugin(plugin)
    }
  }

  static async factory<T extends typeof Garden>(
    this: T,
    currentDirectory: string,
    opts: GardenOpts = {}
  ): Promise<InstanceType<T>> {
    let { environmentName, config, gardenDirPath, plugins = [] } = opts

    if (!config) {
      config = await findProjectConfig(currentDirectory)

      if (!config) {
        throw new ConfigurationError(
          `Not a project directory (or any of the parent directories): ${currentDirectory}`,
          { currentDirectory }
        )
      }
    }

    config = await resolveProjectConfig(config)

    const { defaultEnvironment, name: projectName, sources: projectSources, path: projectRoot } = config

    if (!environmentName) {
      environmentName = defaultEnvironment
    }

    const { providers, variables } = await pickEnvironment(config, environmentName)

    gardenDirPath = resolve(projectRoot, gardenDirPath || DEFAULT_GARDEN_DIR_NAME)
    const buildDir = await BuildDir.factory(projectRoot, gardenDirPath)
    const workingCopyId = await getWorkingCopyId(gardenDirPath)
    const log = opts.log || getLogger().placeholder()

    // We always exclude the garden dir
    const gardenDirExcludePattern = `${relative(projectRoot, gardenDirPath)}/**/*`
    const moduleExcludePatterns = [...((config.modules || {}).exclude || []), gardenDirExcludePattern, ...fixedExcludes]

    // Ensure the project root is in a git repo
    const vcs = new GitHandler(gardenDirPath, config.dotIgnoreFiles)
    await vcs.getRepoRoot(log, projectRoot)

    const garden = new this({
      projectRoot,
      projectName,
      environmentName,
      variables,
      projectSources,
      buildDir,
      gardenDirPath,
      opts,
      plugins,
      providerConfigs: providers,
      moduleExcludePatterns,
      workingCopyId,
      dotIgnoreFiles: config.dotIgnoreFiles,
      moduleIncludePatterns: (config.modules || {}).include,
      log,
      vcs,
    }) as InstanceType<T>

    return garden
  }

  /**
   * Clean up before shutting down.
   */
  async close() {
    this.watcher && this.watcher.stop()
  }

  getPluginContext(provider: Provider) {
    return createPluginContext(this, provider, this.opts.commandInfo)
  }

  async clearBuilds() {
    return this.buildDir.clear()
  }

  async processTasks(tasks: BaseTask[], opts?: ProcessTasksOpts): Promise<TaskResults> {
    return this.taskGraph.process(tasks, opts)
  }

  /**
   * Enables the file watcher for the project.
   * Make sure to stop it using `.close()` when cleaning up or when watching is no longer needed.
   */
  async startWatcher(graph: ConfigGraph, bufferInterval?: number) {
    const modules = await graph.getModules()
    const linkedPaths = (await getLinkedSources(this)).map((s) => s.path)
    const paths = [this.projectRoot, ...linkedPaths]
    this.watcher = new Watcher(this, this.log, paths, modules, bufferInterval)
  }

  private registerPlugin(nameOrPlugin: RegisterPluginParam) {
    let plugin: GardenPlugin

    if (isString(nameOrPlugin)) {
      let moduleNameOrLocation = nameOrPlugin

      // allow relative references to project root
      if (parse(moduleNameOrLocation).dir !== "") {
        moduleNameOrLocation = resolve(this.projectRoot, moduleNameOrLocation)
      }

      let pluginModule: any

      try {
        pluginModule = require(moduleNameOrLocation)
      } catch (error) {
        throw new ConfigurationError(
          `Unable to load plugin "${moduleNameOrLocation}" (could not load module: ${error.message})`,
          {
            message: error.message,
            moduleNameOrLocation,
          }
        )
      }

      try {
        pluginModule = validate(pluginModule, pluginModuleSchema, {
          context: `plugin module "${moduleNameOrLocation}"`,
        })
      } catch (err) {
        throw new PluginError(`Unable to load plugin: ${err}`, {
          moduleNameOrLocation,
          err,
        })
      }

      plugin = pluginModule.gardenPlugin
    } else {
      plugin = nameOrPlugin
    }

    this.registeredPlugins[plugin.name] = plugin
  }

  async getPlugin(pluginName: string): Promise<GardenPlugin> {
    const plugins = await this.getPlugins()
    const plugin = findByName(plugins, pluginName)

    if (!plugin) {
      const availablePlugins = getNames(plugins)
      throw new PluginError(
        `Could not find plugin '${pluginName}'. Are you missing a provider configuration? ` +
          `Currently configured plugins: ${availablePlugins.join(", ")}`,
        {
          pluginName,
          availablePlugins,
        }
      )
    }

    return plugin
  }

  async getPlugins() {
    // The duplicated check is a small optimization to avoid the async lock when possible,
    // since this is called quite frequently.
    if (this.loadedPlugins) {
      return this.loadedPlugins
    }

    await this.asyncLock.acquire("load-plugins", async () => {
      // This check is necessary since we could in theory have two calls waiting for the lock at the same time.
      if (this.loadedPlugins) {
        return
      }

      this.log.silly(`Loading plugins`)
      const rawConfigs = this.getRawProviderConfigs()

      this.loadedPlugins = loadPlugins(this.log, this.registeredPlugins, rawConfigs)

      this.log.silly(`Loaded plugins: ${rawConfigs.map((c) => c.name).join(", ")}`)
    })

    return this.loadedPlugins
  }

  /**
   * Returns a mapping of all configured module types in the project and their definitions.
   */
  async getModuleTypeDefinitions() {
    const plugins = await this.getPlugins()
    const configNames = keyBy(this.getRawProviderConfigs(), "name")
    const configuredPlugins = plugins.filter((p) => configNames[p.name])
    return keyBy(flatten(configuredPlugins.map((p) => p.createModuleTypes || [])), "name")
  }

  getRawProviderConfigs() {
    return this.providerConfigs
  }

  async resolveProvider(name: string) {
    this.log.silly(`Resolving provider ${name}`)
    if (name === "_default") {
      return defaultProvider
    }

    const providers = await this.resolveProviders()
    const provider = findByName(providers, name)

    if (!provider) {
      throw new PluginError(`Could not find provider '${name}'`, {
        name,
        providers,
      })
    }

    return provider
  }

  async resolveProviders(forceInit = false): Promise<Provider[]> {
    await this.asyncLock.acquire("resolve-providers", async () => {
      if (this.resolvedProviders) {
        return
      }

      this.log.silly(`Resolving providers`)

      const log = this.log.info({
        section: "providers",
        msg: "Getting status...",
        status: "active",
      })

      const rawConfigs = this.getRawProviderConfigs()
      const plugins = keyBy(await this.getPlugins(), "name")

      // Detect circular deps here
      const pluginDeps: Dependency[] = []

      await Bluebird.map(rawConfigs, async (config) => {
        const plugin = plugins[config.name]

        for (const dep of await getAllProviderDependencyNames(plugin!, config!)) {
          pluginDeps.push({ from: config!.name, to: dep })
        }
      })

      const cycles = detectCycles(pluginDeps)

      if (cycles.length > 0) {
        const cyclesStr = cyclesToString(cycles)

        throw new PluginError(
          "One or more circular dependencies found between providers or their configurations: " + cyclesStr,
          { cycles }
        )
      }

      const tasks = rawConfigs.map((config) => {
        // TODO: actually resolve version, based on the VCS version of the plugin and its dependencies
        const version = {
          versionString: getPackageVersion(),
          dirtyTimestamp: null,
          commitHash: getPackageVersion(),
          dependencyVersions: {},
          files: [],
        }

        const plugin = plugins[config.name]

        return new ResolveProviderTask({
          garden: this,
          log,
          plugin,
          config,
          version,
          forceInit,
        })
      })

      // Process as many providers in parallel as possible
      const taskResults = await this.processTasks(tasks, {
        concurrencyLimit: tasks.length,
      })

      const failed = Object.values(taskResults).filter((r) => r && r.error)

      if (failed.length) {
        const messages = failed.map((r) => `- ${r!.name}: ${r!.error!.message}`)
        throw new PluginError(`Failed resolving one or more providers:\n${messages.join("\n")}`, {
          rawConfigs,
          taskResults,
          messages,
        })
      }

      const providers: Provider[] = Object.values(taskResults).map((result) => result!.output)

      await Bluebird.map(providers, async (provider) =>
        Bluebird.map(provider.moduleConfigs, async (moduleConfig) => {
          // Make sure module and all nested entities are scoped to the plugin
          moduleConfig.plugin = provider.name
          return this.addModule(moduleConfig)
        })
      )

      this.resolvedProviders = providers

      log.setSuccess({ msg: chalk.green("Done"), append: true })
      this.log.silly(`Resolved providers: ${providers.map((p) => p.name).join(", ")}`)
    })

    return this.resolvedProviders
  }

  /**
   * Returns the reported status from all configured providers.
   */
  async getEnvironmentStatus() {
    const providers = await this.resolveProviders()
    return fromPairs(providers.map((p) => [p.name, p.status]))
  }

  async getActionRouter() {
    if (!this.actionHelper) {
      const loadedPlugins = await this.getPlugins()
      const moduleTypes = await this.getModuleTypeDefinitions()
      const plugins = keyBy(loadedPlugins, "name")

      // We only pass configured plugins to the router (others won't have the required configuration to call handlers)
      const configuredPlugins = this.getRawProviderConfigs().map((c) => plugins[c.name])

      this.actionHelper = new ActionRouter(this, configuredPlugins, loadedPlugins, moduleTypes)
    }

    return this.actionHelper
  }

  /**
   * Returns module configs that are registered in this context, before template resolution and validation.
   * Scans for modules in the project root and remote/linked sources if it hasn't already been done.
   */
  async getRawModuleConfigs(keys?: string[]): Promise<ModuleConfig[]> {
    if (!this.modulesScanned) {
      await this.scanModules()
    }

    return Object.values(keys ? pickKeys(this.moduleConfigs, keys, "module") : this.moduleConfigs)
  }

  async getModuleConfigContext(runtimeContext?: RuntimeContext) {
    const providers = await this.resolveProviders()

    return new ModuleConfigContext(
      this,
      this.environmentName,
      providers,
      this.variables,
      Object.values(this.moduleConfigs),
      runtimeContext
    )
  }

  /**
   * Returns module configs that are registered in this context, fully resolved and configured (via their respective
   * plugin handlers).
   * Scans for modules in the project root and remote/linked sources if it hasn't already been done.
   */
  async resolveModuleConfigs(keys?: string[], opts: ModuleConfigResolveOpts = {}): Promise<ModuleConfig[]> {
    const actions = await this.getActionRouter()
    await this.resolveProviders()
    const configs = await this.getRawModuleConfigs(keys)

    keys ? this.log.silly(`Resolving module configs ${keys.join(", ")}`) : this.log.silly(`Resolving module configs`)

    if (!opts.configContext) {
      opts.configContext = await this.getModuleConfigContext()
    }

    const moduleTypeDefinitions = await this.getModuleTypeDefinitions()

    return Bluebird.map(configs, async (config) => {
      config = await resolveTemplateStrings(cloneDeep(config), opts.configContext!, opts)
      const description = moduleTypeDefinitions[config.type]

      if (!description) {
        const configPath = relative(this.projectRoot, config.configPath || config.path)

        throw new ConfigurationError(
          deline`
          Unrecognized module type '${config.type}' (defined at ${configPath}).
          Are you missing a provider configuration?
          `,
          { config, configuredModuleTypes: Object.keys(moduleTypeDefinitions) }
        )
      }

      // Validate the module-type specific spec
      if (description.schema) {
        config.spec = validateWithPath({
          config: config.spec,
          schema: description.schema,
          name: config.name,
          path: config.path,
          projectRoot: this.projectRoot,
        })
      }

      /*
        We allow specifying modules by name only as a shorthand:

        dependencies:
          - foo-module
          - name: foo-module // same as the above
      */
      if (config.build && config.build.dependencies) {
        config.build.dependencies = config.build.dependencies.map((dep) =>
          typeof dep === "string" ? { name: dep, copy: [] } : dep
        )
      }

      // Validate the base config schema
      config = validateWithPath({
        config,
        schema: moduleConfigSchema,
        configType: "module",
        name: config.name,
        path: config.path,
        projectRoot: this.projectRoot,
      })

      if (config.repositoryUrl) {
        config.path = await this.loadExtSourcePath({
          name: config.name,
          repositoryUrl: config.repositoryUrl,
          sourceType: "module",
        })
      }

      const configureResult = await actions.configureModule({
        moduleConfig: config,
        log: this.log,
      })

      config = configureResult.moduleConfig

      // Validate the module outputs against the outputs schema
      if (description.moduleOutputsSchema) {
        config.outputs = validateWithPath({
          config: config.outputs,
          schema: description.moduleOutputsSchema,
          configType: `outputs for module`,
          name: config.name,
          path: config.path,
          projectRoot: this.projectRoot,
          ErrorClass: PluginError,
        })
      }

      // Validate the configure handler output (incl. module outputs) against the module type's bases
      const bases = getModuleTypeBases(moduleTypeDefinitions[config.type], moduleTypeDefinitions)

      for (const base of bases) {
        if (base.schema) {
          this.log.silly(`Validating '${config.name}' config against '${base.name}' schema`)

          config.spec = <ModuleConfig>validateWithPath({
            config: config.spec,
            schema: base.schema.unknown(true),
            path: this.projectRoot,
            projectRoot: this.projectRoot,
            configType: `configuration for module '${config.name}' (base schema from '${base.name}' plugin)`,
            ErrorClass: ConfigurationError,
          })
        }

        if (base.moduleOutputsSchema) {
          this.log.silly(`Validating '${config.name}' module outputs against '${base.name}' schema`)

          config.outputs = validateWithPath({
            config: config.outputs,
            schema: base.moduleOutputsSchema.unknown(true),
            path: this.projectRoot,
            projectRoot: this.projectRoot,
            configType: `outputs for module '${config.name}' (base schema from '${base.name}' plugin)`,
            ErrorClass: PluginError,
          })
        }
      }

      // FIXME: We should be able to avoid this
      config.name = getModuleKey(config.name, config.plugin)

      if (config.plugin) {
        for (const serviceConfig of config.serviceConfigs) {
          serviceConfig.name = getModuleKey(serviceConfig.name, config.plugin)
        }
        for (const taskConfig of config.taskConfigs) {
          taskConfig.name = getModuleKey(taskConfig.name, config.plugin)
        }
        for (const testConfig of config.testConfigs) {
          testConfig.name = getModuleKey(testConfig.name, config.plugin)
        }
      }

      return config
    })
  }

  /**
   * Returns the module with the specified name. Throws error if it doesn't exist.
   */
  async resolveModuleConfig(name: string, opts: ModuleConfigResolveOpts = {}): Promise<ModuleConfig> {
    return (await this.resolveModuleConfigs([name], opts))[0]
  }

  /**
   * Resolve the raw module configs and return a new instance of ConfigGraph.
   * The graph instance is immutable and represents the configuration at the point of calling this method.
   * For long-running processes, you need to call this again when any module or configuration has been updated.
   */
  async getConfigGraph(opts: ModuleConfigResolveOpts = {}) {
    const modules = await this.resolveModuleConfigs(undefined, opts)
    return new ConfigGraph(this, modules)
  }

  /**
   * Given a module, and a list of dependencies, resolve the version for that combination of modules.
   * The combined version is a either the latest dirty module version (if any), or the hash of the module version
   * and the versions of its dependencies (in sorted order).
   */
  async resolveVersion(moduleName: string, moduleDependencies: (Module | BuildDependencyConfig)[], force = false) {
    this.log.silly(`Resolving version for module ${moduleName}`)

    const depModuleNames = moduleDependencies.map((m) => m.name)
    depModuleNames.sort()
    const cacheKey = ["moduleVersions", moduleName, ...depModuleNames]

    if (!force) {
      const cached = <ModuleVersion>this.cache.get(cacheKey)

      if (cached) {
        return cached
      }
    }

    const config = await this.resolveModuleConfig(moduleName)
    const dependencyKeys = moduleDependencies.map((dep) => getModuleKey(dep.name, dep.plugin))
    const dependencies = await this.getRawModuleConfigs(dependencyKeys)
    const cacheContexts = dependencies.concat([config]).map((c) => getModuleCacheContext(c))

    const version = await this.vcs.resolveVersion(this.log, config, dependencies)

    this.cache.set(cacheKey, version, ...cacheContexts)
    return version
  }

  /**
   * Scans the specified directories for Garden config files and returns a list of paths.
   */
  async scanForConfigs(path: string) {
    this.log.silly(`Scanning for configs in ${path}`)

    return findConfigPathsInPath({
      vcs: this.vcs,
      dir: path,
      include: this.moduleIncludePatterns,
      exclude: this.moduleExcludePatterns,
      log: this.log,
    })
  }

  /*
    Scans the project root for modules and adds them to the context.
   */
  async scanModules(force = false) {
    return this.asyncLock.acquire("scan-modules", async () => {
      if (this.modulesScanned && !force) {
        return
      }

      this.log.silly(`Scanning for modules`)

      let extSourcePaths: string[] = []

      // Add external sources that are defined at the project level. External sources are either kept in
      // the .garden/sources dir (and cloned there if needed), or they're linked to a local path via the link command.
      for (const { name, repositoryUrl } of this.projectSources) {
        const path = await this.loadExtSourcePath({
          name,
          repositoryUrl,
          sourceType: "project",
        })
        extSourcePaths.push(path)
      }

      const dirsToScan = [this.projectRoot, ...extSourcePaths]
      const modulePaths = flatten(await Bluebird.map(dirsToScan, (path) => this.scanForConfigs(path)))

      const rawConfigs: ModuleConfig[] = [...this.pluginModuleConfigs]

      await Bluebird.map(modulePaths, async (path) => {
        const configs = await this.loadModuleConfigs(dirname(path))
        if (configs) {
          rawConfigs.push(...configs)
        }
      })

      await Bluebird.map(rawConfigs, async (config) => this.addModule(config))

      this.log.silly(`Scanned and found ${rawConfigs.length} modules`)

      this.modulesScanned = true
    })
  }

  /**
   * Returns true if a module has been configured in this project with the specified name.
   */
  hasModule(name: string) {
    return !!this.moduleConfigs[name]
  }

  /**
   * Add a module config to the context, after validating and calling the appropriate configure plugin handler.
   * Template strings should be resolved on the config before calling this.
   */
  private async addModule(config: ModuleConfig) {
    const key = getModuleKey(config.name, config.plugin)
    this.log.silly(`Adding module ${key}`)

    if (this.moduleConfigs[key]) {
      const paths = [this.moduleConfigs[key].path, config.path]
      const [pathA, pathB] = (await Bluebird.map(paths, async (path) =>
        relative(this.projectRoot, await getConfigFilePath(path))
      )).sort()

      throw new ConfigurationError(`Module ${key} is declared multiple times (in '${pathA}' and '${pathB}')`, {
        pathA,
        pathB,
      })
    }

    this.moduleConfigs[key] = config
  }

  /**
   * Load a module from the specified directory and return the config, or null if no module is found.
   *
   * @param path Directory containing the module
   */
  private async loadModuleConfigs(path: string): Promise<ModuleConfig[]> {
    path = resolve(this.projectRoot, path)
    this.log.silly(`Load module configs from ${path}`)
    const resources = await loadConfig(this.projectRoot, path)
    this.log.silly(`Loaded module configs from ${path}`)
    return <ModuleResource[]>resources.filter((r) => r.kind === "Module")
  }

  //===========================================================================
  //region Internal helpers
  //===========================================================================

  /**
   * Clones the project/module source if needed and returns the path (either from .garden/sources or from a local path)
   */
  public async loadExtSourcePath({
    name,
    repositoryUrl,
    sourceType,
  }: {
    name: string
    repositoryUrl: string
    sourceType: ExternalSourceType
  }): Promise<string> {
    const linkedSources = await getLinkedSources(this, sourceType)

    const linked = findByName(linkedSources, name)

    if (linked) {
      return linked.path
    }

    const path = await this.vcs.ensureRemoteSource({
      name,
      sourceType,
      url: repositoryUrl,
      log: this.log,
    })

    return path
  }

  /**
   * This dumps the full project configuration including all modules.
   */
  public async dumpConfig(): Promise<ConfigDump> {
    return {
      environmentName: this.environmentName,
      providers: await this.resolveProviders(),
      variables: this.variables,
      moduleConfigs: sortBy(await this.resolveModuleConfigs(), "name"),
      projectRoot: this.projectRoot,
    }
  }

  //endregion
}

export interface ConfigDump {
  environmentName: string
  providers: Provider[]
  variables: PrimitiveMap
  moduleConfigs: ModuleConfig[]
  projectRoot: string
}
