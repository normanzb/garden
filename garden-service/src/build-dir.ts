/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { map as bluebirdMap } from "bluebird"
import normalize = require("normalize-path")
import {
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
  relative,
} from "path"
import { emptyDir, ensureDir } from "fs-extra"
import { ConfigurationError } from "./exceptions"
import { FileCopySpec, Module, getModuleKey } from "./types/module"
import { normalizeLocalRsyncPath } from "./util/fs"
import { LogEntry } from "./logger/log-entry"
import { ModuleConfig } from "./config/module"
import { ConfigGraph } from "./config-graph"
import { exec } from "./util/util"

// FIXME: We don't want to keep special casing this module type so we need to think
// of a better way around this.
function isLocalExecModule(moduleConfig: ModuleConfig) {
  return moduleConfig.type === "exec" && moduleConfig.spec.local
}

// Lazily construct a directory of modules inside which all build steps are performed.

export class BuildDir {
  constructor(private projectRoot: string, public buildDirPath: string, public buildMetadataDirPath: string) { }

  static async factory(projectRoot: string, gardenDirPath: string) {
    const buildDirPath = join(gardenDirPath, "build")
    const buildMetadataDirPath = join(gardenDirPath, "build-metadata")
    await ensureDir(buildDirPath)
    await ensureDir(buildMetadataDirPath)
    return new BuildDir(projectRoot, buildDirPath, buildMetadataDirPath)
  }

  async syncFromSrc(module: Module, log: LogEntry) {
    // We don't sync local exec modules to the build dir
    if (isLocalExecModule(module)) {
      log.silly("Skipping syncing from source for local exec module")
      return
    }

    const files = module.version.files
      // Normalize to relative POSIX-style paths
      .map(f => normalize(isAbsolute(f) ? relative(module.path, f) : f))

    await this.sync({
      module,
      sourcePath: resolve(this.projectRoot, module.path) + sep,
      destinationPath: module.buildPath,
      withDelete: true,
      log,
      files,
    })
  }

  async syncDependencyProducts(module: Module, graph: ConfigGraph, log: LogEntry) {
    const buildPath = await this.buildPath(module)
    const buildDependencies = module.build.dependencies

    await bluebirdMap(buildDependencies, async (buildDepConfig) => {
      if (!buildDepConfig || !buildDepConfig.copy) {
        return
      }

      const sourceModule = await graph.getModule(getModuleKey(buildDepConfig.name, buildDepConfig.plugin))
      const sourceBuildPath = await this.buildPath(sourceModule)

      // Sync to the module's top-level dir by default.
      await bluebirdMap(buildDepConfig.copy, (copy: FileCopySpec) => {
        if (isAbsolute(copy.source)) {
          throw new ConfigurationError(`Source path in build dependency copy spec must be a relative path`, {
            copySpec: copy,
          })
        }

        if (isAbsolute(copy.target)) {
          throw new ConfigurationError(`Target path in build dependency copy spec must be a relative path`, {
            copySpec: copy,
          })
        }

        const sourcePath = join(sourceBuildPath, copy.source)
        const destinationPath = join(buildPath, copy.target)
        return this.sync({ module, sourcePath, destinationPath, withDelete: false, log })
      })
    })
  }

  async clear() {
    await emptyDir(this.buildDirPath)
  }

  async buildPath(moduleOrConfig: Module | ModuleConfig): Promise<string> {
    // We don't stage the build for local exec modules, so the module path is effectively the build path.
    if (isLocalExecModule(moduleOrConfig)) {
      return moduleOrConfig.path
    }

    // This returns the same result for modules and module configs
    const moduleKey = getModuleKey(moduleOrConfig.name, moduleOrConfig.plugin)

    const path = resolve(this.buildDirPath, moduleKey)
    await ensureDir(path)

    return path
  }

  /**
   * This directory can be used to store build-related metadata for a given module, for example the last built
   * version for exec modules.
   */
  async buildMetadataPath(moduleName: string): Promise<string> {
    const path = resolve(this.buildMetadataDirPath, moduleName)
    await ensureDir(path)
    return path
  }

  /**
   * Syncs sourcePath with destinationPath using rsync.
   *
   * If withDelete = true, files/folders in destinationPath that are not in sourcePath will also be deleted.
   */
  private async sync(
    { module, sourcePath, destinationPath, withDelete, log, files }:
      {
        module: Module,
        sourcePath: string,
        destinationPath: string,
        withDelete: boolean,
        log: LogEntry,
        files?: string[],
      },
  ): Promise<void> {
    const destinationDir = parse(destinationPath).dir
    await ensureDir(destinationDir)

    // this is so that the cygwin-based rsync client can deal with the paths
    sourcePath = normalizeLocalRsyncPath(sourcePath)
    destinationPath = normalizeLocalRsyncPath(destinationPath)

    // the correct way to copy all contents of a folder is using a trailing slash and not a wildcard
    sourcePath = stripWildcard(sourcePath)
    destinationPath = stripWildcard(destinationPath)

    // --exclude is required for modules where the module and project are in the same directory
    const syncOpts = ["-rptgo", `--exclude=${this.buildDirPath}`]

    if (withDelete) {
      syncOpts.push("--delete")
    }

    let logMsg = `Syncing ${module.version.files.length} files from ` +
      `${relative(this.projectRoot, sourcePath)} to ${relative(this.projectRoot, destinationPath)}`

    if (withDelete) {
      logMsg += " (with delete)"
    }

    log.debug(logMsg)

    let input: string | undefined

    if (files !== undefined) {
      syncOpts.push("--files-from=-")
      files = files.sort()
      input = files.join("\n")
      log.silly(`File list: ${JSON.stringify(files)}`)
    }

    await exec("rsync", [...syncOpts, sourcePath, destinationPath], { input })
  }
}

function stripWildcard(path: string) {
  return path.endsWith("/*") ? path.slice(0, -1) : path
}
