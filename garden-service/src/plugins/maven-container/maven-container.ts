/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { omit, get } from "lodash"
import { copy, pathExists, readFile } from "fs-extra"
import { createGardenPlugin } from "../../types/plugin/plugin"
import {
  ContainerModuleSpec,
  ContainerServiceSpec,
  ContainerTestSpec,
  ContainerModuleConfig,
  ContainerTaskSpec,
} from "../container/config"
import { joiArray, joiProviderName, joi } from "../../config/common"
import { Module } from "../../types/module"
import { resolve } from "path"
import { RuntimeError, ConfigurationError } from "../../exceptions"
import { containerHelpers } from "../container/helpers"
import { STATIC_DIR } from "../../constants"
import { xml2json } from "xml-js"
import { containerModuleSpecSchema } from "../container/config"
import { providerConfigBaseSchema } from "../../config/provider"
import { openJdks } from "./openjdk"
import { maven } from "./maven"
import { LogEntry } from "../../logger/log-entry"
import { dedent } from "../../util/string"
import { ModuleConfig } from "../../config/module"
import AsyncLock = require("async-lock")
import { ConfigureModuleParams } from "../../types/plugin/module/configure"
import { GetBuildStatusParams } from "../../types/plugin/module/getBuildStatus"
import { BuildModuleParams } from "../../types/plugin/module/build"

const defaultDockerfileName = "maven-container.Dockerfile"
const defaultDockerfilePath = resolve(STATIC_DIR, "maven-container", defaultDockerfileName)

const buildLock = new AsyncLock()

export interface MavenContainerModuleSpec extends ContainerModuleSpec {
  imageVersion?: string
  jarPath: string
  jdkVersion: number
  mvnOpts: string[]
}

export type MavenContainerModuleConfig = ModuleConfig<MavenContainerModuleSpec>

export interface MavenContainerModule<
  M extends MavenContainerModuleSpec = MavenContainerModuleSpec,
  S extends ContainerServiceSpec = ContainerServiceSpec,
  T extends ContainerTestSpec = ContainerTestSpec,
  W extends ContainerTaskSpec = ContainerTaskSpec
> extends Module<M, S, T, W> {}

const mavenKeys = {
  imageVersion: joi
    .string()
    .description(
      dedent`
      Set this to override the default OpenJDK container image version. Make sure the image version matches the
      configured \`jdkVersion\`. Ignored if you provide your own Dockerfile.
    `
    )
    .example("11-jdk"),
  jarPath: joi
    .string()
    .required()
    .posixPath({ subPathOnly: true })
    .description("POSIX-style path to the packaged JAR artifact, relative to the module directory.")
    .example("target/my-module.jar"),
  jdkVersion: joi
    .number()
    .integer()
    .allow(...Object.keys(openJdks))
    .default(8)
    .description("The JDK version to use."),
  mvnOpts: joiArray(joi.string()).description("Options to add to the `mvn package` command when building."),
}

const mavenContainerModuleSpecSchema = containerModuleSpecSchema.keys(mavenKeys)
export const mavenContainerConfigSchema = providerConfigBaseSchema.keys({
  name: joiProviderName("maven-container"),
})

export const gardenPlugin = createGardenPlugin({
  name: "maven-container",
  dependencies: ["container"],

  createModuleTypes: [
    {
      name: "maven-container",
      base: "container",
      docs: dedent`
      A specialized version of the [container](https://docs.garden.io/reference/module-types/container) module type
      that has special semantics for JAR files built with Maven.

      Rather than build the JAR inside the container (or in a multi-stage build) this plugin runs \`mvn package\`
      ahead of building the container, which tends to be much more performant, especially when building locally
      with a warm artifact cache.

      A default Dockerfile is also provided for convenience, but you may override it by including one in the module
      directory.

      To use it, make sure to add the \`maven-container\` provider to your project configuration.
      The provider will automatically fetch and cache Maven and the appropriate OpenJDK version ahead of building.
    `,
      schema: mavenContainerModuleSpecSchema,
      handlers: {
        configure: configureMavenContainerModule,
        getBuildStatus,
        build,
      },
    },
  ],
})

export async function configureMavenContainerModule(params: ConfigureModuleParams<MavenContainerModule>) {
  const { base, moduleConfig } = params

  let containerConfig: ContainerModuleConfig = { ...moduleConfig, type: "container" }
  containerConfig.spec = <ContainerModuleSpec>omit(moduleConfig.spec, Object.keys(mavenKeys))

  const jdkVersion = moduleConfig.spec.jdkVersion!

  containerConfig.spec.buildArgs = {
    IMAGE_VERSION: moduleConfig.spec.imageVersion || `${jdkVersion}-jdk`,
  }

  const configured = await base!({ ...params, moduleConfig: containerConfig })

  return {
    moduleConfig: {
      ...configured.moduleConfig,
      type: "maven-container",
      spec: {
        ...configured.moduleConfig.spec,
        jarPath: moduleConfig.spec.jarPath,
        jdkVersion,
        mvnOpts: moduleConfig.spec.mvnOpts,
        dockerfile: moduleConfig.spec.dockerfile || defaultDockerfileName,
      },
    },
  }
}

async function getBuildStatus(params: GetBuildStatusParams<MavenContainerModule>) {
  const { base, module, log } = params

  await prepareBuild(module, log)

  return base!(params)
}

async function build(params: BuildModuleParams<MavenContainerModule>) {
  // Run the maven build
  const { base, module, log } = params
  let { jarPath, jdkVersion, mvnOpts } = module.spec

  const pom = await loadPom(module.path)
  const artifactId = get(pom, ["project", "artifactId", "_text"])

  if (!artifactId) {
    throw new ConfigurationError(`Could not read artifact ID from pom.xml in ${module.path}`, { path: module.path })
  }

  log.setState(`Creating jar artifact...`)

  const openJdk = openJdks[jdkVersion]
  const openJdkPath = await openJdk.getPath(log)

  const mvnArgs = ["package", "--batch-mode", "--projects", ":" + artifactId, "--also-make", ...mvnOpts]
  const mvnCmdStr = "mvn " + mvnArgs.join(" ")

  // Maven has issues when running concurrent processes, so we're working around that with a lock.
  // TODO: http://takari.io/book/30-team-maven.html would be a more robust solution.
  await buildLock.acquire("mvn", async () => {
    await maven.exec({
      args: mvnArgs,
      cwd: module.path,
      log,
      env: {
        JAVA_HOME: openJdkPath,
      },
    })
  })

  // Copy the artifact to the module build directory
  const resolvedJarPath = resolve(module.path, jarPath)

  if (!(await pathExists(resolvedJarPath))) {
    throw new RuntimeError(`Could not find artifact at ${resolvedJarPath} after running '${mvnCmdStr}'`, {
      jarPath,
      mvnArgs,
    })
  }

  await copy(resolvedJarPath, resolve(module.buildPath, "app.jar"))

  // Build the container
  await prepareBuild(module, log)
  return base!(params)
}

async function prepareBuild(module: MavenContainerModule, log: LogEntry) {
  // Copy the default Dockerfile to the build directory, if the module doesn't provide one
  // Note: Doing this here so that the build status check works as expected.
  if (module.spec.dockerfile === defaultDockerfileName || !(await containerHelpers.hasDockerfile(module))) {
    log.debug(`Using default Dockerfile`)
    await copy(defaultDockerfilePath, resolve(module.buildPath, defaultDockerfileName))
  }
}

async function loadPom(dir: string) {
  try {
    const pomPath = resolve(dir, "pom.xml")
    const pomData = await readFile(pomPath)
    return JSON.parse(xml2json(pomData.toString(), { compact: true }))
  } catch (err) {
    throw new ConfigurationError(`Could not load pom.xml from directory ${dir}`, { dir })
  }
}
