/*
 * Copyright (C) 2018 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as Joi from "joi"
import { mapValues } from "lodash"
import { join } from "path"
import {
  joiArray,
  joiEnvVars,
  PrimitiveMap,
  validate,
} from "../types/common"
import {
  GardenPlugin,
} from "../types/plugin/plugin"
import {
  Module,
  ModuleConfig,
  ModuleSpec,
} from "../types/module"
import {
  BuildResult,
  BuildStatus,
  ParseModuleResult,
  TestResult,
} from "../types/plugin/outputs"
import {
  BuildModuleParams,
  GetModuleBuildStatusParams,
  ParseModuleParams,
  TestModuleParams,
} from "../types/plugin/params"
import { BaseServiceSpec } from "../types/service"
import {
  BaseTestSpec,
  baseTestSpecSchema,
} from "../types/test"
import { spawn } from "../util/util"
import { readModuleVersionFile, writeModuleVersionFile, ModuleVersion } from "../vcs/base"
import { GARDEN_BUILD_VERSION_FILENAME } from "../constants"
import execa = require("execa")

export const name = "generic"

export interface GenericTestSpec extends BaseTestSpec {
  command: string[],
  env: PrimitiveMap,
}

export const genericTestSchema = baseTestSpecSchema
  .keys({
    command: Joi.array().items(Joi.string())
      .description("The command to run in the module build context in order to test it."),
    env: joiEnvVars(),
  })
  .description("The test specification of a generic module.")

export interface GenericModuleSpec extends ModuleSpec {
  env: PrimitiveMap,
  tests: GenericTestSpec[],
}

export const genericModuleSpecSchema = Joi.object()
  .keys({
    env: joiEnvVars(),
    tests: joiArray(genericTestSchema)
      .description("A list of tests to run in the module."),
  })
  .unknown(false)
  .description("The module specification for a generic module.")

export class GenericModule extends Module<GenericModuleSpec, BaseServiceSpec, GenericTestSpec> { }

export async function parseGenericModule(
  { moduleConfig }: ParseModuleParams<GenericModule>,
): Promise<ParseModuleResult> {
  moduleConfig.spec = validate(moduleConfig.spec, genericModuleSpecSchema, { context: `module ${moduleConfig.name}` })

  return {
    module: moduleConfig,
    services: [],
    tests: moduleConfig.spec.tests.map(t => ({
      name: t.name,
      dependencies: t.dependencies,
      spec: t,
      timeout: t.timeout,
    })),
  }
}

export async function getGenericModuleBuildStatus({ module }: GetModuleBuildStatusParams): Promise<BuildStatus> {
  const moduleVersion = await module.getVersion()
  const buildVersionFilePath = join(await module.getBuildPath(), GARDEN_BUILD_VERSION_FILENAME)
  let builtVersion: ModuleVersion | null = null

  try {
    builtVersion = await readModuleVersionFile(buildVersionFilePath)
  } catch (_) {
    // just ignore this error, can be caused by an outdated format
  }

  if (builtVersion && builtVersion.versionString === moduleVersion.versionString) {
    return { ready: true }
  }

  return { ready: false }
}

export async function buildGenericModule({ module }: BuildModuleParams<GenericModule>): Promise<BuildResult> {
  const config: ModuleConfig = module.config
  const output: BuildResult = {}
  const buildPath = await module.getBuildPath()

  if (config.build.command.length) {
    const result = await execa.shell(
      config.build.command.join(" "),
      {
        cwd: buildPath,
        env: { ...process.env, ...mapValues(module.spec.env, v => v.toString()) },
      },
    )

    output.fresh = true
    output.buildLog = result.stdout
  }

  // keep track of which version has been built
  const buildVersionFilePath = join(buildPath, GARDEN_BUILD_VERSION_FILENAME)
  const version = await module.getVersion()
  await writeModuleVersionFile(buildVersionFilePath, version)

  return output
}

export async function testGenericModule({ module, testConfig }: TestModuleParams<GenericModule>): Promise<TestResult> {
  const startedAt = new Date()
  const command = testConfig.spec.command

  const result = await spawn(
    command[0],
    command.slice(1),
    {
      cwd: module.path,
      env: {
        ...process.env,
        // need to cast the values to strings
        ...mapValues(module.spec.env, v => v + ""),
        ...mapValues(testConfig.spec.env, v => v + ""),
      },
      ignoreError: true,
    },
  )

  return {
    moduleName: module.name,
    command,
    testName: testConfig.name,
    version: await module.getVersion(),
    success: result.code === 0,
    startedAt,
    completedAt: new Date(),
    output: result.output,
  }
}

export const genericPlugin: GardenPlugin = {
  moduleActions: {
    generic: {
      parseModule: parseGenericModule,
      getModuleBuildStatus: getGenericModuleBuildStatus,
      buildModule: buildGenericModule,
      testModule: testGenericModule,
    },
  },
}

export const gardenPlugin = () => genericPlugin
